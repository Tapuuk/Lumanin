import { spawn } from 'node:child_process'
import { BUILTIN_ENGINES } from '../shared/engines'
import { panelTopFraction } from '../shared/placement'
import {
  OFFERED_RESULT_GROUPS,
  RESULT_GROUP_LABELS,
  isPinKey,
  loadConfig,
  parseExtensionPin,
  type ResolvedConfig,
  type ResultGroup
} from '../shared/config'
import {
  completeFileOrder,
  FILE_CATEGORY_HINTS,
  FILE_CATEGORY_TITLES,
  type FileCategory
} from '../shared/files'
import { APP_DISPLAY_NAME, APP_ID, ENV_PREFIX, ISSUES_URL } from '../shared/identity'
import { normalizeSearchTemplate, suggestSearchIdentity } from '../shared/websearch'
import {
  formatHotkey,
  HOTKEY_KEYS,
  HOTKEY_PRESETS,
  keyLabel,
  MODIFIERS,
  modifierLabel,
  parseHotkey,
  type Hotkey,
  type Modifier
} from '../shared/hotkey'
import {
  DEFAULT_KEYS,
  formatKeyChord,
  isTypeable,
  KEY_ACTIONS,
  KEY_ACTION_INFO,
  PANEL_KEYS,
  panelKeyLabel,
  parseKeyChord,
  type KeyAction
} from '../shared/keys'
import { DEFAULT_HOTKEY, type ExtraBind, type HotkeyChoice } from '../platform/fix/actions'
import type { ApplyResult, BindPlan, ManagedBind } from '../platform/fix/index'
import { FILE_SEARCH_COMMAND, launcherOwnedTargets } from '../platform/fix/actions'
import type { EnumeratedItem } from '../shared/render-tree'
import { buildAppIndex } from '../platform/apps/index'
import { scanAllExtensions } from '../main/extensions/registry'
import {
  getValue,
  readConfigDocument,
  render,
  setValue,
  writeConfigDocument
} from '../node/config-file'
import { BUILTIN_SEEDS } from '../../themes/index'
import {
  appearanceSettings,
  BUILTIN_COMMANDS,
  FILE_SEARCH_HIDE_ON_OPEN,
  GENERAL_SETTINGS,
  GLOBAL_HOTKEY,
  HABIT_SETTING,
  habitLabel,
  type Setting
} from '../shared/settings-model'
import { isAbandoned, Menu, Screen, wizard, type Term } from './tui'

/**
 * Move `value` by `delta` in an ordered list. `null` at either end.
 *
 * Callers follow this with `list.follow(value)`: moving the row without moving
 * the highlight means whatever took its place moves back on the next press, so
 * holding Shift+↑ makes two rows trade places forever instead of walking one of
 * them up the list.
 */
function reorder<T>(items: readonly T[], value: T, delta: number): T[] | null {
  const at = items.indexOf(value)
  const to = at + delta
  if (at === -1 || to < 0 || to >= items.length) return null

  const moved = [...items]
  const [item] = moved.splice(at, 1)
  if (item === undefined) return null
  moved.splice(to, 0, item)
  return moved
}

/**
 * `lumanin config` — the whole of `config.toml`, as a menu.
 *
 * A launcher whose settings live only in a hand-edited TOML file is a launcher
 * most people never configure. This is the same file, edited through screens
 * that know what each key accepts, so a wrong value is refused at the keystroke
 * rather than discovered later as a `doctor` problem.
 *
 * Three things it does that a text editor cannot:
 *
 *  - it shows **which layer won** for every value, so a setting overridden by a
 *    `LUMANIN_*` environment variable says so instead of appearing to be
 *    ignored;
 *  - it resolves ids to names — a pin reads "Firefox", not
 *    `app:firefox.desktop` — and picks them from what is actually installed;
 *  - it never writes a key that equals the built-in default, so defaults stay
 *    free to improve underneath a config that never disagreed with them.
 *
 * Every finished edit is written at once and the running daemon told to reload;
 * there is no Save. The document is parsed, edited in memory, and re-rendered,
 * which is how keys for features not built yet survive a round trip.
 */

export interface ConfigUiDeps {
  readonly term: Term
  readonly env: Readonly<Record<string, string | undefined>>
  readonly configFile: string
  readonly home: string
  /**
   * Where installed extensions live, so the command picker can offer theirs.
   *
   * Scanned lazily and only when a picker is opened — it is a handful of
   * `readFile`s, but a menu that touches disk on the way in is a menu that feels
   * slower than the file it edits.
   */
  readonly extensionsDir: string
  /** Where the plugins that ship inside the application live. */
  readonly bundledDir: string
  /** `paths.data` — bundled plugins keep their scratch space under here. */
  readonly dataDir: string
  /**
   * Tell the running daemon to re-read the file. `null` when none is running.
   *
   * Resolves `ok: false` with a reason when something was saved that a reload
   * cannot apply — the panel's width and height, which belong to a window that
   * was created once and is never resized.
   */
  readonly applyChanges: (() => Promise<{ ok: boolean; detail?: string }>) | null
  /** Restart the daemon, for the settings a reload cannot apply. */
  readonly restartDaemon: (() => Promise<boolean>) | null
  /**
   * Plan the compositor edits that would bind a hotkey, without making them.
   *
   * Injected rather than imported so this module still has no opinion about the
   * platform, and so the planner can be driven with a fake profile in a test.
   * `null` where there is no compositor whose config we know how to write.
   */
  readonly planBind: ((choice: HotkeyChoice) => BindPlan) | null
  /** Apply what `planBind` returned, after the user has seen the diff. */
  readonly applyBind: ((plan: BindPlan) => Promise<readonly ApplyResult[]>) | null
  /**
   * Ask a running plugin what rows a category holds — the daemon's `enumerate`
   * verb, daemon started on demand. What lets an individual item, or one action
   * on it, be pinned. `null` when there is no way to reach a daemon at all.
   */
  readonly enumerateItems:
    | ((command: string, category: string | null) => Promise<readonly EnumeratedItem[]>)
    | null
  /**
   * The binds that are really in the compositor's config right now.
   *
   * The hotkeys screen is the one screen whose subject does not live in
   * `config.toml`: the key fires because of a line in `hyprland.conf`. Without
   * reading that back, removing an entry here would report a removal that has
   * not happened — see the screen's own note. `null` where there is no
   * compositor config of ours to read.
   */
  readonly readBinds: (() => readonly ManagedBind[]) | null
}

/** One entry of `[search].pins` as the draft holds it. */
interface PinDraftEntry {
  readonly key: string
  /** Stored only for plugin items, which cannot be resolved without running the plugin. */
  readonly title: string | null
  /** The row's own icon, likewise: a URL the root draws without the plugin. */
  readonly icon?: string | null
}

// The settings themselves — labels, editors, resolved-value readers — live in
// `shared/settings-model.ts`, shared with the settings window so the two
// frontends cannot drift. This file owns only the terminal flows around them.
const GENERAL = GENERAL_SETTINGS
const APPEARANCE = appearanceSettings(
  BUILTIN_SEEDS.map((seed) => ({ value: seed.meta.id, label: seed.meta.name }))
)
const COMMANDS = BUILTIN_COMMANDS

/** What the plugin browser needs to pin things in place with Space. */
interface PinControl {
  readonly isPinned: (key: string) => boolean
  readonly toggle: (key: string, title: string | null, icon: string | null) => void
}

type Draft = Record<string, unknown>

export async function runConfigUi(deps: ConfigUiDeps): Promise<number> {
  const screen = new Screen(deps.term)
  const menu = new Menu(deps.term, screen, deps.env)
  const s = menu.styles

  const document = readConfigDocument(deps.configFile)

  /** Every exit runs through here: raw mode must not outlive this process. */
  const finish = (code: number): number => {
    menu.close()
    return code
  }

  if (document.parseError !== null) {
    // Editing would mean rewriting from an empty document, silently discarding
    // everything the file says. The user has to decide that, not this.
    menu.say(
      `\n  ${s.bad('This config file does not parse, so it cannot be edited safely.')}\n` +
        `  ${document.path}\n  ${s.dim(document.parseError)}\n\n` +
        `  Fix it by hand, or move it aside and run this again.\n`
    )
    return finish(1)
  }

  const draft: Draft = structuredClone(document.data)
  const resolved = (): ResolvedConfig =>
    loadConfig({ fileContents: render(draft), env: deps.env })
  const dirty = (): boolean => render(draft) !== (document.original ?? '')

  // What a reload could not apply live - the panel's width and height - is kept
  // for the way out, where a restart can be offered once rather than per edit.
  let restartDetail: string | null = null
  let commentBackup: string | null = null
  let applying: Promise<void> = Promise.resolve()
  const set = (path: readonly string[], value: unknown): void => {
    if (!setValue(draft, path, value)) {
      // Refused with its name, in the same red the parse-error banner uses: a
      // section that is a scalar or an array in the file cannot take this key.
      menu.say(
        `\n  ${s.bad(`Could not set "${path.join('.')}" - [${path[0] ?? ''}] is not a table in your config.toml.`)}\n`
      )
      return
    }
    if (!dirty()) return
    const hadComments = document.commentLines
    const written = writeConfigDocument(document, draft, stamp())
    if (hadComments > 0 && written.backup !== null) commentBackup = written.backup
    const apply = deps.applyChanges
    if (apply === null) return
    applying = applying.then(async () => {
      const applied = await apply()
      if (!applied.ok) restartDetail = applied.detail ?? 'the daemon could not apply this live'
    })
  }

  // The application index, built once and only if a picker asks for it: it is
  // 10–30 ms of disk work that most visits to this menu never need.
  let apps: readonly { id: string; name: string }[] | null = null
  const applications = (): readonly { id: string; name: string }[] => {
    apps ??= buildAppIndex({
      env: deps.env,
      home: deps.home,
      desktops: (deps.env['XDG_CURRENT_DESKTOP'] ?? '')
        .split(':')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0)
    }).entries.map((entry) => ({ id: entry.id, name: entry.name }))
    return apps
  }

  /** Installed extension commands, for the pickers. Scanned once, on demand. */
  let installedIndex: ReturnType<typeof scanAllExtensions> | null = null
  const extensionIndex = (): ReturnType<typeof scanAllExtensions> =>
    (installedIndex ??= scanAllExtensions({
      extensionsDir: deps.extensionsDir,
      bundledDir: deps.bundledDir,
      dataDir: deps.dataDir
    }))

  const extensionCommands = (): readonly {
    id: string
    title: string
    extension: string
    root: boolean
    categories: readonly { id: string; title: string }[]
  }[] =>
    extensionIndex().commands.map((command) => ({
      id: command.id,
      title: command.spec.title,
      extension: command.extension.manifest.title,
      root: command.spec.root,
      categories: command.spec.categories
    }))

  /**
   * The commands a pin, alias or hotkey may name.
   *
   * `lumanin.root: false` means *nothing at the root*, and a pin browser is the
   * root — offering Search Files here would offer to put it back in the list it
   * exists in order to stay out of. It keeps its own key, in File Search.
   *
   * Separate from {@link extensionCommands} rather than replacing it, because
   * `describePin` still has to be able to name such a command: a config written
   * by hand, or before this rule, must read as what it is instead of as a raw id.
   */
  const pinnableCommands = (): ReturnType<typeof extensionCommands> =>
    extensionCommands().filter((command) => command.root)

  /** `app:firefox.desktop` → "Firefox", for every list that shows a pin key. */
  const describePin = (key: string): string => {
    const separator = key.indexOf(':')
    const kind = key.slice(0, separator)
    const id = key.slice(separator + 1)

    // The command line is its own description. Nothing to resolve, and nothing
    // that could be out of date — which is also why it can never read "(not
    // installed)" the way the others can.
    if (kind === 'shell') return id
    // Both lists, because an alias target is written as a bare id and so reaches
    // here as `command:` whether it names one of ours or an extension's.
    if (kind === 'command') {
      return (
        COMMANDS.find((c) => c.id === id)?.title ??
        extensionCommands().find((c) => c.id === id)?.title ??
        id
      )
    }
    if (kind === 'extension') {
      const parts = parseExtensionPin(id)
      if (parts !== null) {
        const command = extensionCommands().find((c) => c.id === parts.commandId)
        if (command === undefined) return `${id} (not installed)`

        // An empty category is the spelling for a command that declares none —
        // its rows are still nameable, so this is a real key, not a broken one.
        const category = command.categories.find((c) => c.id === parts.category)
        if (parts.category.length > 0 && category === undefined) return `${id} (not installed)`
        const name =
          category === undefined
            ? `${command.extension}: ${command.title}`
            : `${command.extension}: ${category.title}`

        if (parts.item === null) return name
        if (parts.action === null) return `a row in ${name}`
        return `“${parts.action}” on a row in ${name}`
      }
      return extensionCommands().find((c) => c.id === id)?.title ?? `${id} (not installed)`
    }
    if (kind === 'web') {
      const engine = resolved().search.webSearches.value.find((e) => e.id === id)
      return engine === undefined ? `${id} (not enabled)` : `Search ${engine.name}`
    }
    return applications().find((app) => app.id === id)?.name ?? `${id} (not installed)`
  }

  const valueOf = (setting: Setting): { text: string; overridden: boolean } => {
    const state = setting.read(resolved())
    const text =
      state.value === null || state.value === undefined
        ? 'not set'
        : typeof state.value === 'boolean'
          ? state.value
            ? 'yes'
            : 'no'
          : String(state.value)
    return { text, overridden: state.layer === 'env' || state.layer === 'flag' }
  }

  /**
   * Pick a combination, then offer to make it real.
   *
   * The second half is the point. Writing `hotkey = "Super+Space"` into
   * `config.toml` does not bind anything on Hyprland or sway — the compositor
   * owns the bind, and until now nothing wrote it, which is why changing this
   * setting appeared to do nothing at all. So the picker finishes by planning
   * the same edit `doctor --fix` would make, showing the diff, and asking.
   */
  const hotkeyScreen = async (path: readonly string[]): Promise<void> => {
    const BUILD = '\u0000build'
    const NONE = '\u0000none'
    // Two settings share this screen: the toggle, and the key that opens Search
    // Files. They differ in two ways and no more — which value is being edited,
    // and that the second one may legitimately be *nothing*.
    const isFileSearch = path[0] === 'file_search'
    const state = isFileSearch ? resolved().fileSearch.hotkey : resolved().general.hotkey
    const currently = parseHotkey(state.value)

    // A loop, so that backing out of the builder returns *here* rather than all
    // the way to the settings list. ← undoes one decision, always.
    for (;;) {
      const chosen = await menu.list<string>({
        title: isFileSearch ? 'File search hotkey' : 'Search hotkey',
        subtitle: `Currently ${state.value.length === 0 ? 'not bound' : state.value}${
          state.layer === 'default' ? ' (the default)' : ''
        }`,
        choices: [
          ...HOTKEY_PRESETS.map((preset) => ({
            value: preset.hotkey,
            label: preset.hotkey,
            detail: preset.note,
            prefix:
              currently !== null && formatHotkey(currently) === preset.hotkey ? '> ' : '  '
          })),
          { value: '', label: '', separator: true },
          ...(isFileSearch
            ? [
                {
                  value: NONE,
                  label: 'No key',
                  detail: 'Reach Search Files through the launcher instead',
                  prefix: state.value.length === 0 ? '> ' : '  '
                }
              ]
            : []),
          { value: BUILD, label: 'Choose modifiers and a key' }
        ]
      })
      if (chosen.value === null) return

      if (chosen.value === NONE) {
        set(path, '')
        // Removing a key is a change to the compositor's file exactly as adding
        // one is, so it goes through the same write rather than quietly leaving
        // the old bind behind — see the Hotkeys screen's note on reporting
        // reality rather than intent.
        await offerBind(parseHotkey(resolved().general.hotkey.value) ?? DEFAULT_HOTKEY, 'block')
        return
      }

      let hotkey: Hotkey | null = null
      if (chosen.value === BUILD) {
        hotkey = await buildHotkey(currently)
        if (hotkey === null) continue
      } else {
        hotkey = parseHotkey(chosen.value)
        if (hotkey === null) return
      }

      set(path, formatHotkey(hotkey))
      await offerBind(hotkey, isFileSearch ? 'block' : 'main')
      return
    }
  }

  /**
   * Modifiers as a checkbox list, then the key. Two screens, no syntax.
   *
   * Both are steps of one wizard, so Esc at the key screen returns to the
   * modifiers just chosen instead of throwing them away.
   */
  const buildHotkey = async (initial: Hotkey | null): Promise<Hotkey | null> => {
    let mods: Modifier[] = [...(initial?.mods ?? ['super'])]
    let key: string | null = initial?.key ?? null

    const complete = await wizard([
      async () => {
        // Looped rather than validated afterwards: "you need a modifier" is a
        // fact about *this* screen, and reporting it two screens later — which is
        // what this did — makes the user redo the key for a mistake made before it.
        for (;;) {
          const picked = await menu.list<Modifier | null>({
            title: 'Which modifiers?',
            subtitle: 'Space toggles. Enter when you are done.',
            hints: ['space toggle'],
            choices: () =>
              MODIFIERS.map((modifier) => ({
                value: modifier,
                prefix: mods.includes(modifier) ? `${s.good('[x]')} ` : '[ ] ',
                label: modifierLabel(modifier)
              })),
            onKey: (event, value) => {
              if (value === null || event.name !== 'space') return 'ignored'
              mods = mods.includes(value) ? mods.filter((m) => m !== value) : [...mods, value]
              return 'handled'
            }
          })
          if (picked.value === null) return 'back'
          if (mods.length > 0) return 'next'

          // A bare key with no modifier would take that key away from every
          // other application on the system, which is never what anyone meant.
          await menu.show('A hotkey needs a modifier', [
            'Without one, the key would be captured system-wide and no other',
            'application could ever receive it.'
          ])
        }
      },
      async () => {
        const chosen = await menu.list<string>({
          title: 'And which key?',
          choices: HOTKEY_KEYS.map((candidate) => ({
            value: candidate,
            label: keyLabel(candidate),
            prefix: candidate === key ? '> ' : '  '
          }))
        })
        if (chosen.value === null) return 'back'
        key = chosen.value
        return 'next'
      }
    ])

    if (!complete || key === null) return null
    return { mods: MODIFIERS.filter((modifier) => mods.includes(modifier)), key }
  }

  /**
   * Write the compositor bind, after showing exactly what would change.
   *
   * Nothing here is silent and nothing here is assumed: this edits a file the
   * user's session depends on, so it plans, prints the diff, asks, backs up and
   * replaces atomically — the same contract `doctor --fix` has, because it is
   * the same code.
   */
  const offerBind = async (hotkey: Hotkey, purpose: 'main' | 'block' | 'panel' = 'main'): Promise<void> => {
    // The managed block is rewritten whole, so both callers plan the same edit —
    // but they are not the same question. Setting the global hotkey is "bind
    // this key"; leaving the Hotkeys screen is "make the file match the list".
    // Titling the second one after the *main* hotkey is how removing Super+P
    // got answered with "Bind Super+K in your compositor config?", which names
    // a key the user did not touch and does not mention the one they did.
    const asks =
      purpose === 'main'
        ? `Bind ${formatHotkey(hotkey)} on this desktop?`
        : purpose === 'panel'
          ? 'Move the panel in this desktop’s window rule?'
          : 'Update this desktop’s shortcuts?'

    if (deps.planBind === null) {
      // The panel's position is the compositor's to honour; where there is no
      // rule to write, the daemon places the window itself or the desktop
      // centres it, and there is nothing to ask.
      if (purpose === 'panel') return
      // Silence here would be the worst answer: the setting saved, nothing
      // happened, and no way to tell those apart. The hotkey is only a real bind
      // where there is a compositor config we know how to write.
      await menu.show(`Saved, but ${formatHotkey(hotkey)} is not bound`, [
        'This desktop has no config file we can write a keybind into - it binds',
        'shortcuts through its own settings, or through the desktop portal.',
        '',
        `Bind ${formatHotkey(hotkey)} to \`${APP_ID} toggle\` in your desktop's keyboard`,
        'settings, and this value stays what Lumanin reports and what the portal',
        'backend will use when it lands. `lumanin doctor` shows which one you have.'
      ])
      return
    }

    // The managed block is rewritten whole, so every plan must carry the
    // [[hotkeys]] binds too — a main-hotkey change must never erase them.
    // Every plan carries *all* the binds, because the managed block is rewritten
    // whole: a plan that omitted the file-search key would erase it the next
    // time the toggle changed, and vice versa.
    const plan = deps.planBind({
      hotkey,
      explicit: true,
      panelTop: panelTopFraction(resolved().general.top.value),
      fileSearch: draftFileSearchHotkey(),
      extraBinds: draftExtraBinds()
    })
    const pending = plan.edits.filter((edit) => edit.state === 'will-add' || edit.state === 'will-update')
    // GNOME has no file to diff: its shortcuts are dconf, so what there is to
    // show is the commands themselves.
    const runnable = plan.commands.filter((fix) => fix.state === 'will-add' || fix.state === 'will-update')

    if (pending.length === 0 && runnable.length === 0) {
      const blocked = plan.edits.find((edit) => edit.state === 'blocked')
      if (purpose === 'panel' && blocked === undefined) return
      await menu.show(
        blocked === undefined ? 'Nothing to change' : 'Cannot write the bind',
        blocked === undefined
          ? [
              purpose === 'main'
                ? `This desktop already binds ${formatHotkey(hotkey)}.`
                : 'Your desktop already has exactly what your config asks for.',
              '',
              s.dim('If this is not a desktop we can write a bind for, `lumanin doctor`'),
              s.dim('prints the line to add yourself.')
            ]
          : [blocked.problem ?? 'the config file has a broken Lumanin block']
      )
      return
    }

    // There is one managed block per file, so where the window rules live in the
    // same file as the bind they are written with it — the block cannot be
    // half-replaced. Said out loud, because a diff that turns out to contain
    // more than the screen promised is how a tool loses your trust.
    const alsoRules = pending.some((edit) => edit.actions.length > 1)

    await menu.show(
      asks,
      [
        ...(alsoRules
          ? [
              s.dim(
                purpose === 'panel'
                  ? 'Our block in this file also holds the keybinds, and a'
                  : 'Our block in this file also holds the panel window rules, and a'
              ),
              s.dim('block is rewritten whole - so they are in the diff too.'),
              ''
            ]
          : []),
        ...pending.flatMap((edit) => [...edit.diff.split('\n'), '']),
        ...runnable.flatMap((fix) => [...fix.preview.map((line) => `+ ${line}`), ''])
      ],
      'any key to decide'
    )
    if (!(await menu.confirm(`Apply ${String(pending.length + runnable.length)} change(s)?`))) return

    const results = (await deps.applyBind?.({ ...plan, edits: pending, commands: runnable })) ?? []
    await menu.show(
      results.every((result) => result.ok) ? (purpose === 'panel' ? 'Moved' : 'Bound') : 'Some writes failed',
      [
        ...results.map((result) => `${result.ok ? s.good('✔') : s.bad('✘')} ${result.path} - ${result.detail}`),
        '',
        ...plan.notes.flatMap((note) => [...note.split('\n'), ''])
      ]
    )
  }

  /**
   * The panel's position lives in the compositor's rule where there is one, so
   * changing it gets the same diff-and-consent the hotkey gets, with the new
   * value in it.
   */
  const afterNumber = async (setting: Setting): Promise<void> => {
    if (setting.path.join('.') !== 'general.top') return
    const main = parseHotkey(resolved().general.hotkey.value)
    if (main !== null) await offerBind(main, 'panel')
  }

  /** The prompt's one line: the setting's own note, if any, then what an empty answer does. */
  const emptyMeans = (setting: Setting): string => {
    const empty = setting.adaptive === true ? 'empty follows the desktop' : 'empty resets to the default'
    return setting.help === undefined ? empty : `${setting.help}  ·  ${empty}`
  }

  const editSetting = async (setting: Setting): Promise<void> => {
    const current = getValue(draft, setting.path)
    const state = setting.read(resolved())

    if (setting.editor.kind === 'hotkey') {
      await hotkeyScreen(setting.path)
      return
    }

    if (setting.editor.kind === 'boolean') {
      // Toggled from the list, not through a screen: a yes/no that costs a
      // submenu is a yes/no nobody changes.
      set(setting.path, !(state.value === true))
      return
    }

    if (setting.editor.kind === 'enum') {
      // Sentinels rather than `null`, because `null` already means "Esc": a menu
      // where backing out and choosing the first item did the same thing would
      // reset a setting every time someone changed their mind.
      const USE_DEFAULT = '\u0000default'
      const TYPE_ONE = '\u0000custom'
      const options = setting.editor.options

      // Looped so that Esc in "Type one instead" comes back to the list of
      // options rather than to the settings screen — the typed value is the
      // step being abandoned, not the decision to change the setting at all.
      for (;;) {
        const choice = await menu.list<string>({
          title: setting.label,
          ...(setting.help === undefined ? {} : { subtitle: setting.help }),
          choices: [
            {
              value: USE_DEFAULT,
              label: setting.adaptive === true ? 'Adaptive' : 'Use the default',
              help:
                setting.adaptive === true
                  ? 'Follows the desktop'
                  : 'Removes the key, so the default can still improve later'
            },
            ...(setting.freeform === true
              ? [{ value: TYPE_ONE, label: 'Type a name' }]
              : []),
            { value: '\u0000separator', label: '', separator: true },
            ...options.map((option) => ({
              value: option.value,
              label: option.label,
              ...(option.value === option.label ? {} : { detail: option.value }),
              prefix: current === option.value ? '> ' : '  '
            }))
          ]
        })

        if (choice.value === null) return
        if (choice.value === USE_DEFAULT) {
          set(setting.path, undefined)
          return
        }
        if (choice.value === TYPE_ONE) {
          const typed = await menu.prompt({
            title: setting.label,
            ...(setting.help === undefined ? {} : { help: setting.help }),
            initial: typeof current === 'string' ? current : '',
            escHint: 'esc back',
            validate: (value) => (value.trim().length === 0 ? 'needs a value' : null)
          })
          if (typed === null) continue
          set(setting.path, typed.trim())
          return
        }
        set(setting.path, choice.value)
        return
      }
    }

    if (setting.editor.kind === 'number') {
      const { min, max, presets } = setting.editor

      // A list first where there are values worth naming, and the text field
      // one row below it. Same shape as the enum editor, and for the same
      // reason: the common answers should not require knowing the units.
      if (presets !== undefined) {
        const USE_DEFAULT = '\u0000default'
        const TYPE_ONE = '\u0000custom'
        const chosen = await menu.list<string>({
          title: setting.label,
          ...(setting.help === undefined ? {} : { subtitle: setting.help }),
          choices: [
            {
              value: USE_DEFAULT,
              label: setting.adaptive === true ? 'Adaptive' : 'Use the default',
              help:
                setting.adaptive === true
                  ? 'Follows the desktop'
                  : 'Removes the key, so the default can still improve later'
            },
            { value: '\u0000separator', label: '', separator: true },
            ...presets.map((preset) => ({
              value: String(preset.value),
              label: preset.label,
              ...(preset.detail === undefined ? {} : { detail: preset.detail }),
              prefix: state.value === preset.value ? '> ' : '  '
            })),
            { value: TYPE_ONE, label: 'Type a number', help: `${String(min)}–${String(max)}` }
          ]
        })
        if (chosen.value === null) return
        if (chosen.value === USE_DEFAULT) {
          set(setting.path, undefined)
          await afterNumber(setting)
          return
        }
        if (chosen.value !== TYPE_ONE) {
          set(setting.path, Number(chosen.value))
          await afterNumber(setting)
          return
        }
      }

      const typed = await menu.prompt({
        title: setting.label,
        help: emptyMeans(setting),
        initial: current === undefined ? '' : String(current),
        validate: (input) => {
          if (input.trim().length === 0) return null
          const parsed = Number(input)
          if (!Number.isFinite(parsed)) return 'not a number'
          if (setting.editor.kind === 'number' && setting.editor.integer && !Number.isInteger(parsed)) {
            return 'must be a whole number'
          }
          return parsed < min || parsed > max ? `must be between ${String(min)} and ${String(max)}` : null
        }
      })
      if (typed === null) return
      set(setting.path, typed.trim().length === 0 ? undefined : Number(typed))
      await afterNumber(setting)
      return
    }

    const typed = await menu.prompt({
      title: setting.label,
      help: emptyMeans(setting),
      initial: typeof current === 'string' ? current : '',
      validate: () => null
    })
    if (typed === null) return
    set(setting.path, typed.trim().length === 0 ? undefined : typed.trim())
  }

  const settingsScreen = async (title: string, settings: readonly Setting[]): Promise<void> => {
    // The cursor survives an edit and a trip into a submenu. Without this every
    // screen snaps back to its first row, and changing three things in a row
    // means arrowing down from the top three times.
    let at = 0
    for (;;) {
      const choice = await menu.list<Setting>({
        title,
        initialIndex: at,
        choices: () =>
          settings.map((setting) => {
            const { text, overridden } = valueOf(setting)
            return {
              value: setting,
              label: setting.label,
              detail: overridden
                ? `${text}  ← ${ENV_PREFIX}${setting.envKey ?? ''}`
                : text,
              ...(overridden
                ? { help: 'Set by the environment; editing config.toml will not change it.' }
                : setting.help === undefined
                  ? {}
                  : { help: setting.help })
            }
          }),
        hints: ['enter edit', 'space toggle'],
        onKey: (key, value) => {
          const setting = value as Setting | null
          if (setting === null || key.name !== 'space' || setting.editor.kind !== 'boolean') {
            return 'ignored'
          }
          set(setting.path, !(setting.read(resolved()).value === true))
          return 'handled'
        }
      })
      at = choice.index
      if (choice.value === null) return
      await editSetting(choice.value)
    }
  }

  // ─── search ────────────────────────────────────────────────────────────────

  const enginesScreen = async (): Promise<void> => {
    const enabled = (): string[] => {
      const ids = getValue(draft, ['search', 'engines'])
      if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string')
      // Nothing chosen yet: start from what is actually in effect, so the first
      // toggle edits the real selection rather than an empty one.
      return resolved().search.webSearches.value.map((engine) => engine.id)
    }

    const write = (ids: readonly string[]): void => {
      set(['search', 'engines'], [...ids])
    }

    await menu.list<string>({
      title: 'Web search engines',
      hints: ['space toggle', 'ctrl+↑↓ reorder'],
      choices: () => {
        const on = enabled()
        const rest = BUILTIN_ENGINES.filter((engine) => !on.includes(engine.id))
        return [
          ...on.map((id) => {
            const engine = BUILTIN_ENGINES.find((candidate) => candidate.id === id)
            return {
              value: id,
              prefix: `${s.good('[x]')} `,
              label: engine?.name ?? id,
              detail: engine === undefined ? 'custom' : `keyword: ${engine.keyword}`
            }
          }),
          ...(rest.length === 0 ? [] : [{ value: '', label: '', separator: true }]),
          ...rest.map((engine) => ({
            value: engine.id,
            prefix: '[ ] ',
            label: engine.name,
            detail: `Keyword: ${engine.keyword}`
          }))
        ]
      },
      onKey: (key, value, _index, list) => {
        if (value === null || value === '') return 'ignored'
        const on = enabled()

        if (key.name === 'space') {
          write(on.includes(value) ? on.filter((id) => id !== value) : [...on, value])
          // The row has just jumped between the enabled and disabled groups.
          list.follow(value)
          return 'handled'
        }
        if (key.ctrl && (key.name === 'up' || key.name === 'down')) {
          const moved = reorder(on, value, key.name === 'up' ? -1 : 1)
          if (moved !== null) write(moved)
          list.follow(value)
          return 'handled'
        }
        return 'ignored'
      }
    })
  }

  const orderScreen = async (path: readonly string[], title: string): Promise<void> => {
    const current = (): ResultGroup[] => {
      const value = getValue(draft, path)
      if (Array.isArray(value)) {
        return value.filter((group): group is ResultGroup =>
          (OFFERED_RESULT_GROUPS as readonly unknown[]).includes(group)
        )
      }
      return [...resolved().search.fallbackOrder.value]
    }

    const write = (groups: readonly ResultGroup[]): void => {
      set(path, [...groups])
    }

    const describe: Readonly<Record<ResultGroup, string>> = {
      plugins: 'Your plugins’ own commands',
      apps: 'Installed applications',
      commands: 'The launcher’s own commands',
      // The two inert groups never reach the screen — `OFFERED_RESULT_GROUPS`
      // filters both directions — but the map is total so the type checks.
      // `files` moved into `plugins`; the calculator is always first and is not
      // a setting at all.
      calculator: 'Nothing - the calculator is always first',
      files: 'Nothing - file search is a plugin, listed under plugins',
      web: 'The enabled search engines'
    }

    await menu.list<ResultGroup>({
      title,
      subtitle: 'Apps and commands are ranked together by match, so their order here only breaks ties.',
      hints: ['space include', 'ctrl+↑↓ reorder'],
      choices: () => {
        const on = current()
        const off = OFFERED_RESULT_GROUPS.filter((group) => !on.includes(group))
        return [
          ...on.map((group) => ({
            value: group,
            prefix: `${s.good('[x]')} `,
            label: RESULT_GROUP_LABELS[group],
            detail: describe[group]
          })),
          ...(off.length === 0 ? [] : [{ value: 'apps' as ResultGroup, label: '', separator: true }]),
          ...off.map((group) => ({
            value: group,
            prefix: '[ ] ',
            label: RESULT_GROUP_LABELS[group],
            detail: describe[group]
          }))
        ]
      },
      onKey: (key, value, _index, list) => {
        if (value === null) return 'ignored'
        const on = current()

        if (key.name === 'space') {
          write(on.includes(value) ? on.filter((group) => group !== value) : [...on, value])
          list.follow(value)
          return 'handled'
        }
        if (key.ctrl && (key.name === 'up' || key.name === 'down')) {
          const moved = reorder(on, value, key.name === 'up' ? -1 : 1)
          if (moved !== null) write(moved)
          list.follow(value)
          return 'handled'
        }
        return 'ignored'
      }
    })
  }

  /**
   * Pick one thing that can be pinned, aliased or bound, from what exists.
   *
   * The first screen is the four kinds — an application, a command, a web search,
   * or **Plugins**, which is a menu per plugin rather than a flat list:
   *
   *     Plugins → Godot → Search Projects → Project → Dawnline → Open project
   *
   * Every one of those is a valid stopping point, and every screen says so with
   * its first row ("Open this category", "Open this row") above the things
   * underneath it. Enter on that row picks the level you are on; Enter on
   * anything else goes one deeper; Esc backs out one screen. Pins, aliases and
   * hotkeys all come through here, so what can be pinned can also be bound.
   */
  const pickPinKey = async (
    options: { readonly pinControl?: PinControl } = {}
  ): Promise<PinDraftEntry | null> => {
    type Kind = 'app' | 'command' | 'web' | 'plugins'
    let kind: Kind = 'app'
    let entry: PinDraftEntry | null = null

    const complete = await wizard([
      async () => {
        const chosen = await menu.list<Kind>({
          title: 'What do you want to add?',
          initialIndex: ['app', 'command', 'web', 'plugins'].indexOf(kind),
          choices: [
            { value: 'app', label: 'An application', detail: `${String(applications().length)} found` },
            {
              value: 'command',
              label: 'A command',
              detail: `${String(COMMANDS.length + pinnableCommands().length)} available, or your own`
            },
            { value: 'web', label: 'A web search', detail: 'One of your enabled engines' },
            {
              value: 'plugins',
              label: 'Plugins',
              detail: pluginsDetail(),
              help: 'A menu per plugin, down to one row or one of its actions'
            }
          ]
        })
        if (chosen.value === null) return 'back'
        kind = chosen.value
        return 'next'
      },
      async () => {
        if (kind === 'plugins') {
          const picked = await pluginsScreen(options.pinControl)
          if (picked === null) return 'back'
          entry = picked
          return 'next'
        }

        if (kind === 'command') {
          const picked = await pickCommand()
          if (picked === null) return 'back'
          entry = { key: picked, title: null }
          return 'next'
        }

        if (kind === 'web') {
          const engines = resolved().search.webSearches.value
          if (engines.length === 0) {
            await menu.show('No engines are enabled', ['Enable one under Search engines first.'])
            return 'back'
          }
          const chosen = await menu.list<string>({
            title: 'Which web search?',
            choices: engines.map((engine) => ({
              value: engine.id,
              label: engine.name,
              detail: `Keyword: ${engine.keyword}`
            }))
          })
          if (chosen.value === null) return 'back'
          entry = { key: `web:${chosen.value}`, title: null }
          return 'next'
        }

        const chosen = await menu.list<string>({
          title: 'Which application?',
          choices: [...applications()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((app) => ({ value: app.id, label: app.name, detail: app.id }))
        })
        if (chosen.value === null) return 'back'
        entry = { key: `app:${chosen.value}`, title: null }
        return 'next'
      }
    ])

    return complete ? entry : null
  }

  /** "3 plugins · 5 commands", for the Plugins row of the first screen. */
  const pluginsDetail = (): string => {
    const plugins = extensionIndex().extensions.length
    const commands = pinnableCommands().length
    if (plugins === 0) return 'none installed'
    return `${String(plugins)} plugin${plugins === 1 ? '' : 's'} · ${String(commands)} command${
      commands === 1 ? '' : 's'
    }`
  }

  /** Space pins the row in place, where the caller pins things. */
  const mark = (control: PinControl | undefined, key: string): string =>
    control === undefined ? '' : control.isPinned(key) ? `${s.good('[x]')} ` : '[ ] '

  /** The pin-in-place key handler, for every screen of the browser. */
  /**
   * The plugin browser's two verbs: **Enter chooses this, → looks inside it.**
   *
   * Every level of a plugin — a command, a category, a row, an action — is both
   * a thing you can pin *and* a way to reach smaller things. The old shape gave
   * each level one key and paid for it at the next: opening "Search Godot"
   * listed "Open Search Godot" above its categories, so the thing you had just
   * pressed Enter on appeared again as a child of itself, and the same trick
   * repeated inside every category and every row. Splitting the two verbs
   * removes all three of those rows and makes each screen a list of exactly the
   * things at that level.
   *
   * In the pin *browser* — where rows are toggled in place rather than returned
   * — Enter means the same thing it means everywhere else on that screen, so it
   * toggles too and stays put; Space keeps working because that is what the tab
   * has always advertised.
   */
  /**
   * Enter goes forward and Space pins. Picking a hotkey or alias target has no
   * deeper step than the thing picked, so there Enter is the choice; while
   * pinning, Enter opens the row and only the last screen - the actions - has
   * nothing further to open, so there it pins.
   */
  const pinRowKeys = (
    control: PinControl | undefined,
    keyOf: (value: unknown) => PinDraftEntry | null,
    last = false
  ) => ({
    hints:
      control === undefined
        ? ['space select', '→ open']
        : last
          ? ['space pin', 'enter pin']
          : ['space pin', 'enter open'],
    onKey: (key: { name: string }, value: unknown): 'ignored' | 'handled' | 'close' => {
      if (value === null) return 'ignored'
      // `close` with `viaKey`, which is how the caller tells "go deeper" from
      // "this is the one" without a second menu.
      if (key.name === 'right') return 'close'
      if (control === undefined) return 'ignored'
      if (key.name === 'return' && !last) return 'close'
      if (key.name !== 'space' && key.name !== 'return') return 'ignored'
      const target = keyOf(value)
      if (target === null) return 'ignored'
      control.toggle(target.key, target.title, target.icon ?? null)
      return 'handled'
    }
  })

  /** Level one: which plugin. */
  const pluginsScreen = async (control?: PinControl): Promise<PinDraftEntry | null> => {
    // A plugin with nothing pinnable in it is not listed at all, rather than
    // listed and then empty when opened. Today that is exactly one — Files,
    // whose only command is its own search surface.
    const extensions = extensionIndex().extensions.filter((extension) =>
      pinnableCommands().some((command) => command.id.startsWith(`${extension.manifest.name}/`))
    )

    for (;;) {
      const chosen = await menu.list<string>({
        title: 'Plugins',
        choices:
          extensions.length === 0
            ? [
                {
                  value: '',
                  label: 'No plugins installed',
                  detail: `${APP_ID} plugin-install <repository|directory>`,
                  separator: true
                }
              ]
            : extensions.map((extension) => ({
                value: extension.manifest.name,
                label: extension.manifest.title,
                detail: pluginDetail(extension.manifest.name)
              }))
      })

      if (chosen.value === null || chosen.value === '') return null
      const picked = await pluginCommandsScreen(chosen.value, control)
      if (picked !== null) return picked
    }
  }

  /** "2 commands · 5 categories", for one plugin's row. */
  const pluginDetail = (name: string): string => {
    const commands = pinnableCommands().filter((command) => command.id.startsWith(`${name}/`))
    const categories = commands.reduce((sum, command) => sum + command.categories.length, 0)
    const counted = `${String(commands.length)} command${commands.length === 1 ? '' : 's'}`
    return categories === 0
      ? counted
      : `${counted} · ${String(categories)} categor${categories === 1 ? 'y' : 'ies'}`
  }

  /** Level two: which of the plugin's commands. */
  const pluginCommandsScreen = async (
    name: string,
    control?: PinControl
  ): Promise<PinDraftEntry | null> => {
    const commands = pinnableCommands().filter((command) => command.id.startsWith(`${name}/`))
    const title = commands[0]?.extension ?? name

    /**
     * A command, or one of its categories, on one screen.
     *
     * Flat rather than a screen per command, because a category *belongs* to its
     * command and the pair reads as one tree — and because the screen it
     * replaced had to re-list the command inside itself to stay pinnable, which
     * is the thing that made no sense: you do not reach "Search Godot" by
     * opening Search Godot.
     */
    type Row = {
      readonly commandId: string
      /** `null` = the command; a string = one of its categories; `''` = its rows. */
      readonly category: string | null | ''
    }

    const keyOf = (row: Row): { key: string; title: string | null } | null => {
      if (row.category === '') return null
      return row.category === null
        ? { key: `extension:${row.commandId}`, title: null }
        : { key: `extension:${row.commandId}#${row.category}`, title: null }
    }

    for (;;) {
      const chosen = await menu.list<Row>({
        title,
        subtitle: 'A command, or one category inside it. → looks inside a category.',
        choices:
          commands.length === 0
            ? [
                {
                  value: { commandId: '', category: '' } as Row,
                  label: 'This plugin has no commands',
                  separator: true
                }
              ]
            : commands.flatMap((command) => [
                {
                  value: { commandId: command.id, category: null } as Row,
                  prefix: mark(control, `extension:${command.id}`),
                  label: command.title,
                  detail: 'The whole command'
                },
                ...(command.categories.length === 0
                  ? [
                      {
                        value: { commandId: command.id, category: '' } as Row,
                        prefix: control === undefined ? '  ' : '    ',
                        label: '  its rows…',
                        detail: 'Asks the plugin what it shows',
                        help: 'This command declares no categories, so → lists its rows directly'
                      }
                    ]
                  : command.categories.map((category) => ({
                      value: { commandId: command.id, category: category.id } as Row,
                      prefix: mark(control, `extension:${command.id}#${category.id}`),
                      label: `  ${category.title}`,
                      detail: category.id
                    })))
              ]),
        ...pinRowKeys(control, (value) => keyOf(value as Row))
      })

      const row = chosen.value
      if (row === null || row.commandId === '') return null
      const command = commands.find((candidate) => candidate.id === row.commandId)
      if (command === undefined) return null

      // Enter: this is the one.
      if (!chosen.viaKey) {
        const picked = keyOf(row)
        if (picked !== null && control === undefined) return picked
        continue
      }

      // →: look inside. A command whose categories are already on this screen
      // has nothing further of its own to show.
      if (row.category === null) continue
      const category = command.categories.find((entry) => entry.id === row.category)
      const picked = await itemsScreen(
        command,
        row.category,
        category?.title ?? command.title,
        control
      )
      if (picked !== null) return picked
    }
  }

  /**
   * Level four: the rows of one category, fetched from the plugin itself.
   *
   * This is the only part of the whole menu that runs plugin code — through the
   * daemon's `enumerate` verb, headless — because item titles exist only at
   * runtime. An item without an `id` prop cannot be named by a pin and says so.
   */
  const itemsScreen = async (
    command: { id: string; title: string; extension: string },
    categoryId: string,
    categoryTitle: string,
    control?: PinControl
  ): Promise<PinDraftEntry | null> => {
    if (deps.enumerateItems === null) {
      await menu.show('Cannot list the rows', [
        'Listing what is inside a category means running the plugin, and there',
        'is no daemon to run it in right now.'
      ])
      return null
    }

    menu.showNow(categoryTitle, ['Asking the plugin for its rows…'])
    let items: readonly EnumeratedItem[]
    try {
      items = await deps.enumerateItems(command.id, categoryId.length === 0 ? null : categoryId)
    } catch (error) {
      await menu.show('Could not list the rows', [
        error instanceof Error ? error.message : String(error)
      ])
      return null
    }

    const categoryKey = `extension:${command.id}#${categoryId}`
    const itemKey = (id: string): string => `${categoryKey}:${id}`

    // A tagged row rather than `EnumeratedItem | null`: Esc already resolves to
    // `null`, so a row whose value is `null` would be indistinguishable from
    // backing out.
    // The category itself is **not** a row here: it is the row you pressed → on
    // to get here, and it stays pinnable there. A screen that lists the thing
    // you opened as one of its own contents is the shape this browser used to
    // have, and it read as a duplicate every time.
    type Row = { readonly item: EnumeratedItem }
    const keyOf = (row: Row): PinDraftEntry | null =>
      row.item.id === null
        ? null
        : { key: itemKey(row.item.id), title: row.item.title, icon: row.item.icon }
    void categoryKey

    for (;;) {
      const chosen = await menu.list<Row>({
        title: categoryTitle,
        subtitle: 'One row of this category. → shows what that row can do.',
        choices: () =>
          items.length === 0
            ? [
                {
                  value: { item: { id: null, title: '', subtitle: null, actions: [], icon: null } } as Row,
                  label: 'Nothing in this category',
                  separator: true
                }
              ]
            : items.map((item) => ({
                value: { item } as Row,
                prefix:
                  item.id === null ? (control === undefined ? '' : '    ') : mark(control, itemKey(item.id)),
                label: item.title,
                ...(item.subtitle === null ? {} : { detail: item.subtitle }),
                ...(item.id === null
                  ? { help: 'This row has no id, so nothing can point at it' }
                  : {})
              })),
        ...pinRowKeys(control, (value) => keyOf(value as Row))
      })

      if (chosen.value === null) return null
      if (chosen.value.item.id === null) continue

      if (!chosen.viaKey) {
        const picked = keyOf(chosen.value)
        if (picked !== null && control === undefined) return picked
        continue
      }

      const picked = await actionsScreen(command, categoryId, chosen.value.item, control)
      if (picked !== null) return picked
    }
  }

  /**
   * Level five: the row itself, or one action on it.
   *
   * An action is named by its title because that is the only stable name an
   * action has (see `parseExtensionPin`), which is why a title containing the
   * delimiter is refused here rather than written into a key that will not
   * parse back.
   */
  const actionsScreen = async (
    command: { id: string; title: string; extension: string },
    categoryId: string,
    item: EnumeratedItem,
    control?: PinControl
  ): Promise<PinDraftEntry | null> => {
    const itemId = item.id
    if (itemId === null) return null
    const itemKey = `extension:${command.id}#${categoryId}:${itemId}`
    const actionKey = (action: string): string => `${itemKey}!${action}`
    const actionTitle = (action: string): string => `${item.title} - ${action}`

    // No "Open <row>" entry, for the same reason the two screens above no longer
    // have one: the row itself is pinnable where you pressed → on it.
    type Row = { readonly kind: 'action'; readonly action: string }
    const keyOf = (row: Row): PinDraftEntry | null => {
      if (row.action.length === 0 || row.action.includes('!')) return null
      return { key: actionKey(row.action), title: actionTitle(row.action), icon: item.icon }
    }
    void itemKey

    for (;;) {
      const chosen = await menu.list<Row>({
        title: item.title,
        subtitle: 'One action on this row, run straight from a key with no window.',
        choices: [
          ...(item.actions.length === 0
            ? [
                {
                  value: { kind: 'action', action: '' } as Row,
                  label: 'This row has no actions',
                  separator: true
                }
              ]
            : item.actions.map((action, index) => ({
                value: { kind: 'action', action } as Row,
                prefix: mark(control, actionKey(action)),
                label: action,
                detail: index === 0 ? 'what Enter does on this row' : 'runs with no window',
                ...(action.includes('!')
                  ? { help: 'Cannot be named by a key: its title contains “!”' }
                  : {})
              })))
        ],
        ...pinRowKeys(control, (value) => keyOf(value as Row), true)
      })

      if (chosen.value === null) return null
      if (chosen.value.action.length === 0) continue

      if (chosen.value.action.includes('!')) {
        await menu.show('That action cannot be named', [
          `“${chosen.value.action}” contains an exclamation mark, which is what`,
          'separates an action from the row it belongs to in a pin key.',
          '',
          'Pin the row itself instead, or ask the plugin author to rename it.'
        ])
        continue
      }
      return {
        key: actionKey(chosen.value.action),
        title: actionTitle(chosen.value.action),
        icon: item.icon
      }
    }
  }

  /**
   * Which command — with "type your own" at the top.
   *
   * It is first because it is the only option that is always available. The list
   * under it is whatever this machine happens to have: seven built-ins and
   * however many extension commands are installed, which on a fresh install is
   * none. A picker whose first row works on an empty install is a picker that
   * never dead-ends.
   *
   * Its result is a `shell:` key rather than an id, because a command line is
   * not something to look up — it *is* the thing to run.
   */
  const pickCommand = async (): Promise<string | null> => {
    const TYPE_ONE = '\u0000shell'
    const installed = pinnableCommands()

    for (;;) {
      const chosen = await menu.list<string>({
        title: 'Which command?',
        choices: [
          {
            value: TYPE_ONE,
            label: 'Type your own command',
            help: 'Any command line - it runs through your shell'
          },
          { value: '\u0000separator', label: '', separator: true },
          ...COMMANDS.map((command) => ({
            value: `command:${command.id}`,
            label: command.title,
            detail: command.id
          })),
          ...installed.map((command) => ({
            value: `extension:${command.id}`,
            label: command.title,
            detail: `${command.extension} · ${command.id}`
          }))
        ]
      })

      if (chosen.value === null) return null
      if (chosen.value !== TYPE_ONE) return chosen.value

      const typed = await menu.prompt({
        title: 'What should it run?',
        help: 'Runs through your shell, so pipes, ~ and $VARIABLES all work.',
        escHint: 'esc back',
        validate: (value) => (value.trim().length === 0 ? 'needs a command' : null)
      })
      // Esc here means "I did not want to type one after all", which is a step
      // back to the list rather than out of the picker.
      if (typed === null) continue
      return `shell:${typed.trim()}`
    }
  }

  /**
   * The shared editor for an ordered list of pins — used by `[search].pins`
   * and by a rule's `first`, which are the same thing with different scope.
   *
   * Both take the same entries: a bare key, or an `{ id, title }` table for a
   * plugin row or one of its actions, whose name exists only while the plugin
   * runs. A rule used to be keys-only, which meant the browser had to offer it
   * less than it offers everywhere else — a difference nobody could see a
   * reason for, because there was not one.
   */
  const pinListScreen = async (
    path: readonly string[],
    title: string
  ): Promise<void> => {
    const entriesOf = (raw: unknown): PinDraftEntry[] => {
      if (!Array.isArray(raw)) return []
      return raw.flatMap((value) => {
        if (typeof value === 'string') return [{ key: value, title: null, icon: null }]
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const { id, title: stored, icon } = value as Record<string, unknown>
          if (typeof id === 'string') {
            return [
              {
                key: id,
                title: typeof stored === 'string' ? stored : null,
                icon: typeof icon === 'string' ? icon : null
              }
            ]
          }
        }
        return []
      })
    }
    const current = (): PinDraftEntry[] => entriesOf(getValue(draft, path))
    const write = (entries: readonly PinDraftEntry[]): void => {
      set(
        path,
        entries.map((entry) => {
          const icon = entry.icon ?? null
          if (entry.title === null && icon === null) return entry.key
          return {
            id: entry.key,
            ...(entry.title === null ? {} : { title: entry.title }),
            ...(icon === null ? {} : { icon })
          }
        })
      )
    }

    const control: PinControl = {
      isPinned: (key) => current().some((entry) => entry.key === key),
      toggle: (key, storedTitle, storedIcon) => {
        const now = current()
        write(
          now.some((entry) => entry.key === key)
            ? now.filter((entry) => entry.key !== key)
            : [...now, { key, title: storedTitle, icon: storedIcon }]
        )
      }
    }

    let at = 0
    for (;;) {
      const result = await menu.list<string>({
        title,
        initialIndex: at,
        hints: ['a add', 'd remove', 'ctrl+↑↓ reorder'],
        choices: () => {
          const entries = current()
          if (entries.length === 0) {
            return [{ value: '', label: 'Nothing here yet', detail: 'Press a to add', separator: true }]
          }
          return entries.map((entry, index) => ({
            value: entry.key,
            prefix: `${String(index + 1)}. `,
            label: entry.title ?? describePin(entry.key),
            detail: entry.key
          }))
        },
        onKey: (key, value, _index, list) => {
          if (key.name === 'a') return 'close'
          if (value === null) return 'ignored'

          if (key.name === 'd' || key.name === 'delete' || key.name === 'backspace') {
            write(current().filter((entry) => entry.key !== value))
            return 'handled'
          }
          if (key.ctrl && (key.name === 'up' || key.name === 'down')) {
            const keys = current().map((entry) => entry.key)
            const moved = reorder(keys, value, key.name === 'up' ? -1 : 1)
            if (moved !== null) {
              const byKey = new Map(current().map((entry) => [entry.key, entry]))
              write(moved.flatMap((entryKey) => byKey.get(entryKey) ?? []))
            }
            list.follow(value)
            return 'handled'
          }
          return 'ignored'
        }
      })

      at = result.index
      // Esc leaves; `a` (and only `a`) comes back as a key-close.
      if (!result.viaKey) return
      const added = await pickPinKey({ pinControl: control })
      if (added !== null && !current().some((entry) => entry.key === added.key)) {
        write([...current(), added])
      }
    }
  }

  const customSearchesScreen = async (): Promise<void> => {
    const list = (): Record<string, unknown>[] => {
      const value = getValue(draft, ['search', 'web_searches'])
      return Array.isArray(value)
        ? value.filter((entry): entry is Record<string, unknown> =>
            typeof entry === 'object' && entry !== null && !Array.isArray(entry)
          )
        : []
    }
    const write = (entries: readonly Record<string, unknown>[]): void => {
      set(['search', 'web_searches'], entries.length === 0 ? undefined : [...entries])
    }

    let at = 0
    for (;;) {
      const result = await menu.list<number>({
        title: 'Custom web searches',
        initialIndex: at,
        subtitle: 'Anything with a query in its URL. Use {} where the query goes.',
        hints: ['a add', 'd remove'],
        choices: () => {
          const entries = list()
          if (entries.length === 0) {
            return [{ value: -1, label: 'None yet', detail: 'Press a to add one', separator: true }]
          }
          return entries.map((entry, index) => ({
            value: index,
            label: String(entry['name'] ?? ''),
            detail: `${String(entry['keyword'] ?? '')} · ${String(entry['url'] ?? '')}`
          }))
        },
        onKey: (key, value) => {
          if (key.name === 'a') return 'close'
          if (value === null || value < 0) return 'ignored'
          if (key.name === 'd' || key.name === 'delete') {
            write(list().filter((_, index) => index !== value))
            return 'handled'
          }
          return 'ignored'
        }
      })

      at = result.index
      if (!result.viaKey) return

      // Four questions, run as a wizard: Esc at the keyword goes back to the
      // name, not back to the list having discarded the site, the URL and the
      // name with it.
      let site = ''
      let confirmed = ''
      let name = ''
      let keyword = ''

      const complete = await wizard([
        // The site first, and a bare domain is enough — everything else is
        // suggested from it. Asking for a name, a keyword and a `{}` template
        // before you can add a web search is three things to get right where one
        // will do.
        async () => {
          const typed = await menu.prompt({
            title: 'Which site?',
            help: 'A domain is enough - “wiki.archlinux.org”. A full template with {} also works.',
            initial: site,
            validate: (value) =>
              normalizeSearchTemplate(value) === null ? 'that is not a web address' : null
          })
          if (typed === null) return 'back'

          // Re-suggesting only when the site changed is what makes going back
          // and forward non-destructive: an edited name survives a return trip
          // through this screen, and a genuinely different site does not inherit
          // the previous one's name.
          if (typed !== site) {
            site = typed
            const url = normalizeSearchTemplate(typed) ?? typed
            const suggested = suggestSearchIdentity(url)
            confirmed = url
            name = suggested.name
            keyword = suggested.keyword
          }
          return 'next'
        },
        // Shown, not assumed. Where the template was guessed rather than known,
        // this is the only chance to notice the site uses `?query=` and not `?q=`.
        async () => {
          const typed = await menu.prompt({
            title: 'Search URL',
            help: 'The query is substituted where {} is. Edit if this site uses a different parameter.',
            initial: confirmed,
            escHint: 'esc back',
            validate: (value) =>
              normalizeSearchTemplate(value)?.includes('{}') === true
                ? null
                : 'needs {} where the query goes'
          })
          if (typed === null) return 'back'
          confirmed = typed
          return 'next'
        },
        async () => {
          const typed = await menu.prompt({
            title: 'What is it called?',
            help: 'Shown in the row: “Search <name> for …”',
            initial: name,
            escHint: 'esc back',
            validate: (value) => (value.trim().length === 0 ? 'needs a name' : null)
          })
          if (typed === null) return 'back'
          name = typed
          return 'next'
        },
        async () => {
          const typed = await menu.prompt({
            title: 'Keyword',
            help: 'Typed as the first word to target this search directly.',
            initial: keyword,
            escHint: 'esc back',
            validate: (value) =>
              value.trim().length === 0
                ? 'needs a keyword'
                : /\s/.test(value.trim())
                  ? 'one word, no spaces'
                  : null
          })
          if (typed === null) return 'back'
          keyword = typed
          return 'next'
        }
      ])
      if (!complete) continue

      // Pin down what is *currently* enabled before adding to it.
      //
      // The config rule is that setting either `engines` or `web_searches`
      // replaces the default selection — so on a config that has never named an
      // engine, adding your own search would silently take Google away. That
      // rule is right for a hand-written file, where writing either key is a
      // deliberate statement; it is wrong for an "add a web search" button, where
      // the only thing the user said was "also this one". Writing the effective
      // list first makes the action purely additive, and leaves a config that
      // says out loud what is enabled.
      if (getValue(draft, ['search', 'engines']) === undefined) {
        set(
          ['search', 'engines'],
          resolved().search.webSearches.value.map((engine) => engine.id)
        )
      }

      write([
        ...list(),
        {
          keyword: keyword.trim(),
          name: name.trim(),
          url: normalizeSearchTemplate(confirmed) ?? confirmed.trim()
        }
      ])
    }
  }

  /**
   * `[keys]` — the panel's own keys, which are the only ones we can bind alone.
   *
   * Deliberately a different screen from Hotkeys, and the difference is not
   * cosmetic. A global hotkey is a chord in someone else's config, so that
   * screen has to plan a file write, show a diff, ask, and then report whether
   * the desktop actually agrees. Nothing here leaves this process: the window
   * has focus, the renderer reads the event, and a save takes effect on the next
   * keystroke. So this screen just edits values — no consent step, nothing to
   * install, and nothing that can silently fail to apply.
   */
  const keysScreen = async (): Promise<void> => {
    const bindings = (action: KeyAction): readonly string[] => {
      const raw = getValue(draft, ['keys', KEY_ACTION_INFO[action].setting])
      if (typeof raw === 'string') return [raw]
      if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === 'string')
      return DEFAULT_KEYS[action].map((shortcut) => formatKeyChord(shortcut))
    }

    const isDefault = (action: KeyAction): boolean =>
      getValue(draft, ['keys', KEY_ACTION_INFO[action].setting]) === undefined

    let at = 0
    for (;;) {
      const result = await menu.list<KeyAction | null>({
        title: 'Panel keys',
        initialIndex: at,
        hints: ['enter change', 'd default'],
        choices: () =>
          KEY_ACTIONS.map((action) => {
            const chords = bindings(action)
            return {
              value: action,
              label: KEY_ACTION_INFO[action].title,
              detail: chords.length === 0 ? 'unbound' : chords.join(' or '),
              ...(isDefault(action) ? {} : { help: 'Changed' })
            }
          }),
        onKey: (key, value) => {
          if (value === null) return 'ignored'
          if (key.name !== 'd' && key.name !== 'delete') return 'ignored'
          set(['keys', KEY_ACTION_INFO[value].setting], undefined)
          return 'handled'
        }
      })

      at = result.index
      const action = result.value
      if (action === null) return

      const chord = await pickChord(action, bindings(action))
      if (chord === null) continue
      // Written as a list only when there is more than one, because
      // `open = "Enter"` is what a person writes and what they expect to read
      // back. Both forms parse.
      set(['keys', KEY_ACTION_INFO[action].setting], chord.length === 1 ? chord[0] : chord)
    }
  }

  /**
   * Build one binding, or several.
   *
   * A list rather than a capture prompt: a terminal cannot see Super at all and
   * reports Ctrl+Enter as plain Enter, so "press the keys you want" would offer
   * to record chords it is unable to hear. The same reason the global hotkey
   * screen picks from a list.
   */
  const pickChord = async (action: KeyAction, current: readonly string[]): Promise<string[] | null> => {
    const KEEP_BOTH = '\u0000both'
    let mods: Modifier[] = []
    let key: string | null = null

    const complete = await wizard([
      async () => {
        const picked = await menu.list<Modifier | null>({
          title: `${KEY_ACTION_INFO[action].title}: which modifiers?`,
          subtitle: 'Space toggles. Enter for none, which is fine here - this key is ours.',
          hints: ['space toggle'],
          // The panel's keys are read from DOM events, where CapsLock is a lock
          // state rather than a key held, so it is a global-hotkey modifier only.
          choices: () =>
            MODIFIERS.filter((modifier) => modifier !== 'capslock').map((modifier) => ({
              value: modifier,
              prefix: mods.includes(modifier) ? `${s.good('[x]')} ` : '[ ] ',
              label: modifierLabel(modifier)
            })),
          onKey: (event, value) => {
            if (value === null || event.name !== 'space') return 'ignored'
            mods = mods.includes(value) ? mods.filter((m) => m !== value) : [...mods, value]
            return 'handled'
          }
        })
        return picked.value === null && mods.length === 0 && picked.viaKey !== true ? 'back' : 'next'
      },
      async () => {
        const chosen = await menu.list<string>({
          title: 'And which key?',
          choices: PANEL_KEYS.map((candidate) => ({
            value: candidate,
            label: panelKeyLabel(candidate),
            prefix: '  '
          }))
        })
        if (chosen.value === null) return 'back'
        key = chosen.value
        return 'next'
      }
    ])

    if (!complete || key === null) return null

    const chord = parseKeyChord([...mods, key].join('+'))
    if (chord === null) return null
    const written = formatKeyChord(chord)

    // A bare character is also typing, so it only acts while the search box is
    // empty. Said here rather than left to be discovered, because a key that
    // works "sometimes" is otherwise indistinguishable from one that is broken.
    if (isTypeable(chord)) {
      await menu.show(`${written} works while the search box is empty`, [
        'A key with no modifier is also a character. Lumanin only treats it as a',
        'binding while nothing has been typed - which is exactly when you are',
        'moving with the arrow keys - and as text once you start typing.',
        '',
        s.dim('Add a modifier, or bind a second chord as well, if you want it always.')
      ])
    }

    // Offered rather than assumed: `secondary` ships as Space *and* Ctrl+Enter
    // precisely so one of them survives typing, and silently dropping the other
    // one is how that stops being true.
    if (current.length > 1 || (current.length === 1 && current[0] !== written)) {
      const keep = await menu.list<string>({
        title: `Replace ${current.join(' or ')}?`,
        choices: [
          { value: written, label: `Just ${written}`, detail: 'Replaces what is there' },
          {
            value: KEEP_BOTH,
            label: `${current.join(', ')}, and ${written}`,
            detail: 'Both work'
          }
        ]
      })
      if (keep.value === null) return null
      if (keep.value === KEEP_BOTH) return [...current, written]
    }

    return [written]
  }

  const aliasesScreen = async (): Promise<void> => {
    const table = (): Record<string, unknown> => {
      const value = getValue(draft, ['aliases'])
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    }

    let at = 0
    for (;;) {
      const result = await menu.list<string>({
        title: 'Aliases',
        initialIndex: at,
        hints: ['a add', 'd remove'],
        choices: () => {
          const entries = Object.entries(table())
          if (entries.length === 0) {
            return [{ value: '', label: 'None yet', detail: 'Press a to add one', separator: true }]
          }
          return entries.map(([alias, value]) => {
            const entry = aliasEntry(value)
            return {
              value: alias,
              label: alias,
              detail: `→ ${entry.title ?? describeTarget(entry.key)}`
            }
          })
        },
        onKey: (key, value) => {
          if (key.name === 'a') return 'close'
          if (value === null || value === '') return 'ignored'
          if (key.name === 'd' || key.name === 'delete') {
            set(['aliases', value], undefined)
            return 'handled'
          }
          return 'ignored'
        }
      })

      at = result.index
      if (!result.viaKey) return

      // Two questions, so Esc at the target picker returns to the alias you just
      // typed rather than throwing it away and starting over.
      let alias = ''
      let entry: PinDraftEntry | null = null

      const complete = await wizard([
        async () => {
          const typed = await menu.prompt({
            title: 'What do you want to type?',
            help: 'Short and memorable - "ff", "cb".',
            initial: alias,
            validate: (value) =>
              value.trim().length === 0
                ? 'needs something to type'
                : /\s/.test(value.trim())
                  ? 'one word, no spaces'
                  : null
          })
          if (typed === null) return 'back'
          alias = typed
          return 'next'
        },
        async () => {
          for (;;) {
            // Plugins included: an alias reaches exactly as deep as a pin does,
            // down to one action on one row — which is the fastest road into a
            // plugin there is, since it needs no key to be free.
            const picked = await pickPinKey()
            if (picked === null) return 'back'
            if (!picked.key.startsWith('web:')) {
              entry = picked
              return 'next'
            }
            await menu.show('Not an alias target', [
              'An alias points at an application, a command, or a command line of',
              'your own. A web search takes a term, so it is reached by its keyword.'
            ])
          }
        }
      ])

      if (!complete || entry === null) continue
      set(['aliases', alias.trim().toLowerCase()], aliasValue(entry))
    }

    /**
     * A picked entry as an `[aliases]` value.
     *
     * A plain application or command stays a bare id — `firefox.desktop`,
     * `hacker-news/frontpage` — because that is what the config documents and what a
     * person types by hand. `shell:` keeps its prefix, since its payload is a
     * command line rather than an id and the two would otherwise be
     * indistinguishable. Anything inside a plugin keeps the whole key, and
     * becomes an `{ id, title }` table when it carries a title, for the same
     * reason a pinned row does: the name exists only while the plugin runs.
     */
    function aliasValue(picked: PinDraftEntry): string | { id: string; title: string } {
      if (picked.title !== null) return { id: picked.key, title: picked.title }
      if (picked.key.startsWith('shell:') || picked.key.includes('#')) return picked.key
      return picked.key.slice(picked.key.indexOf(':') + 1)
    }

    /** A stored value back into the key and title the screens show. */
    function aliasEntry(value: unknown): PinDraftEntry {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const { id, title } = value as Record<string, unknown>
        if (typeof id === 'string') {
          return { key: id, title: typeof title === 'string' ? title : null }
        }
      }
      return { key: String(value), title: null }
    }

    function describeTarget(target: string): string {
      if (isPinKey(target)) return describePin(target)
      return describePin(target.includes('/') ? `command:${target}` : `app:${target}`)
    }
  }

  /** The draft's `[[hotkeys]]` entries, as bind lines the fix planner takes. */
  /** `[file_search].hotkey` as the planner wants it: a chord, or nothing. */
  const draftFileSearchHotkey = (): Hotkey | null => {
    const value = resolved().fileSearch.hotkey.value.trim()
    return value.length === 0 ? null : parseHotkey(value)
  }

  const draftExtraBinds = (): ExtraBind[] => {
    const raw = getValue(draft, ['hotkeys'])
    if (!Array.isArray(raw)) return []
    return raw.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const { bind, target, title } = entry as Record<string, unknown>
      if (typeof bind !== 'string' || typeof target !== 'string') return []
      const hotkey = parseHotkey(bind)
      return hotkey === null ? [] : [{ hotkey, target, title: typeof title === 'string' ? title : null }]
    })
  }

  /** One `[[hotkeys]]` entry as the draft holds it. */
  interface HotkeyDraftEntry {
    readonly bind: string
    readonly target: string
    readonly title: string | null
  }

  const hotkeyEntries = (): HotkeyDraftEntry[] => {
    const raw = getValue(draft, ['hotkeys'])
    if (!Array.isArray(raw)) return []
    return raw.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const { bind, target, title } = entry as Record<string, unknown>
      if (typeof bind !== 'string' || typeof target !== 'string') return []
      return [{ bind, target, title: typeof title === 'string' ? title : null }]
    })
  }

  /** Two key spellings that mean the same combination. */
  const sameKey = (a: string, b: string): boolean => {
    const left = parseHotkey(a)
    const right = parseHotkey(b)
    return left !== null && right !== null && formatHotkey(left) === formatHotkey(right)
  }
  /** The same, with an unparseable spelling matched only by its exact text. */
  const sameChord = (a: string, b: string): boolean => a === b || sameKey(a, b)
  /** The spelling a row is keyed by, so `SUPER, P` and `Super+P` are one row. */
  const canonical = (bind: string): string => {
    const parsed = parseHotkey(bind)
    return parsed === null ? bind : formatHotkey(parsed)
  }

  /**
   * Whether the desktop really binds one chord to one target, read back from
   * its own config. `null` where there is nothing of ours to read: no mark at
   * all there, because "not bound" would be a lie.
   */
  const boundState = (target: string | null, chord: string): 'bound' | 'not-bound' | null => {
    if (deps.readBinds === null) return null
    const wanted = parseHotkey(chord)
    if (wanted === null) return null
    const key = formatHotkey(wanted)
    const live = deps.readBinds()
    return live.some((bind) => bind.target === target && bind.hotkey !== null && formatHotkey(bind.hotkey) === key)
      ? 'bound'
      : 'not-bound'
  }
  const boundMark = (state: 'bound' | 'not-bound' | null): string =>
    state === null ? '' : state === 'bound' ? `${s.good('✔')} ` : `${s.warn('!')} `
  const NOT_BOUND_HELP = 'In your config, not yet on your desktop - press w'

  /**
   * What is in `config.toml` against what is really bound, as three lists.
   *
   * `null` where there is no compositor config of ours to read, which is not
   * the same as "nothing is bound" and must not be drawn as if it were.
   */
  const hotkeySync = (): {
    readonly bound: readonly HotkeyDraftEntry[]
    readonly pending: readonly HotkeyDraftEntry[]
    readonly stale: readonly ManagedBind[]
  } | null => {
    if (deps.readBinds === null) return null
    // The launcher's own binds (file search) live in the same block and are
    // never a `[[hotkeys]]` entry, so they are not "still bound after removal".
    const owned = launcherOwnedTargets()
    const live = deps.readBinds().filter((bind) => bind.target !== null && !owned.has(bind.target))
    const entries = hotkeyEntries()

    const matches = (entry: HotkeyDraftEntry, bind: ManagedBind): boolean =>
      bind.target === entry.target && sameKey(bind.keyText, entry.bind)

    return {
      bound: entries.filter((entry) => live.some((bind) => matches(entry, bind))),
      pending: entries.filter((entry) => !live.some((bind) => matches(entry, bind))),
      stale: live.filter((bind) => !entries.some((entry) => matches(entry, bind)))
    }
  }

  /** "2 not bound · 1 stale", for the main menu's Hotkeys row. */
  const hotkeySummary = (): string | null => {
    const sync = hotkeySync()
    if (sync === null) return null
    const parts: string[] = []
    if (sync.pending.length > 0) parts.push(`${String(sync.pending.length)} not bound`)
    if (sync.stale.length > 0) parts.push(`${String(sync.stale.length)} still bound after removal`)
    return parts.length === 0 ? null : parts.join(' · ')
  }

  /**
   * `[[hotkeys]]` — a key per thing.
   *
   * Each entry binds one combination straight to one target: an app, a command,
   * a plugin category, one row, or one action on it. The bind is real — the same
   * compositor block the main hotkey lives in, written diff-first with consent —
   * and it runs `lumanin open '<target>'`, so it works wherever the main hotkey
   * does and degrades exactly the same way where no bindable config exists.
   *
   * Which is precisely why this screen reads the compositor back rather than
   * listing the draft. The key fires because of a line in `hyprland.conf`, not
   * because of a line in `config.toml`: delete the entry here, decline the write
   * that follows, and the key keeps working. A list that showed only the draft
   * would report that removal as done — the user's own words for the bug this
   * fixes were "the hotkey still works but removed from the list". So every row
   * says which of the two it is in, and nothing is ever described as removed
   * until the file that binds it says so too.
   */
  const hotkeysScreen = async (): Promise<void> => {
    const write = (list: readonly HotkeyDraftEntry[]): void => {
      set(
        ['hotkeys'],
        list.length === 0
          ? undefined
          : list.map((entry) => ({
              bind: entry.bind,
              target: entry.target,
              ...(entry.title === null ? {} : { title: entry.title })
            }))
      )
    }

    /** A row is either a config entry or a bind that outlived one. */
    type Row =
      | { readonly kind: 'entry'; readonly bind: string; readonly chord: string }
      | { readonly kind: 'stale' }

    // Two keys close this list, and what happens next depends on which.
    let requested: 'add' | 'write' | null = null
    // Whether this visit changed anything, which is the difference between
    // offering the compositor write on the way out and nagging about a
    // difference the screen has already drawn.
    let touched = false
    let at = 0
    // Leaving after a change, with the two still out of step, offers the write —
    // rather than letting the screen close on a difference nobody was told
    // about. Only after a change: a pre-existing difference is already drawn on
    // every row and named on the main menu, and a prompt on the way out of a
    // screen somebody only looked at is a prompt they learn to dismiss.
    const offerIfOutOfStep = async (): Promise<void> => {
      if (!touched) return
      const sync = hotkeySync()
      if (sync !== null && (sync.pending.length > 0 || sync.stale.length > 0)) await writeBinds()
    }
    try {
      for (;;) {
        const result = await menu.list<Row>({
          title: 'Plugin hotkeys',
          subtitle:
            deps.readBinds === null
              ? 'A key straight into one of your plugins. This desktop has no config we can bind in.'
              : 'A key straight into one of your plugins. The mark is what your desktop really binds.',
          initialIndex: at,
          hints: deps.readBinds === null ? ['a add', 'd remove'] : ['a add', 'd remove', 'w write binds'],
          choices: () => {
            const entries = hotkeyEntries()
            const sync = hotkeySync()

            const rows =
              entries.length === 0
                ? [
                    {
                      value: { kind: 'entry', bind: '', chord: '' } as Row,
                      label: 'None yet',
                      detail: 'Press a to add one',
                      separator: true
                    }
                  ]
                : entries.map((entry) => {
                    const bound =
                      sync === null
                        ? null
                        : sync.bound.some((row) => row.target === entry.target && sameChord(row.bind, entry.bind))
                    return {
                      value: { kind: 'entry', bind: entry.bind, chord: canonical(entry.bind) } as Row,
                      prefix: bound === null ? '' : bound ? `${s.good('✔')} ` : `${s.warn('!')} `,
                      label: entry.bind,
                      detail: entry.title ?? describePin(entry.target),
                      ...(bound === false
                        ? { help: 'In your config, not yet on your desktop - press w' }
                        : {})
                    }
                  })

            // The other direction, and the one that used to be invisible: a key
            // the config no longer mentions, which the compositor still fires.
            const stale = sync?.stale ?? []
            if (stale.length === 0) return rows
            return [
              ...rows,
              { value: { kind: 'stale' } as Row, label: '', separator: true },
              ...stale.map((bind) => ({
                value: { kind: 'stale' } as Row,
                prefix: `${s.bad('✘')} `,
                label: bind.hotkey === null ? bind.keyText : formatHotkey(bind.hotkey),
                detail: `${describePin(bind.target ?? '')} - still bound`,
                help: `Removed from your config but still in ${bind.path} - press d to clear it`
              }))
            ]
          },
          onKey: (key, value) => {
            if (key.name === 'a') {
              requested = 'add'
              return 'close'
            }
            if (key.name === 'w' && deps.readBinds !== null) {
              requested = 'write'
              return 'close'
            }
            if (key.name !== 'd' && key.name !== 'delete' && key.name !== 'backspace') return 'ignored'
            // Remove on a row that is *already* out of the config is not a second
            // removal — there is nothing left here to remove. What the user is
            // still looking at is the compositor's copy, and the only thing that
            // clears that is the file write. So the same key does the meaningful
            // thing rather than nothing: it is the one this row's help already
            // names. Silence here was the reported bug — the footer offers
            // `d remove`, the cursor lands on a stale row the moment the last
            // entry goes, and the advertised key then did nothing at all.
            if (value !== null && value.kind === 'stale') {
              requested = 'write'
              return 'close'
            }
            if (value === null || value.kind !== 'entry' || value.bind.length === 0) return 'ignored'
            write(hotkeyEntries().filter((entry) => !sameChord(entry.bind, value.bind)))
            touched = true
            return 'handled'
          }
        })

        at = result.index
        if (!result.viaKey) break

        // `w` — write the block now, from wherever the cursor was.
        if (requested === 'write') {
          requested = null
          await writeBinds()
          continue
        }
        requested = null

        let picked: PinDraftEntry | null = null
        const complete = await wizard([
          async () => {
            // Plugins and nothing else. A launcher that offers to bind a system
            // key to *any* application is a launcher that has quietly appointed
            // itself your desktop's shortcut editor — your desktop already has
            // one, it is the one you know, and its binds do not vanish when this
            // application is uninstalled. What only we can bind is what only we
            // can open: a plugin's command, a category inside it, one row, or one
            // action on one row.
            const chosen = await pluginsScreen()
            if (chosen === null) return 'back'
            picked = chosen
            return 'next'
          },
          async () => {
            const hotkey = await buildHotkey(null)
            if (hotkey === null || picked === null) return 'back'
            const bind = formatHotkey(hotkey)
            write([
              ...hotkeyEntries().filter((entry) => !sameChord(entry.bind, bind)),
              { bind, target: picked.key, title: picked.title }
            ])
            touched = true
            return 'next'
          }
        ])
        void complete
      }

    } catch (error) {
      // Esc from inside the list unwinds past here, and used to skip the offer:
      // `config.toml` was left naming a key the desktop does not bind. The
      // offer runs on every exit; Esc at the offer itself means "no".
      if (!isAbandoned(error)) throw error
      try {
        await offerIfOutOfStep()
      } catch (inner) {
        if (!isAbandoned(inner)) throw inner
      }
      throw error
    }
    await offerIfOutOfStep()
  }

  /**
   * Write the compositor block from the draft's binds, diff first.
   *
   * Declining is a real answer and leaves both files exactly as they were —
   * which the hotkeys screen then keeps saying, rather than redrawing as done.
   */
  const writeBinds = async (): Promise<void> => {
    const main = parseHotkey(resolved().general.hotkey.value)
    if (main === null) return
    await offerBind(main, 'block')
  }

  /**
   * The categories, ordered. Reorder only — there is no "off".
   *
   * The difference from `orderScreen` is the whole design: a result *group* can
   * be switched off because something else will still answer the query, but
   * every file is in exactly one of these, so hiding a category would be hiding
   * files with no way to tell that it had happened. Ctrl+↑↓ and nothing else.
   */
  const fileOrderScreen = async (): Promise<void> => {
    const current = (): readonly FileCategory[] => {
      const raw = getValue(draft, ['file_search', 'order'])
      if (Array.isArray(raw)) {
        return completeFileOrder(raw.filter((entry): entry is string => typeof entry === 'string'))
      }
      return resolved().fileSearch.order.value
    }

    await menu.list<FileCategory>({
      title: 'File type order',
      subtitle: 'Which kind of file wins when names tie.',
      hints: ['ctrl+↑↓ reorder'],
      choices: () =>
        current().map((category) => ({
          value: category,
          label: FILE_CATEGORY_TITLES[category],
          detail: FILE_CATEGORY_HINTS[category]
        })),
      onKey: (key, value, _index, list) => {
        if (value === null) return 'ignored'
        if (!key.ctrl || (key.name !== 'up' && key.name !== 'down')) return 'ignored'
        const moved = reorder(current(), value, key.name === 'up' ? -1 : 1)
        if (moved !== null) set(['file_search', 'order'], moved)
        list.follow(value)
        return 'handled'
      }
    })
  }

  /**
   * File search: a search of its own, and therefore a section of its own.
   *
   * It is the one plugin that never appears at the root — a filesystem cannot be
   * ranked against a few thousand application names — so the key below is not a
   * convenience, it is the only door. That is why it sits here rather than among
   * the `[[hotkeys]]` a user writes: turning it off turns the feature off, and a
   * screen has to be able to say so.
   */
  const fileSearchScreen = async (): Promise<void> => {
    let at = 0
    for (;;) {
      const choice = await menu.list<() => Promise<void>>({
        title: 'File Search',
        initialIndex: at,
        choices: () => {
          const now = resolved()
          return [
            {
              value: () => hotkeyScreen(['file_search', 'hotkey']),
              prefix: boundMark(boundState(`extension:${FILE_SEARCH_COMMAND}`, now.fileSearch.hotkey.value)),
              label: 'Hotkey',
              detail: now.fileSearch.hotkey.value.length === 0 ? 'none - unreachable' : now.fileSearch.hotkey.value,
              ...(now.fileSearch.hotkey.value.length === 0
                ? { help: 'Without a key, file search is unreachable' }
                : boundState(`extension:${FILE_SEARCH_COMMAND}`, now.fileSearch.hotkey.value) === 'not-bound'
                  ? { help: NOT_BOUND_HELP }
                  : {})
            },
            {
              value: fileOrderScreen,
              label: 'File type order',
              detail: now.fileSearch.order.value.map((category) => FILE_CATEGORY_TITLES[category]).join(', ')
            },
            {
              value: async () => {
                await editSetting(FILE_SEARCH_HIDE_ON_OPEN)
              },
              label: FILE_SEARCH_HIDE_ON_OPEN.label,
              detail: now.fileSearch.hideOnOpen.value ? 'yes' : 'no - stays open'
            }
          ]
        }
      })
      at = choice.index
      if (choice.value === null) return
      await choice.value()
    }
  }

  const searchScreen = async (): Promise<void> => {
    let at = 0
    for (;;) {
      const choice = await menu.list<() => Promise<void>>({
        title: 'Search',
        initialIndex: at,
        choices: () => {
          const now = resolved()
          return [
            {
              value: async () => {
                await editSetting(GLOBAL_HOTKEY)
              },
              prefix: boundMark(boundState(null, now.general.hotkey.value)),
              label: 'Hotkey',
              detail: now.general.hotkey.value,
              ...(boundState(null, now.general.hotkey.value) === 'not-bound' ? { help: NOT_BOUND_HELP } : {})
            },
            {
              value: enginesScreen,
              label: 'Web search engines',
              detail:
                now.search.webSearches.value.length === 0
                  ? 'none - no search will be offered'
                  : now.search.webSearches.value.map((engine) => engine.name).join(', ')
            },
            {
              value: () => orderScreen(['search', 'order'], 'Result order'),
              label: 'Result order',
              detail: now.search.fallbackOrder.value.join(', ')
            },
            {
              value: () =>
                pinListScreen(['search', 'pins'], 'Pins'),
              label: 'Pins',
              detail:
                now.search.pins.value.length === 0
                  ? 'none'
                  : now.search.pins.value.map((entry) => entry.title ?? describePin(entry.key)).join(', ')
            },
            {
              value: customSearchesScreen,
              label: 'Custom web searches',
              detail: `${String(
                (getValue(draft, ['search', 'web_searches']) as unknown[] | undefined)?.length ?? 0
              )} defined`
            },
            {
              value: async () => {
                await editSetting(HABIT_SETTING)
              },
              label: HABIT_SETTING.label,
              detail: habitLabel(now.search.frecencyWeight.value)
            }
          ]
        }
      })
      at = choice.index
      if (choice.value === null) return
      await choice.value()
    }
  }

  // ─── main menu ─────────────────────────────────────────────────────────────

  const leave = async (): Promise<void> => {
    await applying
    if (commentBackup !== null) {
      await menu.show('Comments were not preserved', [
        'TOML parsers drop comments, and this rewrite was no exception.',
        `They are in ${commentBackup}`
      ])
    }
    if (restartDetail === null) return
    const lines = [`${s.warn('!')} ${restartDetail}`]
    if (deps.restartDaemon === null) {
      await menu.show('Not applied yet', lines)
      return
    }
    await menu.show('Not applied yet', lines, 'any key to continue')
    if (!(await menu.confirm('Restart it now?'))) return
    const ok = await deps.restartDaemon()
    await menu.show(
      ok ? 'Restarted' : 'Could not restart',
      ok
        ? ['Every setting is now in effect.']
        : ['Start it yourself with `lumanin start`, or press your hotkey.']
    )
  }

  let at = 0
  for (;;) {
    const choice = await menu.list<string>({
      title: `${APP_DISPLAY_NAME} - configuration`,
      subtitle: deps.configFile,
      escHint: 'esc quit',
      // The one screen with nothing behind it: Esc leaves rather than unwinding
      // to a menu it is already on.
      escape: 'close',
      initialIndex: at,
      choices: () => {
        // The compositor's state, not the draft's, for the same reason the
        // screen itself reports it: a key that is still bound after being
        // removed here is exactly what nobody was being told.
        const outOfStep = hotkeySummary()
        const now = resolved()
        return [
        { value: 'general', label: 'General' },
        { value: 'appearance', label: 'Appearance' },
        {
          value: 'search',
          prefix: boundMark(boundState(null, now.general.hotkey.value)),
          label: 'Search',
          detail: now.general.hotkey.value
        },
        {
          value: 'file-search',
          prefix: boundMark(boundState(`extension:${FILE_SEARCH_COMMAND}`, now.fileSearch.hotkey.value)),
          label: 'File Search',
          detail: now.fileSearch.hotkey.value.length === 0 ? 'no key' : now.fileSearch.hotkey.value
        },
        { value: 'aliases', label: 'Aliases' },
        {
          value: 'keys',
          label: 'Panel keys'
        },
        {
          value: 'hotkeys',
          label: 'Plugin hotkeys',
          ...(outOfStep === null
            ? {}
            : { detail: outOfStep, help: 'Your config and your desktop disagree - open this and press w' })
        },
        { value: '', label: '', separator: true },
        { value: 'review', label: 'Show config.toml' },
        { value: 'quit', label: 'Quit' },
        { value: 'issues', label: 'Report an issue', detail: ISSUES_URL }
        ]
      }
    })

    at = choice.index
    const picked = choice.value ?? 'quit'

    // Esc anywhere below this line throws its way back here, which is the whole
    // point: a hotkey half-created, a pin half-chosen, a search whose URL has
    // been typed but not named — all of it is dropped, unwritten, and the menu
    // redraws. Anything already *finished* is in the draft and stays there,
    // because finishing is what wrote it.
    try {
      if (picked === 'general') await settingsScreen('General', GENERAL)
    else if (picked === 'appearance') await settingsScreen('Appearance', APPEARANCE)
    else if (picked === 'search') await searchScreen()
    else if (picked === 'file-search') await fileSearchScreen()
    else if (picked === 'aliases') await aliasesScreen()
    else if (picked === 'keys') await keysScreen()
    else if (picked === 'hotkeys') await hotkeysScreen()
    else if (picked === 'issues') {
      // xdg-open is what every desktop has; the URL is on the row either way,
      // so a machine without a browser handler still gets somewhere to paste.
      const opened = await new Promise<boolean>((settle) => {
        try {
          const child = spawn('xdg-open', [ISSUES_URL], { detached: true, stdio: 'ignore' })
          child.on('error', () => settle(false))
          child.on('exit', (code) => settle(code === 0))
          child.unref()
        } catch {
          settle(false)
        }
      })
      menu.say(opened ? `Opened ${ISSUES_URL}` : `Could not open a browser. The issues are at ${ISSUES_URL}`)
    } else if (picked === 'review') {
      const text = render(draft)
      await menu.show(
        'config.toml',
        text.length === 0 ? [s.dim('(empty - every setting is at its default)')] : text.split('\n')
      )
    } else {
      await leave()
      menu.say('')
      return finish(0)
    }
    } catch (error) {
      if (!isAbandoned(error)) throw error
    }
  }
}

/** Backups and temp files are stamped so two runs cannot collide. */
const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')
