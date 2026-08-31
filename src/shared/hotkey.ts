/**
 * The global hotkey, as a value rather than as a string somebody hopes is right.
 *
 * `[general].hotkey` used to be decoration: it resolved, `doctor` printed it, and
 * nothing anywhere read it. The bind that actually opened the panel was a line in
 * `hyprland.conf` written once by `doctor --fix`, hard-coded to Super+K, and
 * changing the setting changed nothing at all. This module is what makes the
 * setting the source of truth — it is parsed here, and rendered into whatever
 * syntax the compositor in front of us speaks.
 *
 * Deliberately small. A launcher needs one chord: some modifiers and a key. No
 * sequences, no chords-of-chords, no key-up bindings.
 */

export const MODIFIERS = ['super', 'ctrl', 'alt', 'shift', 'capslock'] as const
export type Modifier = (typeof MODIFIERS)[number]

export interface Hotkey {
  /** In canonical order, so two spellings of the same chord compare equal. */
  readonly mods: readonly Modifier[]
  /** Canonical lower-case key name: `space`, `k`, `return`, `f1`, `period`. */
  readonly key: string
}

/** What each modifier may be called on the way in. */
const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  super: 'super',
  mod: 'super',
  mod4: 'super',
  meta: 'super',
  win: 'super',
  windows: 'super',
  cmd: 'super',
  command: 'super',
  logo: 'super',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  mod1: 'alt',
  option: 'alt',
  shift: 'shift',
  capslock: 'capslock',
  caps_lock: 'capslock',
  caps: 'capslock',
  lock: 'capslock'
}

/** Key spellings people type, mapped to the xkb keysym name compositors want. */
export const KEY_ALIASES: Readonly<Record<string, string>> = {
  ' ': 'space',
  spacebar: 'space',
  enter: 'return',
  ret: 'return',
  esc: 'escape',
  del: 'delete',
  ins: 'insert',
  pgup: 'prior',
  pageup: 'prior',
  pgdn: 'next',
  pagedown: 'next',
  '.': 'period',
  ',': 'comma',
  '/': 'slash',
  '\\': 'backslash',
  ';': 'semicolon',
  "'": 'apostrophe',
  '`': 'grave',
  '-': 'minus',
  '=': 'equal',
  '[': 'bracketleft',
  ']': 'bracketright'
}

/** Display names, so "Super+Space" reads the way a person writes it. */
const DISPLAY_KEYS: Readonly<Record<string, string>> = {
  space: 'Space',
  return: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  period: 'Period',
  comma: 'Comma',
  slash: 'Slash',
  backslash: 'Backslash',
  semicolon: 'Semicolon',
  apostrophe: 'Apostrophe',
  grave: 'Grave',
  minus: 'Minus',
  equal: 'Equal',
  bracketleft: '[',
  bracketright: ']',
  prior: 'Page Up',
  next: 'Page Down',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End'
}

const MODIFIER_LABELS: Readonly<Record<Modifier, string>> = {
  super: 'Super',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  capslock: 'CapsLock'
}

/**
 * Parse `Super+K`, `SUPER, K`, `super-k`, `Mod4+space`.
 *
 * Separator-agnostic on purpose: this value is typed by people into a TOML file,
 * copied out of a compositor config, and read back from our own writer, and all
 * three spell it differently. Returns `null` for anything with no key or an
 * unknown modifier — a hotkey that half-parses is worse than one that is refused,
 * because it silently binds something else.
 */
export function parseHotkey(text: string): Hotkey | null {
  const parts = text
    .split(/[+\-,\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
  if (parts.length === 0) return null

  const mods = new Set<Modifier>()
  let key: string | null = null

  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part]
    if (modifier !== undefined) {
      mods.add(modifier)
      continue
    }
    // The last non-modifier wins rather than the first, so `Super+K` and a
    // stray trailing token do not produce two keys silently.
    if (key !== null) return null
    key = KEY_ALIASES[part] ?? part
  }

  if (key === null || key.length === 0) return null
  // A modifier on its own is not a hotkey, and a "key" of several characters
  // that is not a known keysym shape would be handed to the compositor verbatim.
  if (!/^[a-z0-9]$|^f[0-9]{1,2}$|^[a-z]+$/.test(key)) return null

  return { mods: MODIFIERS.filter((modifier) => mods.has(modifier)), key }
}

/** The canonical spelling, which is what gets written back to `config.toml`. */
export function formatHotkey(hotkey: Hotkey): string {
  const key = DISPLAY_KEYS[hotkey.key] ?? (hotkey.key.length === 1 ? hotkey.key.toUpperCase() : capitalize(hotkey.key))
  return [...hotkey.mods.map((modifier) => MODIFIER_LABELS[modifier]), key].join('+')
}

function capitalize(text: string): string {
  return text.length === 0 ? text : (text[0] ?? '').toUpperCase() + text.slice(1)
}

/**
 * Hyprland's `bind` syntax: `SUPER SHIFT, K`.
 *
 * Uppercase throughout to match what Omarchy and Hyprland's own docs write, and
 * because Hyprland's keysym lookup is case-insensitive either way.
 */
const HYPRLAND_MODIFIERS: Readonly<Record<Modifier, string>> = {
  super: 'SUPER',
  ctrl: 'CTRL',
  alt: 'ALT',
  shift: 'SHIFT',
  capslock: 'CAPS'
}

export function toHyprland(hotkey: Hotkey): { mods: string; key: string } {
  return {
    mods: hotkey.mods.map((modifier) => HYPRLAND_MODIFIERS[modifier]).join(' '),
    key: hotkey.key.toUpperCase()
  }
}

/**
 * The Lua config's key string: `"SUPER + SHIFT + K"`.
 *
 * One string, ` + `-joined, uppercase - verbatim the shape the wiki's Binds
 * page and Omarchy's Lua bindings write (`hl.bind("SUPER + RETURN", …)`).
 * `hl.unbind` compares this string case-sensitively against the bind's own
 * spelling, which is why the encoder is shared by both lines we emit.
 */
export function toHyprlandLua(hotkey: Hotkey): string {
  return [...hotkey.mods.map((modifier) => HYPRLAND_MODIFIERS[modifier]), hotkey.key.toUpperCase()].join(
    ' + '
  )
}

/**
 * sway's `bindsym` syntax: `Mod4+Shift+k`.
 *
 * `Mod4` rather than `$mod`: the variable is a convention of the *default*
 * config, and a user who renamed it — or who never had it, having written their
 * config from scratch — would get a bind that silently does nothing.
 */
export function toSway(hotkey: Hotkey): string {
  const names: Readonly<Record<Modifier, string>> = {
    super: 'Mod4',
    ctrl: 'Control',
    alt: 'Mod1',
    shift: 'Shift',
    capslock: 'Lock'
  }
  return [...hotkey.mods.map((modifier) => names[modifier]), hotkey.key].join('+')
}

/**
 * GTK accelerator syntax: `<Super>k`, `<Control><Alt>space`.
 *
 * What GNOME's `custom-keybinding` schema stores. gsd forwards the string to
 * gnome-shell over D-Bus and **mutter** parses it (`meta-accel-parse.c`, copied
 * from GTK's accelerator parser), resolving the key with
 * `xkb_keysym_from_name(…, CASE_INSENSITIVE)` — the same keysym vocabulary
 * {@link parseHotkey} already canonicalises to, so `space`, `period`,
 * `bracketleft`, `prior` all resolve and the key needs no translation. The
 * modifier spelling does: GTK writes `<Control>`, never `<Ctrl>`.
 */
export function toGnome(hotkey: Hotkey): string {
  const names: Readonly<Record<Modifier, string>> = {
    super: '<Super>',
    ctrl: '<Control>',
    alt: '<Alt>',
    shift: '<Shift>',
    capslock: '<Lock>'
  }
  return `${hotkey.mods.map((modifier) => names[modifier]).join('')}${hotkey.key}`
}

/**
 * Qt key-sequence syntax: `Meta+K`, `Meta+Ctrl+Space`.
 *
 * KDE stores shortcuts as whatever `QKeySequence::toString` produced, and reads
 * them back with `fromString`. That vocabulary is **not** xkb's: punctuation is
 * written as the character rather than as a keysym name (`Meta+.`, not
 * `Meta+Period`), and the page keys have Qt's own spellings. Handing it
 * `Meta+Period` yields an unparseable sequence, which KDE stores as an empty
 * shortcut — a bind that looks written and does nothing.
 */
const QT_KEYS: Readonly<Record<string, string>> = {
  space: 'Space',
  return: 'Return',
  escape: 'Esc',
  tab: 'Tab',
  period: '.',
  comma: ',',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  apostrophe: "'",
  grave: '`',
  minus: '-',
  equal: '=',
  bracketleft: '[',
  bracketright: ']',
  prior: 'PgUp',
  next: 'PgDown',
  delete: 'Del',
  insert: 'Ins',
  home: 'Home',
  end: 'End'
}

/**
 * A modifier the format has no word for. Qt's key sequences and COSMIC's
 * `Modifier` enum both know exactly Super, Ctrl, Alt and Shift; CapsLock is a
 * lock state to them, not a key one holds. Reported rather than dropped from
 * the chord, because writing `Meta+K` for `CapsLock+Meta+K` binds a different
 * key.
 */
export function unsupportedModifiers(hotkey: Hotkey): readonly Modifier[] {
  return hotkey.mods.filter((modifier) => modifier === 'capslock')
}

/** `null` when the chord holds a modifier Qt cannot spell. */
export function toKde(hotkey: Hotkey): string | null {
  if (unsupportedModifiers(hotkey).length > 0) return null
  const names: Readonly<Record<Modifier, string>> = {
    super: 'Meta',
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    capslock: ''
  }
  const key = QT_KEYS[hotkey.key] ?? (hotkey.key.length === 1 ? hotkey.key.toUpperCase() : capitalize(hotkey.key))
  return [...hotkey.mods.map((modifier) => names[modifier]), key].join('+')
}

/**
 * COSMIC's RON shortcut key: `(modifiers: [Super, Shift], key: "k")`.
 *
 * The key is an xkb keysym name in a string, which is what we already hold —
 * but in xkb's **canonical capitalisation**. COSMIC resolves an exact-case
 * lookup first and only then falls back to a case-insensitive one *with a
 * warning in the compositor log* (`sym.rs` in cosmic-settings-daemon's config
 * crate), so the multi-character keysyms whose canonical names are capitalised
 * (`Return`, `Prior`, `F1`…) are mapped rather than sent lowercase. The
 * modifier names are RON enum variants, so they are bare and capitalised — a
 * quoted or lower-cased one is a parse error that takes the *whole* custom
 * shortcuts file down with it, not just our entry.
 */
const COSMIC_KEYS: Readonly<Record<string, string>> = {
  return: 'Return',
  escape: 'Escape',
  tab: 'Tab',
  prior: 'Prior',
  next: 'Next',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  backspace: 'BackSpace'
}

/** `null` when the chord holds a modifier COSMIC's enum cannot spell. */
export function toCosmic(hotkey: Hotkey): string | null {
  if (unsupportedModifiers(hotkey).length > 0) return null
  const names: Readonly<Record<Modifier, string>> = {
    super: 'Super',
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    capslock: ''
  }
  const mods = hotkey.mods.map((modifier) => names[modifier]).join(', ')
  const key =
    COSMIC_KEYS[hotkey.key] ?? (/^f[0-9]{1,2}$/.test(hotkey.key) ? hotkey.key.toUpperCase() : hotkey.key)
  return `(modifiers: [${mods}], key: "${key}")`
}

/**
 * The offered combinations.
 *
 * A menu rather than a text field, because the alternative is asking someone to
 * know both a modifier vocabulary and a keysym name before they can change their
 * launcher's hotkey — and because a terminal cannot capture Super at all, so
 * "press the keys you want" is not available to us here. Super+Space is first
 * because it is what a launcher is expected to be on, and what most desktops put
 * a launcher on already.
 */
export const HOTKEY_PRESETS: readonly { readonly hotkey: string; readonly note: string }[] = [
  { hotkey: 'Super+R', note: 'the default - free on most desktops (COSMIC has resize mode here)' },
  { hotkey: 'Super+Shift+R', note: 'the default for file search' },
  { hotkey: 'Super+Space', note: 'what most desktops put a launcher on (input switching on COSMIC)' },
  { hotkey: 'Super+K', note: 'taken by some window managers' },
  { hotkey: 'Ctrl+Space', note: 'often taken by input-method switching' },
  { hotkey: 'Alt+Space', note: 'the window menu on some desktops' },
  { hotkey: 'Super+Enter', note: 'usually the terminal on tiling setups' },
  { hotkey: 'Ctrl+Alt+Space', note: 'unlikely to collide with anything' }
]

/** Keys offered when building a combination by hand. */
export const HOTKEY_KEYS: readonly string[] = [
  'space',
  'return',
  'tab',
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'0123456789',
  ...Array.from({ length: 12 }, (_, i) => `f${String(i + 1)}`),
  'period',
  'comma',
  'slash',
  'semicolon',
  'grave',
  'bracketleft',
  'bracketright'
]

/** A key label for the pickers, so the list reads as keys and not as keysyms. */
export function keyLabel(key: string): string {
  return DISPLAY_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : capitalize(key))
}

export function modifierLabel(modifier: Modifier): string {
  return MODIFIER_LABELS[modifier]
}
