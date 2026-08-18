import { spawnSync } from 'node:child_process'
import { APP_ID } from '../../shared/identity'
import { formatHotkey, parseHotkey, toGnome, type Hotkey } from '../../shared/hotkey'
import { shellQuote, type BindSpec } from './actions'
import type { PlatformProfile } from '../detect'

/**
 * GNOME keybinds, which are the one mechanism here that is not a file.
 *
 * GNOME keeps its shortcuts in dconf — a binary database with a daemon in front
 * of it — so there is nothing to diff and nothing to back up, and `gsettings` is
 * the supported way in. That makes this the only `--fix` action expressed as
 * commands rather than as an edit, and the reason the plan carries both.
 *
 * The shape GNOME wants is awkward and worth stating once. A custom shortcut is
 * *three* settings under a path of your choosing, plus that path's membership in
 * one list:
 *
 * ```
 *   org.gnome.settings-daemon.plugins.media-keys custom-keybindings
 *     → ['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/lumanin-toggle/']
 *   …media-keys.custom-keybinding:<that path> name / command / binding
 * ```
 *
 * Two decisions in there:
 *
 *  - **Named paths, not `custom0`.** The schema is relocatable, so the path is
 *    ours to choose, and choosing `lumanin-toggle` means the entry can be found
 *    and removed later. `custom0` is what the Settings UI happens to allocate,
 *    and adopting it would fight with it over the number.
 *  - **The list is read before it is written.** It is one array holding every
 *    custom shortcut on the machine; setting it to just ours is how a launcher
 *    deletes somebody's screenshot binding.
 *
 * Nothing here needs root, and nothing here is run without consent — planning is
 * read-only, and `runCommands` is the only thing that writes.
 */

const MEDIA_KEYS = 'org.gnome.settings-daemon.plugins.media-keys'
const CUSTOM_SCHEMA = `${MEDIA_KEYS}.custom-keybinding`
const CUSTOM_PREFIX = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/'

/** Reads one setting. Injected so the whole matrix can be tested without GNOME. */
export type SettingReader = (schema: string, key: string) => string | null

export const readGsetting: SettingReader = (schema, key) => {
  const result = spawnSync('gsettings', ['get', schema, key], { encoding: 'utf8', timeout: 3000 })
  if (result.status !== 0 || typeof result.stdout !== 'string') return null
  return result.stdout.trim()
}

/**
 * A change expressed as commands, for the one backend that has no file.
 *
 * `state` mirrors {@link PlannedEdit} so `doctor --fix` can print both kinds the
 * same way, and so "already done" is a first-class answer here too — running
 * `gsettings set` on a value that already holds it is harmless, but reporting it
 * as a change is a lie the user has no way to check.
 */
export interface CommandFix {
  readonly id: string
  readonly title: string
  readonly why: string
  readonly state: 'up-to-date' | 'will-add' | 'will-update' | 'not-applicable'
  /** argv arrays. Never a shell string. */
  readonly commands: readonly (readonly string[])[]
  /** What `--unfix` would run instead. */
  readonly undo: readonly (readonly string[])[]
  /** One line per command, for the "here is what would run" listing. */
  readonly preview: readonly string[]
}

/** GVariant `'text'` → `text`. gsettings quotes strings on the way out. */
function unquote(value: string): string {
  const match = /^'(.*)'$/s.exec(value)
  return match === null ? value : (match[1] ?? '').replaceAll("\\'", "'")
}

/** GVariant `['a', 'b']` / `@as []` → the paths. */
export function parseStringList(value: string | null): readonly string[] {
  if (value === null) return []
  const inside = /\[(.*)\]/s.exec(value)
  if (inside === null) return []
  return (inside[1] ?? '')
    .split(',')
    .map((entry) => unquote(entry.trim()))
    .filter((entry) => entry.length > 0)
}

function formatStringList(values: readonly string[]): string {
  return values.length === 0 ? '@as []' : `[${values.map((value) => `'${value}'`).join(', ')}]`
}

function pathFor(spec: BindSpec): string {
  return `${CUSTOM_PREFIX}${APP_ID}-${spec.id}/`
}

/** True for a path this app owns, whether or not it is still wanted. */
function isOurs(path: string): boolean {
  return path.startsWith(`${CUSTOM_PREFIX}${APP_ID}-`)
}

/**
 * Plan the GNOME binds. Reads; never writes.
 *
 * Returns `not-applicable` off GNOME and when `gsettings` is missing, rather
 * than throwing: a GNOME session without gsettings is a broken GNOME session,
 * and `doctor` saying so is more use than an exception.
 */
export function planGnomeBinds(
  profile: PlatformProfile,
  specs: readonly BindSpec[],
  read: SettingReader = readGsetting
): CommandFix {
  const base = {
    id: 'gnome-shortcuts',
    title: 'GNOME custom shortcuts',
    why: `Binds ${specs.map((spec) => formatHotkey(spec.hotkey)).join(', ')} through GNOME's own keyboard settings. Takes effect immediately.`
  } as const

  if (!profile.isGnome || profile.binaries.gsettings === null) {
    return { ...base, state: 'not-applicable', commands: [], undo: [], preview: [] }
  }

  const current = parseStringList(read(MEDIA_KEYS, 'custom-keybindings'))
  const wanted = specs.map(pathFor)
  // Everything of ours that should no longer be there — a `[[hotkeys]]` entry
  // the user deleted leaves an orphan otherwise, and an orphan in GNOME is a key
  // that still fires.
  const keep = current.filter((path) => !isOurs(path) && !wanted.includes(path))
  const list = [...keep, ...wanted]

  const commands: (readonly string[])[] = []
  const preview: string[] = []
  let changed = current.join('\0') !== list.join('\0')

  for (const spec of specs) {
    const path = pathFor(spec)
    const schema = `${CUSTOM_SCHEMA}:${path}`
    const values: readonly (readonly [string, string])[] = [
      ['name', spec.label],
      // GNOME runs this through GLib's shell parser, so it is a shell line —
      // the same one Hyprland and COSMIC get, quoted the same way.
      ['command', shellQuote(spec.argv)],
      ['binding', toGnome(spec.hotkey)]
    ]
    for (const [key, value] of values) {
      if (unquote(read(schema, key) ?? '') === value) continue
      changed = true
      // Backslash first, then the quote: GVariant strings treat `\` as an
      // escape, so an unescaped one from a label would corrupt the value.
      commands.push([
        'gsettings',
        'set',
        schema,
        key,
        `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
      ])
      preview.push(`gsettings set ${schema} ${key} '${value}'`)
    }
  }

  // The list goes last: a path that is in the list before its `command` is set
  // is a shortcut GNOME will briefly honour with an empty command.
  if (current.join('\0') !== list.join('\0')) {
    commands.push(['gsettings', 'set', MEDIA_KEYS, 'custom-keybindings', formatStringList(list)])
    preview.push(`gsettings set ${MEDIA_KEYS} custom-keybindings ${formatStringList(list)}`)
  }

  const undo: (readonly string[])[] = [
    ...current.filter(isOurs).map((path) => ['gsettings', 'reset-recursively', `${CUSTOM_SCHEMA}:${path}`]),
    ['gsettings', 'set', MEDIA_KEYS, 'custom-keybindings', formatStringList(current.filter((path) => !isOurs(path)))]
  ]

  return {
    ...base,
    state: changed ? (current.some(isOurs) ? 'will-update' : 'will-add') : 'up-to-date',
    commands,
    undo,
    preview
  }
}

/**
 * GTK accelerators back into hotkeys, so the settings menu can report what is
 * really bound rather than what we meant to bind.
 *
 * `<Super><Shift>k` is not a spelling {@link parseHotkey} accepts — it is angle
 * brackets rather than separators — so the brackets become separators first.
 */
export function parseGnomeAccelerator(text: string): Hotkey | null {
  return parseHotkey(text.replaceAll(/[<>]/g, '+'))
}

/** What GNOME has bound for us right now. Reads; never writes. */
export function readGnomeBinds(
  read: SettingReader = readGsetting
): readonly { readonly path: string; readonly keyText: string; readonly hotkey: Hotkey | null; readonly target: string | null }[] {
  return parseStringList(read(MEDIA_KEYS, 'custom-keybindings'))
    .filter(isOurs)
    .map((path) => {
      const schema = `${CUSTOM_SCHEMA}:${path}`
      const keyText = unquote(read(schema, 'binding') ?? '')
      const command = unquote(read(schema, 'command') ?? '')
      const open = new RegExp(`^${APP_ID} open '(.*)'$`).exec(command)
      return {
        path,
        keyText,
        hotkey: parseGnomeAccelerator(keyText),
        target: open === null ? null : (open[1] ?? '')
      }
    })
}
