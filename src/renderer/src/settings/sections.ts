import { RESULT_GROUP_LABELS } from '@shared/config'
import { BUILTIN_ENGINES } from '@shared/engines'
import { FILE_CATEGORY_TITLES } from '@shared/files'
import { KEY_ACTION_INFO } from '@shared/keys'
import {
  appearanceSettings,
  FILE_SEARCH_HIDE_ON_OPEN,
  GENERAL_SETTINGS,
  GLOBAL_HOTKEY,
  HABIT_SETTING,
  TYPOS_SETTING,
  type Setting
} from '@shared/settings-model'

/** The settings app's sections, in sidebar order. `Ctrl+1..4` follow this order. */
export const SECTIONS = [
  { id: 'panel', title: 'Panel' },
  { id: 'search', title: 'Search' },
  { id: 'keys', title: 'Keys' },
  { id: 'plugins', title: 'Plugins' }
] as const

export type SectionId = (typeof SECTIONS)[number]['id']

/**
 * What follows the sections in the sidebar: entries that open something
 * outside the window instead of a screen inside it. They take the next
 * `Ctrl+N` numbers after the sections (`Ctrl+5` for the first), and each one
 * is an invoke the main process answers, so the renderer names no URL.
 */
export const SIDEBAR_LINKS = [{ id: 'issues', title: 'Report an issue', invoke: 'settings.openIssues' }] as const

export type SidebarLinkId = (typeof SIDEBAR_LINKS)[number]['id']

/** Case-insensitive substring over any of the texts. An empty filter matches everything. */
export function matchesFilter(filter: string, ...texts: readonly (string | undefined)[]): boolean {
  const needle = filter.trim().toLowerCase()
  if (needle.length === 0) return true
  return texts.some((text) => text !== undefined && text.toLowerCase().includes(needle))
}

const settingTexts = (settings: readonly Setting[]): string[] =>
  settings.flatMap((setting) => [
    setting.label,
    ...(setting.help === undefined ? [] : [setting.help]),
    ...(setting.editor.kind === 'enum' ? setting.editor.options.map((option) => option.label) : [])
  ])

/**
 * What each section is about, built from the same constants its screen
 * renders plus the group titles and a few words per section. It decides which
 * section a filter jumps to; what is shown on the screen is decided by the
 * rows themselves.
 */
export function sectionIndex(
  themes: readonly { readonly value: string; readonly label: string }[]
): Readonly<Record<SectionId, readonly string[]>> {
  return {
    panel: [
      'Behaviour',
      'Appearance',
      'Updates',
      'Launcher version',
      'update',
      ...settingTexts(GENERAL_SETTINGS),
      ...settingTexts(appearanceSettings(themes))
    ],
    search: [
      'General',
      'Global search',
      'typo',
      'spelling',
      'fuzzy',
      'Result order',
      'Web search engines',
      'Pins',
      'Aliases',
      'Ranking',
      'File search',
      'Category order',
      'hidden files',
      ...settingTexts([HABIT_SETTING, TYPOS_SETTING, FILE_SEARCH_HIDE_ON_OPEN]),
      ...BUILTIN_ENGINES.map((engine) => engine.name),
      ...Object.values(RESULT_GROUP_LABELS),
      ...Object.values(FILE_CATEGORY_TITLES)
    ],
    keys: [
      'Launcher',
      'File search',
      'Panel keys',
      'Plugin hotkeys',
      'hotkey',
      'shortcut',
      'bind',
      ...settingTexts([GLOBAL_HOTKEY]),
      ...Object.values(KEY_ACTION_INFO).flatMap((info) => (info.help === undefined ? [info.title] : [info.title, info.help]))
    ],
    plugins: ['Install a plugin', 'plugin', 'repository', 'preferences', 'remove', 'export']
  }
}

/** The first section, in sidebar order, whose index matches; null when none does. */
export function firstSectionMatching(
  filter: string,
  themes: readonly { readonly value: string; readonly label: string }[]
): SectionId | null {
  if (filter.trim().length === 0) return null
  const index = sectionIndex(themes)
  return SECTIONS.find((section) => matchesFilter(filter, ...index[section.id]))?.id ?? null
}
