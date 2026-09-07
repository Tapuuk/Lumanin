/**
 * Raycast's `Keyboard.Shortcut`, mapped onto a Linux keyboard.
 *
 * Distinct from `shared/hotkey.ts`, which is the *global* toggle bound in a
 * compositor. This is the in-panel kind: what an `<Action shortcut={…}/>`
 * advertises and what the action panel dispatches on.
 *
 * Renderer-safe: the renderer both draws these and matches key events against
 * them, and the worker serializes them. One normalisation, three consumers.
 */

/** The modifier names the spec allows. */
export type RaycastModifier = 'cmd' | 'ctrl' | 'opt' | 'shift' | 'alt' | 'windows'

/**
 * Ours, after the mapping. Four physical modifiers, in the order they are
 * written — the order is fixed so two spellings of the same chord produce the
 * same string and therefore match each other.
 */
export const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'super'] as const
export type Modifier = (typeof MODIFIER_ORDER)[number]

/**
 * Cmd → Ctrl, Opt → Alt.
 *
 * `cmd` is the interesting one. On macOS it is the *primary* modifier — the one
 * on Copy, Save, New — and its Linux equivalent by role is Ctrl, not Super.
 * Mapping it to Super instead would be literal and useless: it would put every
 * extension's shortcuts on a modifier the desktop reserves for the window
 * manager, so half of them would be swallowed before reaching us.
 */
const MODIFIER_MAP: Readonly<Record<RaycastModifier, Modifier>> = {
  cmd: 'ctrl',
  ctrl: 'ctrl',
  opt: 'alt',
  alt: 'alt',
  shift: 'shift',
  windows: 'super'
}

export interface Shortcut {
  readonly modifiers: readonly Modifier[]
  /** Lowercased `KeyboardEvent.key`, or one of the named keys below. */
  readonly key: string
}

/**
 * Raycast key names that are not `KeyboardEvent.key` values.
 *
 * The rest of the spec's `KeyEquivalent` union — letters, digits, punctuation —
 * already matches `event.key` once lowercased, so only the exceptions are listed.
 */
const KEY_MAP: Readonly<Record<string, string>> = {
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
  pageup: 'pageup',
  pagedown: 'pagedown',
  return: 'enter',
  enter: 'enter',
  delete: 'backspace',
  backspace: 'backspace',
  deleteforward: 'delete',
  tab: 'tab',
  space: ' ',
  escape: 'escape',
  home: 'home',
  end: 'end'
}

/** How a key is spelled for the user, where the raw value would not read. */
const KEY_LABELS: Readonly<Record<string, string>> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↵',
  backspace: '⌫',
  delete: 'Del',
  escape: 'Esc',
  tab: 'Tab',
  ' ': 'Space',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End'
}

const MODIFIER_LABELS: Readonly<Record<Modifier, string>> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  super: 'Super'
}

/**
 * Read a `Keyboard.Shortcut` off a component's props.
 *
 * The spec allows two shapes: a flat `{modifiers, key}`, or a per-platform
 * object with `macOS` and `Windows` keys. **`Windows` is preferred over `macOS`**
 * when both are present, and not arbitrarily: an author who wrote a Windows
 * variant has already done the cmd→ctrl thinking for a PC keyboard, so taking it
 * gives us their intent rather than our mechanical translation of the Mac one.
 */
export function parseShortcut(raw: unknown): Shortcut | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>

  const variant =
    pick(source['Windows']) ?? pick(source['windows']) ?? pick(source) ?? pick(source['macOS'])
  if (variant === null) return null

  const modifiers: Modifier[] = []
  for (const entry of variant.modifiers) {
    const mapped = MODIFIER_MAP[entry as RaycastModifier]
    if (mapped !== undefined && !modifiers.includes(mapped)) modifiers.push(mapped)
  }

  const lowered = variant.key.toLowerCase()
  return {
    modifiers: MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)),
    key: KEY_MAP[lowered] ?? lowered
  }
}

function pick(raw: unknown): { modifiers: string[]; key: string } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  if (typeof source['key'] !== 'string') return null
  const modifiers = Array.isArray(source['modifiers'])
    ? source['modifiers'].filter((entry): entry is string => typeof entry === 'string')
    : []
  return { modifiers, key: source['key'] }
}

/**
 * The wire form: `ctrl+shift+c`.
 *
 * A string rather than the object, because it is compared far more often than it
 * is built — every keystroke against every visible action — and comparing two
 * canonical strings needs no allocation.
 */
export function serializeShortcut(shortcut: Shortcut): string {
  return [...shortcut.modifiers, shortcut.key].join('+')
}

/**
 * Read the wire form back.
 *
 * Parsed from the **front** — consume leading tokens while they are modifiers,
 * and everything after them is the key — rather than by splitting and taking the
 * last part. The naive version cannot express a `+` key: `serializeShortcut`
 * produces `"ctrl++"`, which splits into `["ctrl", "", ""]`, and popping the tail
 * yields an empty string rather than the plus that was meant.
 */
export function deserializeShortcut(serialized: string): Shortcut | null {
  const parts = serialized.split('+')
  const modifiers: Modifier[] = []

  while (parts.length > 1) {
    const candidate = parts[0]
    if (candidate === undefined || !isModifier(candidate)) break
    if (!modifiers.includes(candidate)) modifiers.push(candidate)
    parts.shift()
  }

  const key = parts.join('+')
  if (key.length === 0) return null
  return { modifiers: MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)), key }
}

function isModifier(value: string): value is Modifier {
  return (MODIFIER_ORDER as readonly string[]).includes(value)
}

/** How the shortcut is drawn next to an action. */
export function formatShortcut(shortcut: Shortcut): string {
  const key = KEY_LABELS[shortcut.key] ?? (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key)
  return [...shortcut.modifiers.map((modifier) => MODIFIER_LABELS[modifier]), key].join('+')
}

/**
 * The footer hint bar's spelling: `⇧U`, `Ctrl+⇧K`, `Alt+↵`.
 *
 * Compact where `formatShortcut` is explicit, because the hint bar has one line
 * for a whole action set. Shift becomes the symbol and sits tight against the
 * key — `⇧U` reads as one chord — while Ctrl and Alt keep their names: their
 * symbols (⌃, ⌥) are Mac vocabulary a Linux keyboard never taught anyone.
 */
export function formatShortcutCompact(shortcut: Shortcut): string {
  const key = KEY_LABELS[shortcut.key] ?? (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key)
  let prefix = ''
  if (shortcut.modifiers.includes('ctrl')) prefix += 'Ctrl+'
  if (shortcut.modifiers.includes('alt')) prefix += 'Alt+'
  if (shortcut.modifiers.includes('super')) prefix += 'Super+'
  if (shortcut.modifiers.includes('shift')) prefix += '⇧'
  return prefix + key
}

/** The modifier state of a keyboard event, in the same vocabulary. */
export interface KeyState {
  readonly key: string
  /** `KeyboardEvent.code` — the physical key, unaffected by Shift or layout. */
  readonly code?: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly metaKey: boolean
}

/**
 * The engraved key behind a `KeyboardEvent.code`, for the codes a shortcut can name.
 *
 * Only the ones whose `key` changes under Shift are worth translating: `KeyA`
 * produces `A` rather than `a`, and `Digit1` produces `!`, `+` or `"` depending
 * on the layout. Everything else already arrives as itself.
 */
function engraved(code: string | undefined): string | null {
  if (code === undefined) return null
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  const punctuation: Readonly<Record<string, string>> = {
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Comma: ',',
    Period: '.',
    Slash: '/'
  }
  return punctuation[code] ?? null
}

/**
 * Whether an event is this shortcut.
 *
 * Modifiers are matched **exactly** — a shortcut with no Shift does not fire on
 * Ctrl+Shift+C — because the alternative silently makes every unmodified action
 * shadow the modified one that was meant to be distinct.
 *
 * When Shift is involved the *physical* key decides. `{modifiers: ["shift"], key:
 * "1"}` has to fire on Shift+1 whatever that produces — `!` on a US layout, `+`
 * on a German one — and matching the produced character would silently make an
 * extension's shortcuts depend on the user's keyboard layout, which is not
 * something its author can test for. `code` is optional so this stays usable
 * from a plain object in a test; without it, matching falls back to the key.
 */
export function matchesShortcut(event: KeyState, shortcut: Shortcut): boolean {
  const wanted = new Set(shortcut.modifiers)
  if (event.ctrlKey !== wanted.has('ctrl')) return false
  if (event.altKey !== wanted.has('alt')) return false
  if (event.shiftKey !== wanted.has('shift')) return false
  if (event.metaKey !== wanted.has('super')) return false

  if (event.key.toLowerCase() === shortcut.key) return true
  return engraved(event.code) === shortcut.key
}

/** The action panel's own key, fixed so extensions cannot rebind it. */
export const ACTION_PANEL_SHORTCUT: Shortcut = { modifiers: ['ctrl'], key: 'k' }

/** Enter runs the first action; this runs the second. Raycast's convention. */
export const SECONDARY_ACTION_SHORTCUT: Shortcut = { modifiers: ['ctrl'], key: 'enter' }
