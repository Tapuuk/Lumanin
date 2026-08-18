import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ENV_PREFIX } from '@shared/identity'
import { formatHotkey, KEY_ALIASES, MODIFIERS, parseHotkey, type Hotkey, type Modifier } from '@shared/hotkey'
import type { Setting } from '@shared/settings-model'
import { setConfig, useOptimistic, useSettingsState } from './useSettings'

/**
 * The generic building blocks every screen is made of. Each control saves on
 * change, shows the chosen value at once, and lets the config round trip
 * confirm it — the same instant-apply the daemon's file watch already gives
 * every other writer of `config.toml`.
 */

export function Section({ title, children }: { title?: string; children: ReactNode }): React.JSX.Element {
  return (
    <section className="s-section">
      {title !== undefined && <h2 className="s-section__title">{title}</h2>}
      {children}
    </section>
  )
}

export function Row({
  label,
  help,
  children
}: {
  label: string
  help?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="s-row">
      <div className="s-row__text">
        <div className="s-row__label">{label}</div>
        {help !== undefined && <div className="s-row__help">{help}</div>}
      </div>
      <div className="s-row__control">{children}</div>
    </div>
  )
}

export function Toggle({
  checked: truth,
  disabled,
  ariaLabel,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  ariaLabel?: string
  onChange: (next: boolean) => void | Promise<unknown>
}): React.JSX.Element {
  const [checked, commit] = useOptimistic(truth)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`s-toggle${checked ? ' s-toggle--on' : ''}`}
      disabled={disabled === true}
      onClick={() => {
        const next = !checked
        commit(next, Promise.resolve(onChange(next)))
      }}
    >
      <span className="s-toggle__knob" />
    </button>
  )
}

/** One model-driven setting, whatever its editor kind. */
export function SettingControl({ setting }: { setting: Setting }): React.JSX.Element | null {
  const { state } = useSettingsState()
  const [error, setError] = useState<string | null>(null)
  if (state === null) return null

  const read = setting.read(state.resolved)
  const overridden = read.layer === 'env' || read.layer === 'flag'
  const save = (value: string | number | boolean | null): Promise<void> => {
    setError(null)
    const work = setConfig(setting.path, value)
    work.catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
    return work
  }

  const help = overridden
    ? `Set by ${ENV_PREFIX}${setting.envKey ?? ''}. Editing the file cannot change it.`
    : setting.help

  return (
    <Row label={setting.label} help={help}>
      {editorFor(setting, read.value, overridden, save)}
      {error !== null && <div className="s-error">{error}</div>}
    </Row>
  )
}

function editorFor(
  setting: Setting,
  value: unknown,
  disabled: boolean,
  save: (value: string | number | boolean | null) => Promise<void>
): ReactNode {
  const editor = setting.editor
  switch (editor.kind) {
    case 'boolean':
      return <Toggle checked={value === true} disabled={disabled} onChange={(next) => save(next)} />
    case 'enum':
      return (
        <EnumControl
          options={editor.options}
          freeform={setting.freeform === true}
          value={value === null || value === undefined ? '' : String(value)}
          disabled={disabled}
          onSave={(next) => save(next === '' ? null : next)}
        />
      )
    case 'number':
      return (
        <NumberControl
          value={typeof value === 'number' ? value : null}
          min={editor.min}
          max={editor.max}
          integer={editor.integer}
          presets={editor.presets ?? []}
          disabled={disabled}
          onSave={save}
        />
      )
    case 'text':
      return (
        <TextControl
          value={typeof value === 'string' ? value : ''}
          placeholder={editor.placeholder}
          disabled={disabled}
          onSave={(next) => save(next.trim().length === 0 ? null : next.trim())}
        />
      )
    case 'hotkey':
      // Hotkeys have their own flow (capture, then the compositor write) —
      // the screens place a `HotkeyEditor` themselves.
      return null
  }
}

// Sentinel option values for the custom/default select rows. The NUL escape
// keeps them impossible to collide with a real theme name or number, while
// staying visible in source (a literal NUL byte makes the file read as binary).
const CUSTOM = '\u0000custom'
const DEFAULT = '\u0000default'

function EnumControl({
  options,
  freeform,
  value: truth,
  disabled,
  onSave
}: {
  options: readonly { value: string; label: string }[]
  freeform: boolean
  value: string
  disabled: boolean
  onSave: (next: string) => void | Promise<unknown>
}): React.JSX.Element {
  const [value, commit] = useOptimistic(truth)
  const save = (next: string): void => commit(next, Promise.resolve(onSave(next)))
  const listed = options.some((option) => option.value === value)
  const [custom, setCustom] = useState<string | null>(freeform && !listed && value !== '' ? value : null)
  // The value can change under us — the CLI or an editor writing the same
  // file. Re-derive the custom state when it does, so the select never claims
  // "default" while a custom theme is actually set.
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setCustom(freeform && !listed && value !== '' ? value : null)
  }

  return (
    <div className="s-inline">
      <select
        className="s-select"
        disabled={disabled}
        value={custom !== null ? CUSTOM : listed ? value : ''}
        onChange={(event) => {
          const next = event.target.value
          if (next === CUSTOM) {
            setCustom(value)
            return
          }
          setCustom(null)
          save(next)
        }}
      >
        <option value="">Default</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {freeform && <option value={CUSTOM}>Type a name…</option>}
      </select>
      {custom !== null && (
        <TextControl
          value={custom}
          placeholder="Theme name"
          disabled={disabled}
          onSave={(next) => {
            if (next.trim().length > 0) save(next.trim())
          }}
        />
      )}
    </div>
  )
}

function NumberControl({
  value: truth,
  min,
  max,
  integer,
  presets,
  disabled,
  onSave
}: {
  value: number | null
  min: number
  max: number
  integer: boolean
  presets: readonly { value: number; label: string; detail?: string }[]
  disabled: boolean
  onSave: (next: number | null) => void | Promise<unknown>
}): React.JSX.Element {
  const [value, commit] = useOptimistic(truth)
  const save = (next: number | null): void => commit(next, Promise.resolve(onSave(next)))
  const preset = presets.find((candidate) => candidate.value === value)
  const [custom, setCustom] = useState<boolean>(presets.length > 0 && value !== null && preset === undefined)
  const [text, setText] = useState<string>(value === null ? '' : String(value))
  const [problem, setProblem] = useState<string | null>(null)
  // Follow a value changed by another writer (CLI, editor) — same reason as
  // EnumControl above — unless the field has focus and holds a draft.
  const focused = useRef(false)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    if (!focused.current) {
      setText(value === null ? '' : String(value))
      setCustom(presets.length > 0 && value !== null && preset === undefined)
      setProblem(null)
    }
  }

  const commitDraft = (): void => {
    if (text.trim().length === 0) {
      setProblem(null)
      save(null)
      return
    }
    const parsed = Number(text)
    if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
      setProblem(integer ? 'Must be a whole number' : 'Not a number')
      return
    }
    if (parsed < min || parsed > max) {
      setProblem(`Must be between ${String(min)} and ${String(max)}`)
      return
    }
    setProblem(null)
    save(parsed)
  }

  if (presets.length === 0 || custom) {
    return (
      <div className="s-inline">
        <input
          className="s-input s-input--number"
          type="number"
          min={min}
          max={max}
          step={integer ? 1 : 0.1}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onFocus={() => {
            focused.current = true
          }}
          onBlur={() => {
            focused.current = false
            commitDraft()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          }}
        />
        {presets.length > 0 && (
          <button type="button" className="s-linkish" onClick={() => setCustom(false)}>
            Choices
          </button>
        )}
        {problem !== null && <div className="s-error">{problem}</div>}
      </div>
    )
  }

  return (
    <select
      className="s-select"
      disabled={disabled}
      value={preset !== undefined ? String(preset.value) : value === null ? DEFAULT : CUSTOM}
      onChange={(event) => {
        const next = event.target.value
        if (next === DEFAULT) {
          save(null)
          return
        }
        if (next === CUSTOM) {
          setText(value === null ? '' : String(value))
          setCustom(true)
          return
        }
        save(Number(next))
      }}
    >
      <option value={DEFAULT}>Default</option>
      {presets.map((candidate) => (
        <option key={candidate.value} value={String(candidate.value)}>
          {candidate.label}
          {candidate.detail === undefined ? '' : ` (${candidate.detail})`}
        </option>
      ))}
      <option value={CUSTOM}>Type a number…</option>
    </select>
  )
}

export function TextControl({
  value,
  placeholder,
  disabled,
  onSave,
  onLiveChange
}: {
  value: string
  placeholder?: string
  disabled?: boolean
  onSave: (next: string) => void
  /** Every keystroke, for callers whose buttons enable off the draft. */
  onLiveChange?: (next: string) => void
}): React.JSX.Element {
  const [text, setText] = useState(value)
  // The file round trip may change the value under us; follow it unless the
  // field has focus.
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(value)
  }, [value])

  return (
    <input
      className="s-input"
      type="text"
      value={text}
      placeholder={placeholder ?? ''}
      disabled={disabled === true}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(event) => {
        setText(event.target.value)
        onLiveChange?.(event.target.value)
      }}
      onBlur={() => {
        focused.current = false
        if (text !== value) onSave(text)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
      }}
    />
  )
}

/**
 * A reorderable, optionally toggleable list — engines, result groups, file
 * categories, pins. Buttons rather than drag: a keyboard-first app, and drag
 * with a hidden drop model is the least discoverable control there is.
 */
export function ReorderList({
  rows,
  onToggle,
  onMove,
  onRemove
}: {
  /** `key` is the React key when ids may repeat (a hand-edited duplicate pin); it defaults to `id`. */
  rows: readonly { id: string; key?: string; label: string; detail?: string; on?: boolean }[]
  onToggle?: (id: string, next: boolean) => void
  onMove: (id: string, delta: number) => void
  onRemove?: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="s-list">
      {rows.map((row, index) => (
        <div key={row.key ?? row.id} className={`s-list__row${row.on === false ? ' s-list__row--off' : ''}`}>
          {onToggle !== undefined && (
            <Toggle
              checked={row.on !== false}
              ariaLabel={row.label}
              onChange={(next) => onToggle(row.id, next)}
            />
          )}
          <div className="s-list__text">
            <span className="s-list__label">{row.label}</span>
            {row.detail !== undefined && <span className="s-list__detail">{row.detail}</span>}
          </div>
          <div className="s-list__buttons">
            <button
              type="button"
              className="s-iconbtn"
              aria-label="Move up"
              disabled={index === 0 || row.on === false}
              onClick={() => onMove(row.id, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="s-iconbtn"
              aria-label="Move down"
              disabled={index === rows.length - 1 || row.on === false}
              onClick={() => onMove(row.id, 1)}
            >
              ↓
            </button>
            {onRemove !== undefined && (
              <button
                type="button"
                className="s-iconbtn s-iconbtn--danger"
                aria-label="Remove"
                onClick={() => onRemove(row.id)}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

const FOCUSABLE = 'button, input, select, textarea, [tabindex]:not([tabindex="-1"])'

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !(element as HTMLButtonElement).disabled
  )
}

export function Modal({
  title,
  onClose,
  children,
  wide
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // A chord capture inside the modal owns Esc while it is armed — it
        // means "stop capturing", not "close and lose the flow".
        if (captureActive) return
        event.stopPropagation()
        onClose()
      }
    }
    // Capture phase, so the app-level Esc (close the window) never sees it.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  // Focus moves into the box on open and back to the opener on close. A child
  // that already took focus with `autoFocus` keeps it.
  useEffect(() => {
    const opener = document.activeElement
    const element = box.current
    if (element !== null && !element.contains(document.activeElement)) {
      const body = element.querySelector<HTMLElement>('.s-modal__body')
      const first = body === null ? undefined : focusableIn(body)[0]
      const target = first ?? element.querySelector<HTMLElement>('.s-modal__title button')
      target?.focus()
    }
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  const trapTab = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab' || box.current === null) return
    const focusable = focusableIn(box.current)
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (first === undefined || last === undefined) return
    const active = document.activeElement
    if (event.shiftKey && (active === first || !box.current.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="s-modal" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={box}
        className={`s-modal__box${wide === true ? ' s-modal__box--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={trapTab}
      >
        <div className="s-modal__title">
          <span>{title}</span>
          <button type="button" className="s-iconbtn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="s-modal__body">{children}</div>
      </div>
    </div>
  )
}

/**
 * Chord capture. Click, press the combination, done — Esc cancels, Backspace
 * clears. The chord needs a modifier: a bare key would be captured system-wide
 * and no other application could ever receive it.
 */
// Whether any HotkeyCapture is armed right now — `Modal` reads it so its Esc
// handler (capture phase, runs before React's) does not steal the cancel.
let captureActive = false

/** Whether a chord capture is armed right now, for handlers that must yield Esc to it. */
export function isCaptureActive(): boolean {
  return captureActive
}

const LOST_CAPTURE_NOTE =
  'The desktop took that key, or nothing arrived. Type it instead, for example Super+Shift+R.'

export function HotkeyCapture({
  value,
  allowNone,
  disabled,
  onPick
}: {
  /** `formatHotkey` spelling, or '' for none. */
  value: string
  allowNone?: boolean
  disabled?: boolean
  onPick: (hotkey: string | null) => void
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [typed, setTyped] = useState<string | null>(null)
  const arm = (next: boolean): void => {
    captureActive = next
    setCapturing(next)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!capturing) return
    event.preventDefault()
    event.stopPropagation()

    if (event.key === 'Escape') {
      arm(false)
      setNote(null)
      return
    }
    if (event.key === 'Backspace' && allowNone === true) {
      arm(false)
      setNote(null)
      onPick(null)
      return
    }

    if (['Control', 'Alt', 'Shift', 'Meta', 'Super', 'Hyper'].includes(event.key)) return // keep waiting
    const chord = chordFrom(event)
    if (chord === null) {
      setNote(`Cannot bind ${event.key}.`)
      return
    }
    if (chord.mods.length === 0) {
      setNote('Add a modifier. A bare key would be taken away from every other app.')
      return
    }
    arm(false)
    setNote(null)
    setTyped(null)
    onPick(formatHotkey(chord))
  }

  const submitTyped = (): void => {
    const parsed = parseHotkey(typed ?? '')
    if (parsed === null || parsed.mods.length === 0) {
      setNote('That is not a hotkey.')
      return
    }
    setNote(null)
    setTyped(null)
    onPick(formatHotkey(parsed))
  }

  return (
    <div className="s-inline">
      <button
        type="button"
        className={`s-hotkey${capturing ? ' s-hotkey--capturing' : ''}`}
        disabled={disabled === true}
        onClick={() => {
          arm(true)
          setNote(null)
          setTyped(null)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Focus leaving while armed means the chord went to the desktop (a
          // global bind such as the launcher's own) and never reached us.
          if (capturing) {
            setNote(LOST_CAPTURE_NOTE)
            setTyped('')
          }
          arm(false)
        }}
      >
        {capturing ? 'Press the keys…' : value.length === 0 ? 'None' : value}
      </button>
      {typed !== null && (
        <input
          className="s-input"
          type="text"
          placeholder="Super+Shift+R"
          aria-label="Type the hotkey"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitTyped()
          }}
        />
      )}
      {note !== null && <div className="s-error">{note}</div>}
    </div>
  )
}

/**
 * A DOM key event as raw chord pieces, or `null` while only modifiers are
 * down. Shared by the global-hotkey capture and the panel-key capture, which
 * differ only in vocabulary and in whether a bare key is allowed.
 */
export function rawChordFrom(
  event: React.KeyboardEvent
): { mods: readonly Modifier[]; key: string } | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'Super', 'Hyper'].includes(event.key)) return null
  const mods = MODIFIERS.filter((modifier: Modifier) => {
    if (modifier === 'ctrl') return event.ctrlKey
    if (modifier === 'alt') return event.altKey
    if (modifier === 'shift') return event.shiftKey
    return event.metaKey // 'super'
  })
  const key = normalizeKey(event.key, event.code)
  if (key === null) return null
  return { mods, key }
}

/** A DOM key event as a Hotkey, or `null` while only modifiers are down. */
function chordFrom(event: React.KeyboardEvent): Hotkey | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'Super', 'Hyper'].includes(event.key)) return null

  const mods = MODIFIERS.filter((modifier: Modifier) => {
    if (modifier === 'ctrl') return event.ctrlKey
    if (modifier === 'alt') return event.altKey
    if (modifier === 'shift') return event.shiftKey
    return event.metaKey // 'super'
  })

  const key = normalizeKey(event.key, event.code)
  if (key === null) return null
  // Built directly rather than round-tripped through parseHotkey's display
  // string: the parser splits on `+ - ,` and whitespace, so those very keys
  // could never survive the trip. The alias map turns `,` into `comma` etc.,
  // and the shape check is the same one the parser applies.
  const canonical = KEY_ALIASES[key] ?? key
  if (!/^[a-z0-9]$|^f[0-9]{1,2}$|^[a-z]+$/.test(canonical)) return null
  return { mods, key: canonical }
}

function normalizeKey(key: string, code: string): string | null {
  if (key === ' ') return 'space'
  if (key.length === 1) {
    // Letters come from `key`, not `code`: `code` names the *physical* QWERTY
    // position, so on AZERTY pressing the key that types "a" reports KeyQ —
    // and the compositor bind would fire on the wrong key. `key` is already
    // layout-resolved, and Shift is handled by lowercasing.
    if (/[a-zA-Z]/.test(key)) return key.toLowerCase()
    // Digits do use `code`: Shift changes the character (`1` → `!`) while
    // `Digit1` stays stable.
    if (/^Digit[0-9]$/.test(code)) return code.slice(5)
    return key.toLowerCase()
  }
  const named: Record<string, string> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Enter: 'return',
    Tab: 'tab',
    Home: 'home',
    End: 'end',
    PageUp: 'pageup',
    PageDown: 'pagedown',
    Delete: 'delete',
    Insert: 'insert'
  }
  if (key in named) return named[key] ?? null
  if (/^F[0-9]{1,2}$/.test(key)) return key.toLowerCase()
  return null
}
