import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { SettingsSetValue, SettingsState } from '@shared/ipc'

/**
 * The settings app's one piece of client state: the daemon-shaped snapshot of
 * `config.toml`, refreshed whenever the file changes on disk — whichever of
 * the three writers (this app, the CLI, an editor) changed it. Screens read,
 * call `setConfig`, and the round trip through the file is what redraws them:
 * there is no client-side draft to get out of sync.
 */

interface SettingsStore {
  readonly state: SettingsState | null
  readonly refresh: () => Promise<void>
  /** The last save that failed, as a sentence — dismissed by `clearSaveError`. */
  readonly saveError: string | null
  readonly clearSaveError: () => void
}

const SettingsContext = createContext<SettingsStore>({
  state: null,
  refresh: async () => {},
  saveError: null,
  clearSaveError: () => {}
})

// The provider registers itself here so `guarded` — called from plain event
// handlers all over the screens — can surface a failed write without every
// call site wiring its own error state. One window, one provider, so a plain
// module slot is enough.
let notifySaveError: (message: string) => void = () => {}

export function SettingsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<SettingsState | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setState(await window.lumanin.invoke('settings.state'))
  }, [])

  useEffect(() => {
    notifySaveError = setSaveError
    void refresh()
    const off = window.lumanin.on('settings.changed', setState) as () => void
    return () => {
      notifySaveError = () => {}
      off()
    }
  }, [refresh])

  const clearSaveError = useCallback(() => setSaveError(null), [])

  return (
    <SettingsContext.Provider value={{ state, refresh, saveError, clearSaveError }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettingsState(): SettingsStore {
  return useContext(SettingsContext)
}

/** Write one setting; the file watch pushes the redraw. Throws with a sentence. */
export async function setConfig(path: readonly string[], value: SettingsSetValue): Promise<void> {
  const result = await window.lumanin.invoke('settings.set', { path, value })
  if (!result.ok) throw new Error(result.detail ?? 'the setting could not be saved')
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
}
