import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SettingsSetValue, SettingsState } from '@shared/ipc'

/**
 * The settings app's one piece of client state: the daemon-shaped snapshot of
 * `config.toml`, pushed right after a save made here and whenever the file
 * changes on disk — whichever of the three writers (this app, the CLI, an
 * editor) changed it. Screens read, call `setConfig`, and the round trip
 * through the file is what redraws them; `useOptimistic` only bridges the gap
 * until that push lands, there is no client-side draft to get out of sync.
 */

interface SettingsStore {
  readonly state: SettingsState | null
  readonly refresh: () => Promise<void>
  /** The last save that failed, as a sentence — dismissed by `clearSaveError`. */
  readonly saveError: string | null
  readonly clearSaveError: () => void
  /** When this session's last write landed, as `Date.now()`; null until one has. */
  readonly lastSavedAt: number | null
}

const SettingsContext = createContext<SettingsStore>({
  state: null,
  refresh: async () => {},
  saveError: null,
  clearSaveError: () => {},
  lastSavedAt: null
})

/**
 * The row around a control listens here, and `useOptimistic` calls it once
 * the truth confirms a value the control asked for. Controls outside a row get
 * the no-op.
 */
export const RowSavedContext = createContext<() => void>(() => {})

// The provider registers itself here so `guarded` — called from plain event
// handlers all over the screens — can surface a failed write without every
// call site wiring its own error state. One window, one provider, so a plain
// module slot is enough.
let notifySaveError: (message: string) => void = () => {}
let notifySaved: () => void = () => {}

export function SettingsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<SettingsState | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    setState(await window.lumanin.invoke('settings.state'))
  }, [])

  useEffect(() => {
    notifySaveError = setSaveError
    notifySaved = () => setLastSavedAt(Date.now())
    void refresh()
    const off = window.lumanin.on('settings.changed', setState) as () => void
    return () => {
      notifySaveError = () => {}
      notifySaved = () => {}
      off()
    }
  }, [refresh])

  const clearSaveError = useCallback(() => setSaveError(null), [])

  return (
    <SettingsContext.Provider value={{ state, refresh, saveError, clearSaveError, lastSavedAt }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettingsState(): SettingsStore {
  return useContext(SettingsContext)
}

/**
 * Show a value the moment it is chosen, while the file stays the truth. The
 * pending value clears once `value` catches up with it, when `work` rejects
 * (the control snaps back), or a second after `work` resolves without the
 * truth ever matching (the file normalised it differently).
 */
export function useOptimistic<T>(
  value: T,
  equal: (a: T, b: T) => boolean = Object.is
): [shown: T, commit: (next: T, work: Promise<unknown>) => void] {
  const [pending, setPending] = useState<{ readonly value: T } | null>(null)
  const onSaved = useContext(RowSavedContext)
  const confirmed = useRef(false)
  const latest = useRef(value)
  latest.current = value
  if (pending !== null && equal(pending.value, value)) {
    setPending(null)
    confirmed.current = true
  }
  useEffect(() => {
    if (!confirmed.current) return
    confirmed.current = false
    onSaved()
  })

  const commit = useCallback(
    (next: T, work: Promise<unknown>) => {
      // Nothing to show optimistically and nothing to confirm when the value did not change.
      if (equal(next, latest.current)) return
      const entry = { value: next }
      setPending(entry)
      const clear = (): void => setPending((current) => (current === entry ? null : current))
      work.then(
        () => setTimeout(clear, 1000),
        () => clear()
      )
    },
    [equal]
  )

  return [pending === null ? value : pending.value, commit]
}

/** Comparator for `useOptimistic` over an ordered list of primitives. */
export function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/** Write one setting; a successful write pushes the redraw. Throws with a sentence. */
export async function setConfig(path: readonly string[], value: SettingsSetValue): Promise<void> {
  const result = await window.lumanin.invoke('settings.set', { path, value })
  if (!result.ok) throw new Error(result.detail ?? 'the setting could not be saved')
  notifySaved()
}

/**
 * Fire-and-forget a write without losing its failure. `void somePromise` is
 * how a refused save used to become an unhandled rejection and a change that
 * silently evaporated on the next state push — this reports it instead.
 */
export function guarded(work: Promise<unknown>): void {
  work.catch((cause: unknown) => {
    notifySaveError(cause instanceof Error ? cause.message : String(cause))
  })
}

/** Invoke a `{ ok, detail }` method and turn a refusal into a throw. */
export async function invokeChecked(
  invoke: () => Promise<{ ok: boolean; detail?: string }>,
  fallback: string
): Promise<void> {
  const result = await invoke()
  if (!result.ok) throw new Error(result.detail ?? fallback)
  notifySaved()
}
