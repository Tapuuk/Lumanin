import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { ENV_PREFIX } from '@shared/identity'
import { formatHotkey, KEY_ALIASES, MODIFIERS, parseHotkey, type Hotkey, type Modifier } from '@shared/hotkey'
import type { Setting } from '@shared/settings-model'
import { matchesFilter } from './sections'
import { RowSavedContext, setConfig, useOptimistic, useSettingsState } from './useSettings'

/**
 * The generic building blocks every screen is made of. Each control saves on
 * change, shows the chosen value at once, and lets the config round trip
 * confirm it — the same instant-apply the daemon's file watch already gives
 * every other writer of `config.toml`.
 */

/** The sidebar's filter text. Rows and sections hide themselves when they do not match it. */
export const FilterContext = createContext('')

export function useFilter(): string {
  return useContext(FilterContext)
}

/**
 * How a Section learns what its Rows decided: each Row reports whether it
 * matched, and the Section stays visible while any did. `own` says the
 * Section's title or keywords matched, in which case its Rows all show.
 */
const SectionMatches = createContext<{
  readonly own: boolean
  readonly report: (id: string, matched: boolean) => void
} | null>(null)

export function Section({
  title,
  keywords,
  children
}: {
  title?: string
  /** Words a filter finds this section by, for content that is not Rows. */
  keywords?: string
  children: ReactNode
}): React.JSX.Element {
  const filter = useFilter()
  const [matched, setMatched] = useState<ReadonlySet<string>>(() => new Set())
  const report = useCallback((id: string, isMatch: boolean) => {
    setMatched((previous) => {
      if (previous.has(id) === isMatch) return previous
      const next = new Set(previous)
      if (isMatch) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const own = matchesFilter(filter, title, keywords)
  const hidden = filter.trim().length > 0 && !own && matched.size === 0
  return (
    <SectionMatches.Provider value={{ own, report }}>
      <section className="s-section" hidden={hidden}>
        {title !== undefined && <h2 className="s-section__title">{title}</h2>}
        {children}
      </section>
    </SectionMatches.Provider>
  )
}

export function Row({
  label,
  help,
  onReset,
  children
}: {
  label: string
  help?: string
  /** Offered as a "Reset" button beside the control when the value comes from the file. */
  onReset?: (() => void) | undefined
  children: ReactNode
}): React.JSX.Element {
  const filter = useFilter()
  const section = useContext(SectionMatches)
  const id = useId()
  const matched = matchesFilter(filter, label, help)
  const report = section?.report
  useLayoutEffect(() => {
    report?.(id, matched)
    return () => report?.(id, false)
  }, [report, id, matched])

  const [savedAt, setSavedAt] = useState<number | null>(null)
  const stampSaved = useCallback(() => setSavedAt(Date.now()), [])
  useEffect(() => {
    if (savedAt === null) return
    const timer = setTimeout(() => setSavedAt(null), 1500)
    return () => clearTimeout(timer)
  }, [savedAt])

  return (
    <div className="s-row" hidden={!matched && section?.own !== true}>
      <div className="s-row__text">
        <div className="s-row__label">{label}</div>
        {help !== undefined && <div className="s-row__help">{help}</div>}
      </div>
      <RowSavedContext.Provider value={stampSaved}>
        <div className="s-row__control">{children}</div>
      </RowSavedContext.Provider>
      <div className="s-row__aside">
        {onReset !== undefined && (
          <button type="button" className="s-linkish" aria-label={`Reset ${label}`} onClick={onReset}>
            Reset
          </button>
        )}
        {savedAt !== null && (
          <span key={savedAt} className="s-row__saved" aria-live="polite">
            Saved
          </span>
        )}
      </div>
    </div>
  )
}

/** Something is in progress. Sits after a label or a sentence; the words stay. */
export function Busy(): React.JSX.Element {
  return (
    <span className="s-busy" role="status" aria-label="Working">
      <i />
      <i />
      <i />
    </span>
  )
}

/** A list with nothing in it, said in one sentence. */
export function Empty({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="s-empty">{children}</p>
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
    <Row label={setting.label} help={help} onReset={read.layer === 'file' ? () => void save(null) : undefined}>
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
          label={setting.label}
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
          label={setting.label}
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

// Sentinel value for the custom-name row. The NUL escape keeps it impossible
// to collide with a real theme name, while staying visible in source (a
// literal NUL byte makes the file read as binary).
const CUSTOM = '\u0000custom'

export interface PickOption {
  value: string
  label: string
  detail?: string
}

/**
 * The one way a value is chosen from a list: a button showing the current
 * choice that opens a filterable list in a dialog. No OS popup, so it looks
 * the same on every desktop and its keys are ours.
 */
export function PickButton({
  title,
  value,
  options,
  text,
  disabled,
  onPick
}: {
  /** The dialog's title, usually the setting's label. */
  title: string
  value: string
  options: readonly PickOption[]
  /** What the button shows when it is not the picked option's label. */
  text?: string | undefined
  disabled?: boolean
  onPick: (value: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const label = text ?? options.find((option) => option.value === value)?.label ?? value
  return (
    <>
      <button
        type="button"
        className="s-pick"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled === true}
        onClick={() => setOpen(true)}
      >
        <span className="s-pick__label">{label}</span>
        <span className="s-pick__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <PickOverlay
          title={title}
          value={value}
          options={options}
          onClose={close}
          onPick={(next) => {
            setOpen(false)
            onPick(next)
          }}
        />
      )}
    </>
  )
}

export function PickOverlay({
  title,
  value,
  options,
  onPick,
  onClose,
  wide,
  crumbs,
  onCrumb,
  onBack,
  filter: withFilter,
  levelKey,
  empty,
  children
}: {
  title: string
  /** The option shown active on open, if any. */
  value?: string
  options: readonly PickOption[]
  onPick: (value: string) => void
  onClose: () => void
  wide?: boolean
  /** The trail from the root to here, current level last; hidden with one crumb or fewer. */
  crumbs?: readonly string[]
  /** A click on any crumb but the last. */
  onCrumb?: (index: number) => void
  /** One level up: Backspace or ArrowLeft with an empty filter. */
  onBack?: () => void
  /** Whether the filter input is shown; defaults to true. */
  filter?: boolean
  /** When it changes, the filter text and the active row reset. */
  levelKey?: string
  /** Shown when there are no options at all (not when a filter empties them). */
  empty?: ReactNode
  /** Rendered after the list. */
  children?: ReactNode
}): React.JSX.Element {
  const id = useId()
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)))
  const [seen, setSeen] = useState(levelKey)
  if (levelKey !== seen) {
    setSeen(levelKey)
    setFilter('')
    setActive(0)
  }
  const shown = options.filter((option) => matchesFilter(filter, option.label, option.detail))
  const rowId = (option: PickOption): string => `${id}-${String(options.indexOf(option))}`
  const activeRow = shown[Math.min(active, shown.length - 1)]

  useEffect(() => {
    if (activeRow !== undefined) document.getElementById(rowId(activeRow))?.scrollIntoView({ block: 'nearest' })
  })

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    const last = shown.length - 1
    const current = Math.min(active, last)
    switch (event.key) {
      case 'ArrowDown':
        setActive(Math.min(last, current + 1))
        break
      case 'ArrowUp':
        setActive(Math.max(0, current - 1))
        break
      case 'Enter':
        if (activeRow !== undefined) onPick(activeRow.value)
        break
      default:
        return
    }
    event.preventDefault()
  }

  const onBodyKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (onBack === undefined || isCaptureActive()) return
    if (event.key !== 'Backspace' && event.key !== 'ArrowLeft') return
    if (event.target instanceof HTMLInputElement && event.target.value.length > 0) return
    event.preventDefault()
    onBack()
  }

  const trail = crumbs ?? []
  const current = trail[trail.length - 1]

  return (
    <Modal title={title} onClose={onClose} wide={wide === true}>
      <div className="s-pickbody" onKeyDown={onBodyKeyDown}>
        {trail.length > 1 && (
          <nav className="s-crumbs" aria-label="Where you are">
            {trail.slice(0, -1).map((crumb, index) => (
              <span key={`${String(index)}-${crumb}`} className="s-crumbs__item">
                <button
                  type="button"
                  className="s-linkish"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onCrumb?.(index)}
                >
                  {crumb}
                </button>
                <span className="s-crumbs__sep" aria-hidden="true">
                  ›
                </span>
              </span>
            ))}
            <span className="s-crumbs__current">{current}</span>
          </nav>
        )}
        {withFilter !== false && (
          <input
            className="s-input s-input--fill"
            type="text"
            placeholder="Type to narrow…"
            aria-label="Narrow the choices"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={activeRow === undefined ? undefined : rowId(activeRow)}
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            autoFocus
          />
        )}
        <div id={`${id}-list`} className="s-picklist s-picklist--overlay" role="listbox" aria-label={title}>
          {shown.map((option) => {
            const isActive = option === activeRow
            return (
              <button
                key={option.value}
                id={rowId(option)}
                type="button"
                role="option"
                data-value={option.value}
                aria-selected={isActive}
                className={`s-pickrow${isActive ? ' s-pickrow--active' : ''}`}
                tabIndex={-1}
                onMouseMove={() => setActive(shown.indexOf(option))}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick(option.value)}
              >
                <span className="s-pickrow__label">{option.label}</span>
                {option.detail !== undefined && <span className="s-pickrow__detail">{option.detail}</span>}
              </button>
            )
          })}
        </div>
        {options.length > 0 && shown.length === 0 && <div className="s-help">Nothing matches.</div>}
        {options.length === 0 && empty}
        {children}
      </div>
    </Modal>
  )
}

function EnumControl({
  label,
  options,
  freeform,
  value: truth,
  disabled,
  onSave
}: {
  label: string
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
  // file. Re-derive the custom state when it does, so the button never claims
  // "Default" while a custom theme is actually set.
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setCustom(freeform && !listed && value !== '' ? value : null)
  }

  const rows: PickOption[] = [
    { value: '', label: 'Default' },
    ...options,
    ...(freeform ? [{ value: CUSTOM, label: 'Custom name…' }] : [])
  ]
  const current = custom !== null ? CUSTOM : listed ? value : ''

  return (
    <div className="s-inline">
      <PickButton
        title={label}
        value={current}
        options={rows}
        text={custom === null ? undefined : custom.length === 0 ? 'Custom name' : custom}
        disabled={disabled}
        onPick={(next) => {
          if (next === CUSTOM) {
            setCustom(listed ? '' : value)
            return
          }
          setCustom(null)
          save(next)
        }}
      />
      {custom !== null && (
        <TextControl
          value={custom}
          placeholder="Theme name"
          disabled={disabled}
          autoFocus
          onSave={(next) => {
            if (next.trim().length > 0) save(next.trim())
          }}
        />
      )}
    </div>
  )
}

function NumberControl({
  label,
  value: truth,
  min,
  max,
  integer,
  presets,
  disabled,
  onSave
}: {
  label: string
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

  const pick = (next: number): void => {
    setText(String(next))
    setProblem(null)
    save(next)
  }

  const field = (
    <input
      className="s-input s-input--number"
      type="number"
      min={min}
      max={max}
      step={integer ? 1 : 0.1}
      value={text}
      placeholder={presets.length > 0 ? 'Default' : ''}
      aria-label={presets.length > 0 ? 'Custom value' : label}
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
  )

  if (presets.length === 0) {
    return (
      <div className="s-inline">
        {field}
        {problem !== null && <div className="s-error">{problem}</div>}
      </div>
    )
  }

  // ArrowLeft/Right inside the group focus and save the neighbour, the way a
  // radio group moves.
  const onGroupKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const pills = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
    const at = pills.findIndex((pill) => pill === document.activeElement)
    if (at === -1) return
    const next = Math.min(pills.length - 1, Math.max(0, at + (event.key === 'ArrowRight' ? 1 : -1)))
    const to = pills[next]
    const candidate = presets[next]
    if (to === undefined || candidate === undefined) return
    event.preventDefault()
    to.focus()
    if (candidate.value !== value) pick(candidate.value)
  }

  return (
    <div className="s-inline">
      <div className="s-segments" role="radiogroup" aria-label={label} onKeyDown={onGroupKeyDown}>
        {presets.map((candidate) => {
          const checked = candidate.value === value
          return (
            <button
              key={candidate.value}
              type="button"
              role="radio"
              aria-checked={checked}
              className="s-segments__pill"
              disabled={disabled}
              tabIndex={checked || (preset === undefined && candidate === presets[0]) ? 0 : -1}
              onClick={() => pick(candidate.value)}
            >
              {candidate.label}
            </button>
          )
        })}
      </div>
      {field}
      {problem !== null && <div className="s-error">{problem}</div>}
      {preset?.detail !== undefined && <div className="s-segments__detail">{preset.detail}</div>}
    </div>
  )
}

export function TextControl({
  value,
  placeholder,
  disabled,
  autoFocus,
  onSave,
  onLiveChange
}: {
  value: string
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
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
  // An effect rather than the attribute: a closing dialog hands focus back to
  // its opener from its own cleanup, which runs after the attribute would have.
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (autoFocus === true) input.current?.focus()
  }, [autoFocus])

  return (
    <input
      ref={input}
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

/** The one add button: "+ Pin something", "+ Bind a key". */
export function AddButton({
  children,
  onClick,
  disabled
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button type="button" className="s-button s-button--add" disabled={disabled === true} onClick={onClick}>
      {children}
    </button>
  )
}

/** The one remove button: a small ✕ that names what it removes. */
export function RemoveButton({ what, onClick }: { what: string; onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="s-remove" aria-label={`Remove ${what}`} onClick={onClick}>
      ✕
    </button>
  )
}

/**
 * A reorderable, optionally toggleable list — engines, result groups, file
 * categories, pins. Buttons rather than drag: a keyboard-first app, and drag
 * with a hidden drop model is the least discoverable control there is. The
 * buttons show on hover or focus; Alt+Up and Alt+Down move the focused row.
 */
export function ReorderList({
  rows,
  onToggle,
  onMove,
  onRemove
}: {
  rows: readonly { id: string; label: string; detail?: string; on?: boolean }[]
  onToggle?: (id: string, next: boolean) => void
  onMove: (id: string, delta: number) => void
  onRemove?: (id: string) => void
}): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  // Chromium drops focus from a node React reparents, so after a keyboard move
  // the moved row's first control is focused again once the new order renders.
  const pendingFocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    const id = pendingFocus.current
    if (id === null || list.current === null) return
    pendingFocus.current = null
    const row = Array.from(list.current.querySelectorAll<HTMLElement>('.s-list__row')).find(
      (candidate) => candidate.dataset['id'] === id
    )
    row?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus()
  })

  const move = (id: string, delta: number): void => {
    pendingFocus.current = id
    onMove(id, delta)
  }

  return (
    <div ref={list} className="s-list">
      {rows.map((row, index) => {
        const off = row.on === false
        const canUp = index > 0 && !off
        const canDown = index < rows.length - 1 && !off
        return (
          <div
            key={row.id}
            data-id={row.id}
            className={`s-list__row${off ? ' s-list__row--off' : ''}`}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            onKeyDown={(event) => {
              if (!event.altKey || event.ctrlKey || event.metaKey) return
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              event.stopPropagation()
              if (event.key === 'ArrowUp' && canUp) move(row.id, -1)
              if (event.key === 'ArrowDown' && canDown) move(row.id, 1)
            }}
          >
            {onToggle !== undefined && (
              <Toggle
                checked={!off}
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
                disabled={!canUp}
                onClick={() => move(row.id, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="s-iconbtn"
                aria-label="Move down"
                disabled={!canDown}
                onClick={() => move(row.id, 1)}
              >
                ↓
              </button>
              {onRemove !== undefined && <RemoveButton what={row.label} onClick={() => onRemove(row.id)} />}
            </div>
          </div>
        )
      })}
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
  // that already took focus with `autoFocus` keeps it. The opener is captured
  // at render time (before autoFocus moves focus); if it has been unmounted by
  // the time the effect runs, whatever holds focus then is the opener instead.
  const [opener] = useState(() => document.activeElement)
  const restore = useRef<Element | null>(null)
  useEffect(() => {
    const element = box.current
    const inside = element !== null && element.contains(document.activeElement)
    restore.current =
      opener instanceof HTMLElement && opener.isConnected
        ? opener
        : inside
          ? opener
          : document.activeElement
    if (element !== null && !inside) {
      const body = element.querySelector<HTMLElement>('.s-modal__body')
      const first = body === null ? undefined : focusableIn(body)[0]
      const target = first ?? element.querySelector<HTMLElement>('.s-modal__title button')
      target?.focus()
    }
    return () => {
      const target = restore.current
      if (target instanceof HTMLElement && target.isConnected) target.focus()
    }
  }, [opener])

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
  autoArm,
  onPick
}: {
  /** `formatHotkey` spelling, or '' for none. */
  value: string
  allowNone?: boolean
  disabled?: boolean
  /** Arm and focus on mount, for a capture that is the whole point of the screen it is on. */
  autoArm?: boolean
  onPick: (hotkey: string | null) => void
}): React.JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  const [capturing, setCapturing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [typed, setTyped] = useState<string | null>(null)
  const armed = useRef(false)
  const arm = (next: boolean): void => {
    captureActive = next
    armed.current = next
    setCapturing(next)
  }
  // No blur fires for an element removed while focused, so an armed capture
  // unmounted by a closing modal would otherwise leave the flag set for good.
  useEffect(
    () => () => {
      if (armed.current) captureActive = false
    },
    []
  )
  useEffect(() => {
    if (autoArm !== true) return
    arm(true)
    button.current?.focus()
  }, [])

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
        ref={button}
        type="button"
        className={`s-hotkey${capturing ? ' s-hotkey--capturing' : ''}`}
        aria-pressed={capturing}
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
