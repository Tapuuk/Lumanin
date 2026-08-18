import { ESC_AT_ROOT_VALUES, OPEN_ON_MONITOR_VALUES, type ResolvedConfig } from './config'
import { APP_DISPLAY_NAME } from './identity'

/**
 * The declarative half of the settings: what each one is called, what it
 * accepts, and how to read its resolved value — shared by the two frontends,
 * `lumanin config` (the terminal menu) and the settings window (the GUI app).
 *
 * This file is the reason the two cannot drift: a screen exists in both because
 * it is one list here, and a wrong value is refused by the same `editor`
 * constraints whichever surface it was typed into. The *flows* stay with their
 * frontends — a terminal wizard and a React pane share no code worth sharing —
 * but the facts about the settings live once.
 *
 * Renderer-safe by construction (`src/shared/`): nothing here may touch
 * `node:*`, the filesystem, or the theme packs' resolution.
 */

/** What a setting accepts, which is also how it is edited. */
export type Editor =
  | { readonly kind: 'boolean' }
  | {
      readonly kind: 'enum'
      readonly options: readonly { readonly value: string; readonly label: string }[]
    }
  | {
      readonly kind: 'number'
      readonly min: number
      readonly max: number
      readonly integer: boolean
      /**
       * Offered before the text field, when there are values worth naming.
       *
       * A pixel count is a number a person has to have an opinion about, and
       * most people do not — "how wide should my launcher be" has three good
       * answers and a range of bad ones. Typing one is still there, one row down.
       */
      readonly presets?: readonly { readonly value: number; readonly label: string; readonly detail?: string }[]
    }
  | { readonly kind: 'text'; readonly placeholder: string }
  | { readonly kind: 'hotkey' }

export interface Setting {
  readonly path: readonly string[]
  readonly label: string
  readonly help: string
  readonly editor: Editor
  /** The resolved value and where it came from, for the value column. */
  readonly read: (config: ResolvedConfig) => { value: unknown; layer: string; origin: string }
  /** The env var that would override this, so an override can be called out. */
  readonly envKey?: string
  /** An enum whose listed options are suggestions, not the whole vocabulary. */
  readonly freeform?: boolean
}

/**
 * The key that opens the panel.
 *
 * Lives on the **Global Search** screen rather than in General, next to the
 * things that search answers with — the same shape File Search has, where the
 * key and what it searches are one screen. It is still `[general].hotkey` in the
 * file: the key names the panel, not the search, and renaming it would be a
 * migration for a label.
 */
export const GLOBAL_HOTKEY: Setting = {
  path: ['general', 'hotkey'],
  label: 'Hotkey',
  help: 'What opens the panel. Writes the bind wherever this desktop keeps them.',
  // Not a plain text field: a hotkey typed as prose is a hotkey that silently
  // does not work. Each frontend owns its capture flow — the terminal builds
  // one from lists, the GUI can capture a chord — and both end in the same
  // string and the same plan-diff-consent write.
  editor: { kind: 'hotkey' },
  read: (c) => c.general.hotkey,
  envKey: 'HOTKEY'
}

export const GENERAL_SETTINGS: readonly Setting[] = [
  {
    path: ['general', 'hide_on_blur'],
    label: 'Hide when focus is lost',
    help: 'Turn off while debugging, or if your compositor steals focus.',
    editor: { kind: 'boolean' },
    read: (c) => c.general.hideOnBlur,
    envKey: 'HIDE_ON_BLUR'
  },
  {
    path: ['general', 'esc_at_root'],
    label: 'Escape at the root',
    help: 'What Esc does when there is nothing left to back out of.',
    editor: {
      kind: 'enum',
      options: ESC_AT_ROOT_VALUES.map((value) => ({
        value,
        label:
          value === 'hide' ? 'hide the panel' : value === 'clear' ? 'clear the query' : 'do nothing'
      }))
    },
    read: (c) => c.general.escAtRoot,
    envKey: 'ESC_AT_ROOT'
  },
  {
    path: ['general', 'open_on_monitor'],
    label: 'Open on monitor',
    help: 'Advisory: ignored where the compositor owns placement.',
    editor: {
      kind: 'enum',
      options: OPEN_ON_MONITOR_VALUES.map((value) => ({
        value,
        label:
          value === 'cursor'
            ? 'the one with the pointer'
            : value === 'focused'
              ? 'the one with the focused window'
              : 'the primary one'
      }))
    },
    read: (c) => c.general.openOnMonitor,
    envKey: 'OPEN_ON_MONITOR'
  },
  {
    path: ['general', 'width'],
    label: 'Panel width',
    help: 'How wide the panel is, at the design text size. Applied the next time it opens; clamped to the screen.',
    editor: {
      kind: 'number',
      min: 320,
      max: 4096,
      integer: true,
      presets: [
        { value: 620, label: 'Narrow', detail: '620 px' },
        { value: 760, label: 'Default', detail: '760 px' },
        { value: 900, label: 'Wide', detail: '900 px' },
        { value: 1100, label: 'Very wide', detail: '1100 px' }
      ]
    },
    read: (c) => c.general.width,
    envKey: 'WIDTH'
  },
  {
    path: ['general', 'height'],
    label: 'Panel height',
    help: 'How far it may grow - a ceiling, not a fixed height. Applied the next time it opens; clamped to the screen.',
    editor: {
      kind: 'number',
      min: 240,
      max: 4096,
      integer: true,
      presets: [
        { value: 360, label: 'Short', detail: '360 px' },
        { value: 480, label: 'Default', detail: '480 px' },
        { value: 640, label: 'Tall', detail: '640 px' },
        { value: 820, label: 'Very tall', detail: '820 px' }
      ]
    },
    read: (c) => c.general.height,
    envKey: 'HEIGHT'
  }
]

/**
 * Appearance, as a factory: the theme list is the one option set this file
 * cannot know. The CLI passes the built-in seeds; the GUI can ask the daemon,
 * whose list also has the Omarchy-derived theme and any user packs in it.
 */
export function appearanceSettings(
  themes: readonly { readonly value: string; readonly label: string }[]
): readonly Setting[] {
  return [
    {
      path: ['appearance', 'theme'],
      label: 'Theme',
      help: 'Leave unset to follow the desktop - Omarchy, KDE, GNOME, COSMIC, niri.',
      editor: { kind: 'enum', options: themes },
      // The listed packs are suggestions; an Omarchy theme or a pack under
      // `~/.config/lumanin/themes/` is named the same way and is equally valid.
      freeform: true,
      read: (c) => c.appearance.theme,
      envKey: 'THEME'
    },
    {
      path: ['appearance', 'follow_system'],
      label: 'Follow the system light/dark',
      help: 'Uses the desktop portal’s colour-scheme and accent.',
      editor: { kind: 'boolean' },
      read: (c) => c.appearance.followSystem,
      envKey: 'FOLLOW_SYSTEM'
    },
    {
      path: ['appearance', 'animations'],
      label: 'Animations',
      help: 'ANDed with prefers-reduced-motion and the theme’s own flag.',
      editor: { kind: 'boolean' },
      read: (c) => c.appearance.animations,
      envKey: 'ANIMATIONS'
    },
    {
      path: ['appearance', 'text_scale'],
      label: 'Text size',
      help: 'Leave unset to follow the desktop - Omarchy’s text size, GNOME’s text scaling. A number fixes it.',
      editor: {
        kind: 'number',
        min: 0.5,
        max: 3,
        integer: false,
        presets: [
          { value: 0.9, label: 'Smaller', detail: '×0.9' },
          { value: 1, label: 'Design size', detail: '×1' },
          { value: 1.15, label: 'Larger', detail: '×1.15' },
          { value: 1.35, label: 'Large', detail: '×1.35' }
        ]
      },
      read: (c) => c.appearance.textScale,
      envKey: 'TEXT_SCALE'
    }
  ]
}

/**
 * `[search].frecency_weight`, in words.
 *
 * The setting is a number between 0 and 1 and it was labelled with the name of
 * the algorithm — "frecency weight" — which tells you nothing unless you already
 * knew. What it actually decides is how much *what you open* is allowed to
 * reorder *what you typed*: at 0 the name match alone decides, at 1 the thing
 * you use most wins whenever it matches at all. So it is named for that, and
 * offered as four answers rather than as a decimal.
 *
 * The key in `config.toml` keeps its name: it is what the config format documents and
 * what anyone's existing file says, and renaming a key to improve a label is a
 * migration nobody asked for.
 */
export const HABIT_LEVELS: readonly { readonly value: number; readonly label: string; readonly detail: string }[] = [
  { value: 0, label: 'Off', detail: 'The name match alone decides' },
  { value: 0.3, label: 'A little', detail: 'Habit breaks ties' },
  { value: 0.6, label: 'Balanced', detail: 'The default' },
  { value: 0.9, label: 'A lot', detail: 'What you open most wins whenever it matches' }
]

export const HABIT_SETTING: Setting = {
  path: ['search', 'frecency_weight'],
  label: 'Favour what you use',
  help: 'How much your habits reorder what you typed. Written as `frecency_weight` in the file.',
  editor: { kind: 'number', min: 0, max: 1, integer: false, presets: HABIT_LEVELS },
  read: (c) => c.search.frecencyWeight,
  envKey: 'FRECENCY_WEIGHT'
}

/** The nearest named level, so a row reads as words and not as `0.6`. */
export function habitLabel(weight: number): string {
  const nearest = [...HABIT_LEVELS].sort(
    (a, b) => Math.abs(a.value - weight) - Math.abs(b.value - weight)
  )[0]
  if (nearest === undefined) return String(weight)
  return nearest.value === weight ? nearest.label : `${nearest.label} (${String(weight)})`
}

/** `[file_search].hide_on_open`: opening a file closes the panel. */
export const FILE_SEARCH_HIDE_ON_OPEN: Setting = {
  path: ['file_search', 'hide_on_open'],
  label: 'Close the panel when a file opens',
  help: 'Opening a file hands it the keyboard; a panel left up looks broken.',
  editor: { kind: 'boolean' },
  read: (c) => c.fileSearch.hideOnOpen
}

/** Root commands, for the pickers. Ids use the config's `builtin/<name>` form. */
export const BUILTIN_COMMANDS: readonly { readonly id: string; readonly title: string }[] = [
  { id: 'builtin/reload-applications', title: 'Reload Applications' },
  { id: 'builtin/reload-theme', title: 'Reload Theme' },
  { id: 'builtin/open-config', title: 'Open Configuration File' },
  { id: 'builtin/open-log', title: 'Open Log File' },
  { id: 'builtin/quit', title: `Quit ${APP_DISPLAY_NAME}` }
]

/**
 * Every plain setting the model declares, for main's `config.set` allow-list:
 * a path arriving over IPC is only written if it is one of these, so the
 * renderer can never name an arbitrary key — same closed-list rule as the verb
 * set. Hotkeys are deliberately absent: they go through the plan-diff-consent
 * flow, never through a bare set.
 */
export function allSettings(): readonly Setting[] {
  return [
    ...GENERAL_SETTINGS,
    ...appearanceSettings([]),
    HABIT_SETTING,
    FILE_SEARCH_HIDE_ON_OPEN
  ]
}
