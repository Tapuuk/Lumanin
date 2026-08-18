import {
  formatShortcut,
  matchesShortcut,
  MODIFIER_ORDER,
  serializeShortcut,
  type KeyState,
  type Modifier,
  type Shortcut
} from './shortcut'

/**
 * The panel's own keys, as a setting rather than as constants.
 *
 * Three kinds of key meet in this application and only one of them is here.
 * `shared/hotkey.ts` is the **global** chord, which lives in someone else's
 * config — a compositor's, kglobalaccel's, dconf's — and is therefore slow to
 * change and easy to get wrong. `shared/shortcut.ts` is what a **plugin**
 * declares on its own actions. This is the third: the keys the launcher itself
 * answers while its window has focus. Nothing outside this process is involved,
 * so rebinding one is a line in `config.toml` and takes effect on the next
 * keystroke.
 *
 * Renderer-safe by construction — the renderer is what matches against it.
 */

export const KEY_ACTIONS = [
  'actionPanel',
  'open',
  'secondary',
  'next',
  'previous',
  'back'
] as const

export type KeyAction = (typeof KEY_ACTIONS)[number]

/** A binding is a *list*: one action can answer to more than one chord. */
export type KeyMap = Readonly<Record<KeyAction, readonly Shortcut[]>>

export interface KeyActionInfo {
  /** The key under `[keys]` in `config.toml`. */
  readonly setting: string
  readonly title: string
  readonly help: string
}

export const KEY_ACTION_INFO: Readonly<Record<KeyAction, KeyActionInfo>> = {
  actionPanel: {
    setting: 'action_panel',
    title: 'Action Panel',
    help: 'Everything the selected row can do.'
  },
  open: {
    setting: 'open',
    title: 'Open',
    help: 'Run the first action: launch the app, open the file, enter the folder.'
  },
  secondary: {
    setting: 'secondary',
    title: 'Open (secondary)',
    help: 'Run the second action. In file search that opens the folder in the file manager where Enter enters it.'
  },
  next: { setting: 'next', title: 'Next result', help: 'Move down the list.' },
  previous: { setting: 'previous', title: 'Previous result', help: 'Move up the list.' },
  back: {
    setting: 'back',
    title: 'Back',
    help: 'Close the action panel, leave a folder, go back a view, then dismiss the panel.'
  }
}

/**
 * The defaults, which are also the documentation of what each action is for.
 *
 * `secondary` has two, and the second one is the reason this module exists.
 * Space is what a file manager uses to open the thing under the cursor, and it
 * is what makes "Enter goes in, Space opens" possible — but a bare Space is also
 * a character, so see {@link matchesKeyAction} for the one rule that keeps both
 * true at once.
 */
export const DEFAULT_KEYS: KeyMap = {
  actionPanel: [{ modifiers: ['ctrl'], key: 'k' }],
  open: [{ modifiers: [], key: 'enter' }],
  // Space first, and the order is display-only but not arbitrary: matching uses
  // every binding, while the action bar advertises the first one that would work
  // *now*. Space is the friendlier hint and the one this exists for, so it leads
  // while the box is empty and Ctrl+↵ takes over once typing begins.
  secondary: [
    { modifiers: [], key: ' ' },
    { modifiers: ['ctrl'], key: 'enter' }
  ],
  next: [{ modifiers: [], key: 'arrowdown' }],
  previous: [{ modifiers: [], key: 'arrowup' }],
  back: [{ modifiers: [], key: 'escape' }]
}

/** Spellings a person might type, mapped onto `KeyboardEvent.key` lowercased. */
const KEY_NAMES: Readonly<Record<string, string>> = {
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
  enter: 'enter',
  return: 'enter',
  esc: 'escape',
  escape: 'escape',
  space: ' ',
  spacebar: ' ',
  tab: 'tab',
  backspace: 'backspace',
  del: 'delete',
  delete: 'delete',
  insert: 'insert',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pgup: 'pageup',
  pagedown: 'pagedown',
  pgdn: 'pagedown'
}

const MODIFIER_NAMES: Readonly<Record<string, Modifier>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'ctrl',
  command: 'ctrl',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  shift: 'shift',
  super: 'super',
  meta: 'super',
  win: 'super',
  windows: 'super'
}

/**
 * Parse `Ctrl+Enter`, `Space`, `Down`, `ctrl shift p`.
 *
 * Separator-agnostic like {@link parseHotkey} and for the same reason: this is
 * typed by people into a TOML file and read back out of our own writer. Returns
 * `null` for anything with no key, an unknown modifier, or a "key" that is
 * neither one character nor a name we know — a chord that half-parses is worse
 * than one that is refused, because it silently binds something else.
 */
export function parseKeyChord(text: string): Shortcut | null {
  const trimmed = text.trim().toLowerCase()
  // A lone character is the key, even when it is one of the separators. `,`,
  // `-` and `=` are real keys on a real keyboard and someone will bind one; a
  // splitter that ate them would make those three the only keys on the board
  // that cannot be bound.
  if ([...trimmed].length === 1) return { modifiers: [], key: KEY_NAMES[trimmed] ?? trimmed }

  const parts = trimmed
    .split(/[+\s]+/)
    // `Ctrl-K` is a spelling people use and `shared/hotkey.ts` accepts, so it is
    // accepted here too — but only *inside* a token, which is what keeps a bare
    // `Ctrl+-` meaning the minus key.
    .flatMap((part) => ([...part].length > 1 ? part.split('-') : [part]))
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) return null

  const modifiers = new Set<Modifier>()
  let key: string | null = null

  for (const part of parts) {
    const modifier = MODIFIER_NAMES[part]
    if (modifier !== undefined) {
      modifiers.add(modifier)
      continue
    }
    if (key !== null) return null
    const named = KEY_NAMES[part]
    if (named !== undefined) key = named
    else if (part.length === 1) key = part
    else if (/^f([1-9]|1[0-2])$/.test(part)) key = part
    else return null
  }

  if (key === null) return null
  return { modifiers: MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key }
}

/** The canonical spelling, which is what a settings screen shows and writes. */
export function formatKeyChord(shortcut: Shortcut): string {
  return formatShortcut(shortcut)
}

/**
 * A chord that is indistinguishable from typing.
 *
 * A bare Space, letter or digit produces a character in a text field, and the
 * panel's search box always has focus — that is what makes it a launcher. So
 * such a binding fires **only while the box is empty**, which is exactly the
 * state you are in when you have just opened a view or stepped into a folder and
 * are moving with the arrow keys. Start typing and the key goes back to being
 * text, which is the behaviour anyone would predict from watching it once.
 *
 * Named keys — Enter, Escape, the arrows, F-keys — and anything with a modifier
 * are unambiguous and always fire. Someone who wants Space's job done while
 * typing can bind `secondary` to `Ctrl+Enter`, which is the other default.
 */
export function isTypeable(shortcut: Shortcut): boolean {
  return shortcut.modifiers.length === 0 && [...shortcut.key].length === 1
}

export interface KeyContext {
  /** Whether the search box is empty right now. */
  readonly searchEmpty: boolean
}

/**
 * Does this event mean this action?
 *
 * Matching is delegated to `matchesShortcut`, so the layout handling that
 * plugin shortcuts get — physical keys decide when Shift is involved — applies
 * here too, unchanged.
 */
export function matchesKeyAction(
  keys: KeyMap,
  action: KeyAction,
  event: KeyState,
  context: KeyContext = { searchEmpty: true }
): boolean {
  return keys[action].some((shortcut) => {
    if (isTypeable(shortcut) && !context.searchEmpty) return false
    return matchesShortcut(event, shortcut)
  })
}

/**
 * Which action, if any, an event means — for the callers that dispatch rather
 * than ask. Order is {@link KEY_ACTIONS}, so a chord bound to two actions
 * resolves consistently instead of by whichever `if` came first.
 */
export function keyActionFor(
  keys: KeyMap,
  event: KeyState,
  context: KeyContext = { searchEmpty: true }
): KeyAction | null {
  return KEY_ACTIONS.find((action) => matchesKeyAction(keys, action, event, context)) ?? null
}

/**
 * Two keymaps that bind the same chord to two actions.
 *
 * Reported rather than refused: the config resolver keeps both, and the settings
 * screen marks them, because refusing a save would leave the user unable to swap
 * two keys — you cannot set the first without colliding with the second.
 */
export function keyConflicts(keys: KeyMap): readonly { readonly chord: string; readonly actions: readonly KeyAction[] }[] {
  const byChord = new Map<string, KeyAction[]>()
  for (const action of KEY_ACTIONS) {
    for (const shortcut of keys[action]) {
      const chord = serializeShortcut(shortcut)
      byChord.set(chord, [...(byChord.get(chord) ?? []), action])
    }
  }

  return [...byChord.entries()]
    .filter(([, actions]) => actions.length > 1)
    .map(([chord, actions]) => ({ chord, actions }))
}

/**
 * The keys a panel binding may use, as tokens {@link parseKeyChord} accepts.
 *
 * Written as *input* spellings rather than as `KeyboardEvent.key` values —
 * `space`, `up`, `.` — so a picker can hand one straight back to the parser
 * without a second mapping in between, and so the value written to `config.toml`
 * is something a person would have typed there themselves.
 */
export const PANEL_KEYS: readonly string[] = [
  'space',
  'enter',
  'escape',
  'tab',
  'up',
  'down',
  'left',
  'right',
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'0123456789',
  ...Array.from({ length: 12 }, (_, index) => `f${String(index + 1)}`),
  '.',
  ',',
  '/',
  ';',
  "'",
  '`',
  '-',
  '=',
  '[',
  ']',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown'
]

const PANEL_KEY_LABELS: Readonly<Record<string, string>> = {
  space: 'Space',
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  up: '↑ Up',
  down: '↓ Down',
  left: '← Left',
  right: '→ Right',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'Page Up',
  pagedown: 'Page Down'
}

/** How a {@link PANEL_KEYS} token reads in a picker. */
export function panelKeyLabel(key: string): string {
  return PANEL_KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key)
}
