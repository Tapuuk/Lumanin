import { readFileSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  FOREIGN_PLUGIN_MESSAGE,
  buildExtension,
  foreignManifest,
  thirdPartyDependencies
} from '../main/extensions/build'
import {
  MANIFEST_BASENAME,
  scanAllExtensions,
  type ExtensionIndex,
  type InstalledExtension
} from '../main/extensions/registry'
import { fetchOfficialIndex, type OfficialPlugin } from '../store/official'
import { fetchPlugin, writeProvenance } from '../store/plugin'
import { parsePluginSource } from '../store/plugin-source'
import { parseManifest } from '../shared/extension'
import { getValue, readConfigDocument, setValue, writeConfigDocument } from '../node/config-file'
import { isExtensionCommandEnabled } from '../shared/config'
import type { PreferenceSpec } from '../shared/extension'
import { APP_DISPLAY_NAME, APP_ID } from '../shared/identity'
import { isAbandoned, Menu, Screen, type Term } from './tui'

/**
 * `lumanin plugins` — the installed plugins, as a menu.
 * (`store`, the original spelling, prints this name now.)
 *
 * Three verbs: remove, disable, configure. Installing lives in
 * `lumanin plugin-install`; the last two are the ones an install command cannot
 * do, and they are the reason this exists as a screen rather than as more flags:
 *
 *  - **disable** keeps the code and the data and only stops the commands
 *    appearing. Uninstalling to hide something costs you its token, its cache
 *    and its history, which is a high price for "not right now".
 *  - **configure** reaches a plugin's own preferences and its individual
 *    commands. A plugin with six commands where you want two is normal.
 *
 * (This screen once also browsed a curated catalogue of Raycast extensions,
 * installed from a pinned tree. That whole idea went when running Raycast
 * extensions was dropped, and what remains is the half that was always ours:
 * managing what is installed.)
 *
 * Everything here writes immediately rather than collecting a draft the way
 * `lumanin config` does. A screen where "Remove" needs a later Save is a screen
 * that will be half-saved; and unlike a settings file, every action here is
 * already a discrete, reversible thing.
 */

export interface PluginsUiDeps {
  readonly term: Term
  readonly env: Readonly<Record<string, string | undefined>>
  readonly configFile: string
  readonly extensionsDir: string
  /** Where the plugins that ship inside the application live. */
  readonly bundledDir: string
  /** `paths.data` — where `extensions.db` lives. */
  readonly dataDir: string
  /** `paths.cache` — where the store's fetches land. */
  readonly cacheDir: string
  /** Tell a running daemon to re-scan. `null` when none is running. */
  readonly reload: (() => Promise<boolean>) | null
}

/** One installed plugin. */
interface Row {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly installed: InstalledExtension
}

export async function runPluginsUi(deps: PluginsUiDeps): Promise<number> {
  const screen = new Screen(deps.term)
  const menu = new Menu(deps.term, screen, deps.env)
  const s = menu.styles

  const document = readConfigDocument(deps.configFile)
  if (document.parseError !== null) {
    // Enabling and disabling writes this file, and rewriting from an empty
    // document would silently discard everything it says. Same rule as `config`.
    menu.say(
      `\n  ${s.bad('Your config file does not parse, so nothing here could be saved.')}\n` +
        `  ${document.path}\n  ${s.dim(document.parseError)}\n\n` +
        `  Fix it by hand, then run this again.\n`
    )
    menu.close()
    return 1
  }

  const draft: Record<string, unknown> = structuredClone(document.data)

  const scan = (): ExtensionIndex =>
    scanAllExtensions({
      extensionsDir: deps.extensionsDir,
      bundledDir: deps.bundledDir,
      dataDir: deps.dataDir
    })
  let index: ExtensionIndex = scan()
  const rescan = (): void => {
    index = scan()
  }

  // ─── the disabled list ─────────────────────────────────────────────────────

  const disabled = (): string[] => {
    const value = getValue(draft, ['extensions', 'disabled'])
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  }

  /**
   * Write the list and apply it, in that order.
   *
   * An empty list is written as *absent* rather than as `[]`, so a config that
   * never disabled anything stays a config that says nothing about extensions.
   */
  const writeDisabled = async (entries: readonly string[]): Promise<void> => {
    setValue(draft, ['extensions', 'disabled'], entries.length === 0 ? undefined : [...new Set(entries)])
    writeConfigDocument(document, draft, stamp())
    if (deps.reload !== null) await deps.reload()
  }

  const isEnabled = (id: string): boolean => isExtensionCommandEnabled(disabled(), id)

  const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
    const now = disabled().filter((entry) => entry !== id)
    // Turning an extension back on also clears its commands' own entries: a
    // switch that leaves half the commands hidden for reasons the user cannot
    // see from this screen is a switch that appears not to work.
    const cleared = enabled ? now.filter((entry) => !entry.startsWith(`${id}/`)) : now
    await writeDisabled(enabled ? cleared : [...cleared, id])
  }

  // ─── rows ──────────────────────────────────────────────────────────────────

  const rows = (): readonly Row[] =>
    index.extensions.map((entry) => ({
      name: entry.manifest.name,
      title: entry.manifest.title,
      description: entry.manifest.description,
      installed: entry
    }))

  const marker = (row: Row): string =>
    isEnabled(row.name) ? `${s.good('[x]')} ` : `${s.warn('[–]')} `

  const state = (row: Row): string => {
    // "built in" first, because it is the answer to the question somebody has
    // when they find a plugin in this list they do not remember installing.
    const origin = row.installed.bundled ? ' · built in' : ''
    if (!isEnabled(row.name)) return `disabled${origin}`
    const commands = index.commands.filter((command) => command.extension === row.installed)
    const on = commands.filter((command) => isEnabled(command.id)).length
    return (
      (on === commands.length
        ? `${String(on)} command${on === 1 ? '' : 's'}`
        : `${String(on)} of ${String(commands.length)} commands`) + origin
    )
  }

  // ─── remove ────────────────────────────────────────────────────────────────

  const remove = async (row: Row): Promise<void> => {
    if (!(await menu.confirm(`Remove ${row.title}?`, 'The code is deleted; its stored data is kept.'))) {
      return
    }

    const directory = join(deps.extensionsDir, row.name)
    // `basename` rather than a path check: the name is a *name*, and one that
    // resolves anywhere but directly inside the extensions directory is not one.
    if (basename(directory) !== row.name) {
      await menu.show('Refused', ['That extension name does not name a directory we own.'])
      return
    }
    rmSync(directory, { recursive: true, force: true })

    // Its entries in the disabled list go with it, or reinstalling would bring
    // back a state the user set for something that no longer existed.
    await writeDisabled(
      disabled().filter((entry) => entry !== row.name && !entry.startsWith(`${row.name}/`))
    )

    let forgot = false
    if (await menu.confirm(`Also forget what ${row.title} stored?`, 'Its settings, cache and history.')) {
      forgot = await forgetStoredData(deps.dataDir, row.name)
    }

    rescan()
    if (deps.reload !== null) await deps.reload()
    await menu.show(`Removed ${row.title}`, [
      forgot ? 'Its code and its stored data are gone.' : 'Its stored data was kept, in case you reinstall it.'
    ])
  }

  // ─── one extension ─────────────────────────────────────────────────────────

  const commandsScreen = async (row: Row): Promise<void> => {
    await menu.list<string>({
      title: `${row.title} — commands`,
      subtitle: 'Space turns one off. It stays installed.',
      hints: ['space toggle'],
      choices: () => {
        const commands = index.commands.filter((command) => command.extension === row.installed)
        if (commands.length === 0) {
          return [{ value: '', label: 'No runnable commands', separator: true }]
        }
        return commands.map((command) => ({
          value: command.id,
          prefix: isEnabled(command.id) ? `${s.good('[x]')} ` : '[ ] ',
          label: command.spec.title,
          detail: command.id,
          ...(command.spec.description === undefined ? {} : { help: command.spec.description })
        }))
      },
      onKey: (key, value, _index, list) => {
        if (value === null || value === '' || key.name !== 'space') return 'ignored'
        void setEnabled(value, !isEnabled(value))
        list.follow(value)
        return 'handled'
      }
    })
  }

  const preferencesScreen = async (row: Row): Promise<void> => {
    const store = await openStore(deps.dataDir)
    if (store === null) {
      await menu.show('Preferences are unavailable', [
        'The extension database could not be opened, so there is nowhere to save',
        'a preference. `lumanin doctor` prints the paths it uses.'
      ])
      return
    }

    try {
      let at = 0
      for (;;) {
        const chosen = await menu.list<Slot>({
          title: `${row.title} — preferences`,
          initialIndex: at,
          hints: ['enter edit'],
          choices: () => {
            const slots = preferenceSlots(row)
            if (slots.length === 0) {
              return [
                {
                  value: { spec: { name: '', type: 'textfield', required: false }, command: '' },
                  label: 'This extension declares no preferences',
                  separator: true
                }
              ]
            }
            return slots.map((slot) => ({
              value: slot,
              label: slotTitle(slot),
              detail: shownValue(slot, store.preferences(row.name, slot.command)[slot.spec.name]),
              ...(slot.spec.description === undefined ? {} : { help: slot.spec.description })
            }))
          }
        })
        at = chosen.index
        if (chosen.value === null || chosen.value.spec.name === '') return
        await editPreference(row, chosen.value, store)
      }
    } finally {
      store.close()
    }
  }

  /** Every preference an extension declares, extension-level ones first. */
  const preferenceSlots = (row: Row): readonly Slot[] => {
    const extension = row.installed
    const slots: Slot[] = extension.manifest.preferences.map((spec) => ({ spec, command: '' }))
    for (const command of index.commands.filter((entry) => entry.extension === extension)) {
      for (const spec of command.spec.preferences) {
        slots.push({ spec, command: command.spec.name, commandTitle: command.spec.title })
      }
    }
    return slots
  }

  const editPreference = async (row: Row, slot: Slot, store: PreferenceStore): Promise<void> => {
    const current = store.preferences(row.name, slot.command)[slot.spec.name]

    if (slot.spec.type === 'checkbox') {
      store.setPreference(row.name, slot.command, slot.spec.name, !(current === true))
      if (deps.reload !== null) await deps.reload()
      return
    }

    const options = slot.spec.data ?? []
    if (slot.spec.type === 'dropdown' && options.length > 0) {
      const chosen = await menu.list<string>({
        title: slotTitle(slot),
        ...(slot.spec.description === undefined ? {} : { subtitle: slot.spec.description }),
        choices: options.map((option) => ({
          value: option.value,
          label: option.title,
          detail: option.value,
          prefix: current === option.value ? '> ' : '  '
        }))
      })
      if (chosen.value === null) return
      store.setPreference(row.name, slot.command, slot.spec.name, chosen.value)
      if (deps.reload !== null) await deps.reload()
      return
    }

    const secret = slot.spec.type === 'password'
    const typed = await menu.prompt({
      title: slotTitle(slot),
      help: `${slot.spec.description ?? slot.spec.placeholder ?? ''}  ·  ${
        slot.spec.required ? 'required' : 'optional'
      }`,
      // A stored secret is never re-shown. Editing one replaces it; there is no
      // reason for a launcher to print an API key back at a terminal, and the
      // terminal keeps its scrollback long after this screen is gone.
      initial: secret ? '' : typeof current === 'string' ? current : '',
      mask: secret,
      validate: (value) =>
        slot.spec.required && value.trim().length === 0 ? 'this one is required' : null
    })
    if (typed === null) return
    store.setPreference(row.name, slot.command, slot.spec.name, typed.trim())
    if (deps.reload !== null) await deps.reload()
  }

  // ─── aliases ───────────────────────────────────────────────────────────────

  /**
   * The `[aliases]` entries pointing at this plugin.
   *
   * A value is a bare command id, or the `{ id, title }` table `lumanin config`
   * writes for anything deeper — a category, a row, one action on a row. Both
   * are listed here, because "which of my aliases open this plugin" has the
   * same answer either way.
   */
  const aliasesFor = (row: Row): { word: string; target: string; title: string | null }[] => {
    const section = getValue(draft, ['aliases'])
    if (typeof section !== 'object' || section === null || Array.isArray(section)) return []

    return Object.entries(section as Record<string, unknown>).flatMap(([word, value]) => {
      const target =
        typeof value === 'string'
          ? value
          : typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
            ? (value as { id: string }).id
            : null
      if (target === null) return []

      const title =
        typeof value === 'object' && value !== null && typeof (value as { title?: unknown }).title === 'string'
          ? (value as { title: string }).title
          : null

      const points = target.startsWith(`${row.name}/`) || target.startsWith(`extension:${row.name}/`)
      return points ? [{ word, target, title }] : []
    })
  }

  const writeAlias = async (word: string, target: string | undefined): Promise<void> => {
    setValue(draft, ['aliases', word], target)
    writeConfigDocument(document, draft, stamp())
    if (deps.reload !== null) await deps.reload()
  }

  /**
   * An alias is the fastest road into a plugin: type the word, Enter, you are
   * in. It targets a *command* — the launcher's `[aliases]` table takes bare
   * ids — which is why this lives here, on the plugin, and not per category.
   */
  const aliasScreen = async (row: Row): Promise<void> => {
    const commands = index.commands.filter((command) => command.extension === row.installed)

    const add = async (): Promise<void> => {
      let target = commands[0]?.id ?? null
      if (commands.length > 1) {
        const chosen = await menu.list<string>({
          title: 'Which command should it open?',
          choices: commands.map((command) => ({ value: command.id, label: command.spec.title }))
        })
        if (chosen.value === null) return
        target = chosen.value
      }
      if (target === null) return

      const word = await menu.prompt({
        title: 'What do you want to type?',
        help: 'Short and memorable — "pw", "dc". Typed exactly, it opens this first.',
        validate: (value) =>
          value.trim().length === 0
            ? 'needs something to type'
            : /\s/.test(value.trim())
              ? 'one word, no spaces'
              : null
      })
      if (word === null) return
      const normalized = word.trim().toLowerCase()

      const section = getValue(draft, ['aliases'])
      const existing =
        typeof section === 'object' && section !== null && !Array.isArray(section)
          ? (section as Record<string, unknown>)[normalized]
          : undefined
      if (typeof existing === 'string' && existing !== target) {
        const replace = await menu.confirm(
          `“${normalized}” already opens something else`,
          `It points at ${existing}. Point it here instead?`
        )
        if (!replace) return
      }
      await writeAlias(normalized, target)
    }

    let at = 0
    for (;;) {
      const result = await menu.list<string>({
        title: `${row.title} — alias`,
        initialIndex: at,
        hints: ['a add', 'd remove'],
        choices: () => {
          const aliases = aliasesFor(row)
          if (aliases.length === 0) {
            return [{ value: '', label: 'No alias yet', detail: 'Press a to add one', separator: true }]
          }
          return aliases.map((alias) => ({
            value: alias.word,
            label: alias.word,
            detail:
              alias.title ??
              commands.find((command) => command.id === alias.target)?.spec.title ??
              alias.target
          }))
        },
        onKey: (key, value) => {
          if (key.name === 'a') return 'close'
          if (value === null || value === '') return 'ignored'
          if (key.name === 'd' || key.name === 'delete' || key.name === 'backspace') {
            void writeAlias(value, undefined)
            return 'handled'
          }
          return 'ignored'
        }
      })

      at = result.index
      if (!result.viaKey) return
      await add()
    }
  }

  const entryScreen = async (row: Row): Promise<void> => {
    let at = 0
    for (;;) {
      const fresh = rows().find((candidate) => candidate.name === row.name)
      if (fresh === undefined) return

      const commands = index.commands.filter((command) => command.extension === fresh.installed)
      const preferences = preferenceSlots(fresh)

      const chosen = await menu.list<string>({
        title: fresh.title,
        subtitle: fresh.description,
        initialIndex: at,
        // `Remove` last and below a rule: the highlight opens on the top row,
        // and the top row of a plugin's screen must never be the verb that
        // deletes it.
        choices: () => [
          {
            value: 'enabled',
            label: 'Enabled',
            detail: isEnabled(fresh.name) ? s.good('yes') : s.warn('no')
          },
          {
            value: 'commands',
            label: 'Commands',
            detail: `${String(commands.filter((command) => isEnabled(command.id)).length)} of ${String(commands.length)} on`
          },
          {
            value: 'preferences',
            label: 'Preferences',
            detail:
              preferences.length === 0
                ? 'none to set'
                : `${String(preferences.length)} setting${preferences.length === 1 ? '' : 's'}`
          },
          {
            value: 'alias',
            label: 'Alias',
            detail:
              aliasesFor(fresh).length === 0
                ? 'none — a word that opens this instantly'
                : aliasesFor(fresh)
                    .map((alias) => alias.word)
                    .join(', '),
            help: 'Typed exactly in the search bar, it puts this plugin first'
          },
          { value: '\u0000separator', label: '', separator: true },
          // No Remove for a plugin that ships inside the application: it lives
          // in the application directory and the next upgrade would put it
          // back. Offering the verb anyway would be offering something that
          // does not stick. Turning it off is the real answer, and it is the
          // row above.
          ...(fresh.installed.bundled
            ? []
            : [{ value: 'remove', label: 'Remove', detail: 'Keeps its stored data' }]),
          { value: '\u0000separator2', label: '', separator: true },
          {
            value: '\u0000note',
            label: fresh.installed.bundled
              ? 'Ships with Lumanin. Turn it off above, or install your own plugin of the same name to replace it.'
              : fresh.installed.source != null
                ? `From ${fresh.installed.source.label} @ ${fresh.installed.source.commit.slice(0, 12)} — reviewed by nobody`
                : 'Installed from a local directory',
            separator: true
          }
        ]
      })

      at = chosen.index
      if (chosen.value === null) return
      if (chosen.value === 'remove') {
        await remove(fresh)
        return
      } else if (chosen.value === 'enabled') await setEnabled(fresh.name, !isEnabled(fresh.name))
      else if (chosen.value === 'commands') await commandsScreen(fresh)
      else if (chosen.value === 'preferences') await preferencesScreen(fresh)
      else if (chosen.value === 'alias') await aliasScreen(fresh)
    }
  }

  // ─── the plugin store ──────────────────────────────────────────────────────

  /**
   * The official collection, installed from inside the menu. Same machinery as
   * `plugin-install` — fetch, manifest, consent naming the commit and the
   * packages, build — with the prompts drawn by this screen instead of stdout.
   * The index is fetched when this screen opens and never before: opening the
   * store *is* the explicit ask.
   */
  const installFromStore = async (entry: OfficialPlugin): Promise<void> => {
    const source = parsePluginSource(entry.source)
    menu.say(`\n  Fetching ${source.label}…`)
    let checkout
    try {
      checkout = await fetchPlugin({ source, cacheDir: deps.cacheDir })
    } catch (error) {
      await menu.show('Could not fetch it', [error instanceof Error ? error.message : String(error)])
      return
    }

    const manifestPath = join(checkout.directory, MANIFEST_BASENAME)
    const { manifest } = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown)
    if (manifest === null || foreignManifest(manifestPath)) {
      await menu.show('Refused', [manifest === null ? 'Its package.json cannot be used.' : FOREIGN_PLUGIN_MESSAGE])
      return
    }
    const destination = resolve(deps.extensionsDir, manifest.name)
    if (basename(destination) !== manifest.name) {
      await menu.show('Refused', [`"${manifest.name}" is not a name a plugin can have.`])
      return
    }

    const dependencies = thirdPartyDependencies(manifestPath)
    const facts = [
      `${manifest.title} — ${manifest.description}`,
      `By ${manifest.author}, commit ${checkout.commit.slice(0, 12)}.`,
      dependencies.length === 0
        ? 'Depends on nothing outside Lumanin.'
        : `Installs ${String(dependencies.length)} npm package(s), scripts disabled: ${dependencies.join(', ')}.`,
      'A plugin is a program. It runs with the same access to your files,',
      'network and session that you have; nothing is sandboxed.'
    ]
    if (!(await menu.confirm(`Install ${manifest.title}?`, facts.join('\n  ')))) return

    menu.say(`\n  Building ${manifest.title}…`)
    try {
      const result = await buildExtension({
        source: checkout.directory,
        destination,
        production: true,
        installDependencies: dependencies.length > 0
      })
      if (result.built.length === 0) {
        await menu.show('The build failed', result.failures.map((failure) => `${failure.command}: ${failure.reason}`))
        return
      }
      writeProvenance(destination, {
        label: source.label,
        remote: source.remote,
        ref: source.ref,
        subdirectory: checkout.subdirectory,
        commit: checkout.commit,
        installedAt: new Date().toISOString()
      })
      rescan()
      if (deps.reload !== null) await deps.reload()
      await menu.show(`Installed ${manifest.title}`, [
        `${String(result.built.length)} command${result.built.length === 1 ? '' : 's'}: ${result.built.join(', ')}`,
        deps.reload === null ? 'It appears when the daemon next starts.' : 'It is live in the panel now.'
      ])
    } catch (error) {
      await menu.show('The install failed', [error instanceof Error ? error.message : String(error)])
    }
  }

  const storeScreen = async (): Promise<void> => {
    menu.say('\n  Loading the official plugin index…')
    const official = await fetchOfficialIndex()
    if (!official.ok) {
      await menu.show('The store is unreachable', [
        official.error ?? 'The index could not be loaded.',
        'It needs network access to github.com.'
      ])
      return
    }
    if (official.plugins.length === 0) {
      await menu.show('Official plugins', ['The official collection is empty right now.'])
      return
    }

    let storeAt = 0
    for (;;) {
      const installedNames = new Set(index.extensions.map((entry) => entry.manifest.name))
      const chosen = await menu.list<OfficialPlugin>({
        title: 'Official plugins',
        initialIndex: storeAt,
        hints: ['enter install'],
        choices: () =>
          official.plugins.map((entry) => ({
            value: entry,
            prefix: installedNames.has(entry.name) ? `${s.good('✓')} ` : '  ',
            label: entry.title,
            detail: installedNames.has(entry.name) ? s.good('Installed') : `by ${entry.author}`,
            help: entry.description
          }))
      })
      storeAt = chosen.index
      if (chosen.value === null) return
      if (installedNames.has(chosen.value.name)) {
        await menu.show(chosen.value.title, ['Already installed. Manage it from the plugins list.'])
        continue
      }
      await installFromStore(chosen.value)
    }
  }

  // ─── the list ──────────────────────────────────────────────────────────────

  const STORE = Symbol('store')

  let at = 0
  for (;;) {
    const installedCount = index.extensions.length

    const result = await menu.list<Row | typeof STORE>({
      title: `${APP_DISPLAY_NAME} — plugins`,
      subtitle:
        `${String(installedCount)} installed` +
        `  ·  ${deps.reload === null ? 'daemon not running' : 'changes apply immediately'}`,
      initialIndex: at,
      escHint: 'esc quit',
      // Nothing behind this screen: Esc leaves rather than unwinding to a menu
      // it is already on. Every screen below it abandons back to here.
      escape: 'close',
      choices: () => [
        ...rows().map((row) => ({
          value: row as Row | typeof STORE,
          prefix: marker(row),
          label: row.title,
          detail: state(row),
          help: row.description
        })),
        ...(installedCount === 0
          ? [{ value: STORE as Row | typeof STORE, label: 'No plugins installed yet', separator: true }]
          : []),
        { value: ' rule' as unknown as Row | typeof STORE, label: '', separator: true },
        {
          value: STORE as Row | typeof STORE,
          prefix: '    ',
          label: 'Official plugins',
          detail: 'the official collection',
          help: 'Fetched from github.com when opened, not before'
        }
      ]
    })

    at = result.index
    if (result.value === null) {
      menu.say('')
      menu.close()
      return 0
    }
    // Esc inside a plugin's screens means "throw this away and show me the
    // list", exactly as it does in `lumanin config`. A preference half-typed is
    // a preference not written.
    try {
      if (result.value === STORE) await storeScreen()
      else await entryScreen(result.value)
    } catch (error) {
      if (!isAbandoned(error)) throw error
    }
  }
}

/** A preference and the command it belongs to (`''` for extension-level). */
interface Slot {
  readonly spec: PreferenceSpec
  readonly command: string
  readonly commandTitle?: string
}

/**
 * How a preference is named on screen.
 *
 * The command is part of the name, not a separate column: two commands of the
 * same extension can each declare `apiKey`, and a list of two rows both called
 * "API Key" is a list where setting the wrong one is the expected outcome.
 */
function slotTitle(slot: Slot): string {
  const title = slot.spec.title ?? slot.spec.label ?? slot.spec.name
  return slot.commandTitle === undefined ? title : `${title}  (${slot.commandTitle})`
}

/** The value column. A password is acknowledged, never printed. */
function shownValue(slot: Slot, value: string | number | boolean | undefined): string {
  if (value === undefined || value === '') return slot.spec.required ? 'not set — required' : 'not set'
  if (slot.spec.type === 'password') return 'set'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}

/**
 * The preference database.
 *
 * `better-sqlite3` ships N-API prebuilds, so one binary loads under both plain
 * Node and Electron — which is what lets this CLI write the same file the daemon
 * reads, with no second copy of the schema and no new socket verb. SQLite's own
 * locking handles the two of them being open at once, and the daemon re-reads
 * preferences on every launch rather than caching them, so an edit here applies
 * to the next run of the command without a reload.
 *
 * Loaded through a dynamic import so that a native module which will not load
 * takes down the preferences screen and nothing else.
 */
interface PreferenceStore {
  preferences(extension: string, command: string): Record<string, string | number | boolean>
  setPreference(extension: string, command: string, name: string, value: string | number | boolean): void
  forget(extension: string): void
  close(): void
}

async function openStore(dataDir: string): Promise<PreferenceStore | null> {
  try {
    const { ExtensionStore } = await import('../main/extensions/storage')
    return new ExtensionStore(dataDir)
  } catch {
    return null
  }
}

async function forgetStoredData(dataDir: string, extension: string): Promise<boolean> {
  const store = await openStore(dataDir)
  if (store === null) return false
  try {
    store.forget(extension)
    return true
  } finally {
    store.close()
  }
}

/** Backups and temp files are stamped so two runs cannot collide. */
const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

export const PLUGINS_USAGE = `Usage: ${APP_ID} plugins

  Manage the plugins you have installed: remove one, turn one off without
  deleting it, choose which of its commands appear, and set its preferences.
  The Official plugins row at the bottom browses the official collection and
  installs from it.

  Installing from anywhere else is \`${APP_ID} plugin-install <repository|directory>\`.
`
