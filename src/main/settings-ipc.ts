import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, join, resolve } from 'node:path'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { BUILTIN_SEEDS } from '../../themes/index'
import { request, startDaemon } from '../cli/client'
import { describePlatform, type PlatformProfile } from '../platform/detect'
import { bindable, choiceFromConfig, planBind, reloadNotes } from '../platform/fix/bind'
import {
  applyPlan,
  planFixes,
  readManagedBinds,
  runCommands,
  type FixDirs,
  type FixPlan
} from '../platform/fix/index'
import { buildAppIndex } from '../platform/apps/index'
import { isPinKey, loadConfig, isExtensionCommandEnabled, type ResolvedConfig } from '../shared/config'
import { parseHotkey } from '../shared/hotkey'
import { KEY_ACTIONS, KEY_ACTION_INFO } from '../shared/keys'
import {
  INVOKE_CHANNEL,
  SETTINGS_INVOKE_METHODS,
  type BindPlanDto,
  type EventMap,
  type EventName,
  type HotkeyEntryDto,
  type InvokeMethod,
  type OfficialPluginDto,
  type PluginDto,
  type PluginExportDto,
  type PluginInspectionDto,
  type PluginPreferenceGroupDto,
  type SettingsSetValue,
  type SettingsState,
  type SetupPlanDto
} from '../shared/ipc'
import { allSettings, type Setting } from '../shared/settings-model'
import { THEME_FILE_BASENAME } from '../shared/identity'
import type { EnumerateData } from '../shared/protocol'
import { getValue, readConfigDocument, setValue, writeConfigDocument } from '../node/config-file'
import { type LumaninPaths } from '../node/paths'
import type { Logger } from '../node/logger'
import {
  FOREIGN_PLUGIN_MESSAGE,
  buildExtension,
  foreignManifest,
  thirdPartyDependencies
} from './extensions/build'
import { MANIFEST_BASENAME, scanAllExtensions } from './extensions/registry'
import { ExtensionStore } from './extensions/storage'
import { parseManifest } from '../shared/extension'
import { fetchPlugin, writeProvenance, type Provenance } from '../store/plugin'
import { parsePluginSource, PluginSourceError } from '../store/plugin-source'
import { exportPlugin, resolveDownloadsDir } from '../cli/plugin-export'
import { fetchOfficialIndex } from '../store/official'
import type { ThemeService } from './theme'

/**
 * The settings app's whole method surface, main side.
 *
 * Everything here goes through the same machinery the CLI uses — the config
 * document round-trip, the fix planner, the plugin fetch-and-build — so the
 * GUI cannot develop behaviour of its own. The differences are presentation:
 * diffs render in a modal instead of a pager, and consent is a button instead
 * of a `[y/N]`.
 *
 * Security shape (SECURITY.md §Renderer): the renderer names *choices*, never
 * mechanisms. `settings.set` takes a path checked against a closed allow-list;
 * `settings.applyBind` re-plans from disk rather than accepting a plan back
 * from the page; plugin install re-fetches by source string. Nothing the
 * renderer sends is ever spliced into a command line.
 */

export interface SettingsIpcDeps {
  readonly logger: Logger
  readonly paths: LumaninPaths
  /**
   * Where the bundled plugins live. Resolved by the *entry* file — this module
   * is emitted as a shared chunk, so its own `__dirname` points at `chunks/`
   * and any path derived from it here would be wrong. Third occurrence of this
   * trap; see the note in `window.ts`.
   */
  readonly bundledDir: string
  readonly theme: ThemeService
  /** Resolved lazily: the probes finish after the window is already up. */
  readonly profile: () => Promise<PlatformProfile>
  readonly senderId: () => number | null
  readonly send: <E extends EventName>(event: E, payload: EventMap[E]) => void
  readonly close: () => void
  readonly currentConfig: () => ResolvedConfig
}

/** The plugin gets 8 s daemon-side; this waits a little longer than that. */
const ENUMERATE_TIMEOUT_MS = 10_000

export class SettingsIpc {
  private readonly methods = new Set<string>(SETTINGS_INVOKE_METHODS)
  /** Opened on first use; the daemon shares it through SQLite's WAL. */
  private store: ExtensionStore | null = null
  private readonly defaults: ResolvedConfig

  constructor(private readonly deps: SettingsIpcDeps) {
    // What "the default" is, for the delete-when-equal rule. Resolved from
    // nothing: no file, no environment.
    this.defaults = loadConfig({ fileContents: null, env: {} })
  }

  register(): void {
    ipcMain.handle(INVOKE_CHANNEL, async (event: IpcMainInvokeEvent, method: unknown, params: unknown) => {
      if (typeof method !== 'string' || !this.methods.has(method)) {
        this.deps.logger.warn('rejected renderer invoke', { method: String(method) })
        throw new Error('unknown method')
      }
      // Same rule as the daemon: a frame we did not create must not drive us.
      if (this.deps.senderId() !== event.sender.id) {
        this.deps.logger.warn('rejected invoke from unexpected sender', { method })
        throw new Error('unknown method')
      }

      switch (method as InvokeMethod) {
        case 'theme.current':
          return this.deps.theme.payloadNow
        case 'settings.close':
          this.deps.close()
          return undefined
        case 'settings.state':
          return await this.state()
        case 'settings.set':
          return this.set(params as { path: readonly string[]; value: SettingsSetValue })
        case 'settings.setHotkeys':
          return this.setHotkeys(params as { entries: readonly HotkeyEntryDto[] })
        case 'settings.setPins':
          return this.setPins(params as { entries: readonly { key: string; title: string | null }[] })
        case 'settings.setAlias':
          return this.setAlias(params as { alias: string; key: string | null; title: string | null })
        case 'settings.planBind':
          return await this.planBind()
        case 'settings.applyBind':
          return await this.applyBind()
        case 'settings.readBinds':
          return await this.readBinds()
        case 'settings.apps':
          return await this.apps()
        case 'settings.enumerate':
          return await this.enumerate(params as { command: string; category: string | null })
        case 'settings.plugins':
          return this.plugins()
        case 'settings.setPluginEnabled': {
          const { name, enabled } = params as { name: string; enabled: boolean }
          return this.setDisabledEntry(name, !enabled)
        }
        case 'settings.setCommandEnabled': {
          const { id, enabled } = params as { id: string; enabled: boolean }
          return this.setDisabledEntry(id, !enabled)
        }
        case 'settings.setPreference':
          return this.setPreference(
            params as { extension: string; command: string; name: string; value: string | number | boolean }
          )
        case 'settings.removePlugin':
          return this.removePlugin(params as { name: string })
        case 'settings.exportPlugin':
          return await this.exportPlugin(params as { name: string; license: 'mit' | null })
        case 'settings.publishPlugin':
          return await this.publishPlugin(params as { name: string })
        case 'settings.officialPlugins':
          return await this.officialPlugins()
        case 'settings.inspectPlugin':
          return await this.inspectPlugin(params as { source: string })
        case 'settings.installPlugin':
          return await this.installPlugin(params as { source: string; allowDependencies: boolean })
        case 'settings.restartDaemon': {
          await request(this.deps.paths.socket, { kind: 'quit' })
          // Wait for the old process to actually be gone before starting the
          // next one: started too early it loses the still-held single-instance
          // lock and exits — and an early ping in startDaemon's poll can be
          // answered by the *dying* daemon, reporting ok for a ghost.
          const gone = Date.now() + 5000
          while (Date.now() < gone) {
            if ((await request(this.deps.paths.socket, { kind: 'ping' })) === null) break
            await new Promise((r) => setTimeout(r, 100))
          }
          return { ok: await startDaemon(this.deps.paths.socket) }
        }
        case 'settings.planSetup':
          return await this.planSetup()
        case 'settings.applySetup':
          return await this.applySetup()
        case 'settings.finishFirstRun':
          this.finishFirstRun()
          return undefined
        default:
          throw new Error('unknown method')
      }
    })
  }

  // --- state -----------------------------------------------------------------

  async state(): Promise<SettingsState> {
    const document = readConfigDocument(this.deps.paths.configFile)
    const profile = await this.deps.profile()
    const daemonRunning = (await request(this.deps.paths.socket, { kind: 'ping' })) !== null

    return {
      resolved: this.deps.currentConfig(),
      configPath: document.path,
      parseError: document.parseError,
      themes: this.themeList(),
      desktop: describePlatform(profile),
      bindable: bindable(profile),
      daemonRunning,
      // First run: nothing configured yet and the wizard never finished. The
      // marker is state, not config — config.toml stays entirely the user's.
      firstRun: !document.existed && !existsSync(this.wizardMarker())
    }
  }

  private wizardMarker(): string {
    return join(this.deps.paths.state, 'first-run-done')
  }

  private finishFirstRun(): void {
    try {
      writeFileSync(this.wizardMarker(), `${new Date().toISOString()}\n`)
    } catch {
      // Losing the marker means seeing the wizard again — annoying, not broken.
    }
  }

  /** Built-in packs plus every user pack that has a theme file to parse. */
  private themeList(): { value: string; label: string }[] {
    const themes = BUILTIN_SEEDS.map((seed) => ({ value: seed.meta.id, label: seed.meta.name }))
    const dir = join(this.deps.paths.config, 'themes')
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (!existsSync(join(dir, entry.name, THEME_FILE_BASENAME))) continue
        themes.push({ value: entry.name, label: `${entry.name} (yours)` })
      }
    } catch {
      // No user theme directory is the normal case.
    }
    return themes
  }

  // --- config writes ---------------------------------------------------------

  /**
   * The closed set of writable paths. Model settings carry their own entry; the
   * structured screens (engines, order, pins, aliases, keys) add theirs. A path
   * from the renderer that is not here is refused, whatever it names.
   */
  private settable(path: readonly string[]): Setting | 'list' | 'alias' | 'key' | null {
    const setting = allSettings().find(
      (candidate) => candidate.path.length === path.length && candidate.path.every((p, i) => p === path[i])
    )
    if (setting !== undefined) return setting

    const joined = path.join('.')
    if (
      [
        'general.hotkey',
        'file_search.hotkey',
        'file_search.order',
        'search.engines',
        'search.order',
        'search.pins',
        'extensions.disabled'
      ].includes(joined)
    ) {
      return 'list'
    }
    if (path.length === 2 && path[0] === 'aliases') return 'alias'
    if (
      path.length === 2 &&
      path[0] === 'keys' &&
      KEY_ACTIONS.some((action) => KEY_ACTION_INFO[action].setting === path[1])
    ) {
      return 'key'
    }
    return null
  }

  private set(params: { path: readonly string[]; value: SettingsSetValue }): { ok: boolean; detail?: string } {
    const kind = this.settable(params.path)
    if (kind === null) return { ok: false, detail: 'that setting cannot be written' }

    let value: unknown = params.value ?? undefined

    // A value equal to the built-in default deletes the key: absent keys keep
    // following the default as it improves, where a key pinned to today's
    // default is a decision the user never made.
    if (kind !== 'list' && kind !== 'alias' && kind !== 'key' && value !== undefined) {
      const fallback = kind.read(this.defaults).value
      if (value === fallback) value = undefined
    }

    // The two global chords go through the same parser the fix planner uses:
    // an unparseable string written here would silently become DEFAULT_HOTKEY
    // at bind time while config.toml claims something else.
    const dotted = params.path.join('.')
    if (
      (dotted === 'general.hotkey' || dotted === 'file_search.hotkey') &&
      typeof value === 'string' &&
      value !== '' &&
      parseHotkey(value) === null
    ) {
      return { ok: false, detail: `"${value}" is not a hotkey` }
    }

    // A pin list or an alias target is arbitrary-ish text, but not unbounded:
    // the same validation `config.toml` gets on load applies on write.
    if (params.path.join('.') === 'search.pins' && Array.isArray(value)) {
      for (const key of value) {
        if (typeof key === 'string' && !isPinKey(key)) {
          return { ok: false, detail: `"${key}" is not a valid pin key` }
        }
      }
    }

    return this.write((data) => {
      // Arrays are written verbatim, empty included: `engines = []` means "no
      // web searches", which is a choice — deleting the key would mean "the
      // default set", the opposite one. Only `null` deletes.
      setValue(data, params.path, value)
    })
  }

  private setHotkeys(params: { entries: readonly HotkeyEntryDto[] }): { ok: boolean; detail?: string } {
    // Everything the loader would silently drop on the next read is refused
    // here instead — a save that reports ok and then vanishes is the worst of
    // both. Same rules as `hotkeysFrom` in shared/config.ts.
    for (const entry of params.entries) {
      if (parseHotkey(entry.hotkey) === null) {
        return { ok: false, detail: `"${entry.hotkey}" is not a hotkey` }
      }
      if (typeof entry.target !== 'string' || entry.target.length === 0 || entry.target.length > 1024) {
        return { ok: false, detail: 'a hotkey needs a target' }
      }
      if (!isPinKey(entry.target) || /['\n\r]/.test(entry.target)) {
        return { ok: false, detail: `"${entry.target}" is not something the root can launch` }
      }
    }
    return this.write((data) => {
      setValue(
        data,
        ['hotkeys'],
        params.entries.length === 0
          ? undefined
          : params.entries.map((entry) => ({
              // The loader's field is `bind` — writing any other name means the
              // entry is dropped with a warning on the very next load.
              bind: entry.hotkey,
              target: entry.target,
              // Titles end up spliced into compositor config lines; a newline
              // there is someone else's config format broken (or worse).
              ...(entry.title === undefined ? {} : { title: entry.title.replace(/[\r\n]+/g, ' ') })
            }))
      )
    })
  }

  private setPins(params: { entries: readonly { key: string; title: string | null }[] }): {
    ok: boolean
    detail?: string
  } {
    for (const entry of params.entries) {
      if (typeof entry.key !== 'string' || !isPinKey(entry.key)) {
        return { ok: false, detail: `"${String(entry.key)}" is not a valid pin key` }
      }
    }
    return this.write((data) => {
      setValue(
        data,
        ['search', 'pins'],
        params.entries.length === 0
          ? undefined
          : params.entries.map((entry) =>
              entry.title === null ? entry.key : { id: entry.key, title: entry.title }
            )
      )
    })
  }

  /**
   * One `[aliases]` entry. The stored value follows the CLI's spelling rules: a
   * plain application or command stays a bare id (what CONFIG.md documents and
   * what a person types by hand); `shell:` keeps its prefix; anything inside a
   * plugin keeps the whole key, and becomes an `{ id, title }` table when it
   * carries a title.
   */
  private setAlias(params: { alias: string; key: string | null; title: string | null }): {
    ok: boolean
    detail?: string
  } {
    const alias = typeof params.alias === 'string' ? params.alias.trim().toLowerCase() : ''
    if (alias.length === 0 || alias.length > 64 || /\s/.test(alias)) {
      return { ok: false, detail: 'an alias is one short word' }
    }
    if (params.key === null) {
      return this.write((data) => {
        setValue(data, ['aliases', alias], undefined)
      })
    }
    if (!isPinKey(params.key)) return { ok: false, detail: 'that target is not something the root can launch' }

    const key = params.key
    const value =
      params.title !== null
        ? { id: key, title: params.title }
        : key.startsWith('shell:') || key.includes('#')
          ? key
          : key.slice(key.indexOf(':') + 1)
    return this.write((data) => {
      setValue(data, ['aliases', alias], value)
    })
  }

  private write(edit: (data: Record<string, unknown>) => void): { ok: boolean; detail?: string } {
    const document = readConfigDocument(this.deps.paths.configFile)
    if (document.parseError !== null) {
      // Editing would mean rewriting from an empty document, silently
      // discarding everything the file says. Same refusal as the CLI.
      return { ok: false, detail: `config.toml does not parse: ${document.parseError}` }
    }

    const data = structuredClone(document.data)
    edit(data)
    const result = writeConfigDocument(document, data, stamp())
    this.deps.logger.info('config written', { changed: result.changed, backup: result.backup })
    // The daemon and our own watcher both pick the file change up; the watcher
    // also pushes `settings.changed` to the renderer.
    return { ok: true }
  }

  // --- hotkey binds ----------------------------------------------------------

  private fixDirs(): FixDirs {
    return { config: this.deps.paths.configHome, data: this.deps.paths.dataHome }
  }

  async planBind(): Promise<BindPlanDto> {
    const profile = await this.deps.profile()
    if (!bindable(profile)) {
      return { edits: [], commands: [], notes: [], pending: false }
    }
    const plan = planBind(profile, this.fixDirs(), choiceFromConfig(this.deps.currentConfig()))
    const edits = plan.edits.map((edit) => ({
      path: edit.path,
      state: edit.state,
      diff: edit.diff,
      ...(edit.problem === undefined ? {} : { problem: edit.problem })
    }))
    const commands = plan.commands
      .filter((command) => command.state === 'will-add' || command.state === 'will-update')
      .map((command) => ({ title: command.title, preview: command.preview }))
    return {
      edits,
      commands,
      notes: plan.notes,
      pending:
        commands.length > 0 ||
        edits.some((edit) => edit.state === 'will-add' || edit.state === 'will-update')
    }
  }

  /**
   * Consent arrived. The plan is rebuilt from disk rather than taken from the
   * renderer — the page saw a description, and a description is not something
   * to execute.
   */
  async applyBind(): Promise<{ results: { target: string; ok: boolean; detail?: string }[]; notes: readonly string[] }> {
    const profile = await this.deps.profile()
    if (!bindable(profile)) return { results: [], notes: [] }

    const plan = planBind(profile, this.fixDirs(), choiceFromConfig(this.deps.currentConfig()))
    const pending = plan.edits.filter((edit) => edit.state === 'will-add' || edit.state === 'will-update')
    const fileResults = applyPlan(pending, stamp()).map((result) => ({
      target: result.path,
      ok: result.ok,
      ...(result.detail === undefined ? {} : { detail: result.detail })
    }))

    const commandFixes = plan.commands.filter(
      (command) => command.state === 'will-add' || command.state === 'will-update'
    )
    const commandResults = (
      await Promise.all(commandFixes.map(async (fix) => await runCommands(fix.commands, runQuiet)))
    )
      .flat()
      .map((result) => ({
        target: result.path,
        ok: result.ok,
        ...(result.detail === undefined ? {} : { detail: result.detail })
      }))

    this.deps.logger.info('bind plan applied', {
      files: fileResults.length,
      commands: commandResults.length
    })
    return { results: [...fileResults, ...commandResults], notes: plan.notes }
  }

  /**
   * The wizard's integration step: the *whole* `doctor --fix` plan — window
   * rules, keybind, autostart entry, systemd unit — where the settings screens
   * plan only the bind slice. Same planner, same consent shape.
   */
  async planSetup(): Promise<SetupPlanDto> {
    const profile = await this.deps.profile()
    const plan = planFixes(profile, this.fixDirs(), choiceFromConfig(this.deps.currentConfig()))
    const edits = plan.edits
      .filter((edit) => edit.state !== 'not-applicable')
      .map((edit) => ({
        path: edit.path,
        state: edit.state,
        diff: edit.diff,
        ...(edit.problem === undefined ? {} : { problem: edit.problem })
      }))
    const commands = plan.commands
      .filter((command) => command.state === 'will-add' || command.state === 'will-update')
      .map((command) => ({ title: command.title, preview: command.preview }))

    return {
      edits,
      commands,
      notes: reloadNotes(profile, plan),
      manual: plan.manual.map((step) => ({ title: step.title, why: step.why, commands: step.commands })),
      pending:
        commands.length > 0 ||
        edits.some((edit) => edit.state === 'will-add' || edit.state === 'will-update')
    }
  }

  async applySetup(): Promise<{ results: { target: string; ok: boolean; detail?: string }[]; notes: readonly string[] }> {
    const profile = await this.deps.profile()
    const plan = planFixes(profile, this.fixDirs(), choiceFromConfig(this.deps.currentConfig()))
    const outcome = await this.applyFixPlan(profile, plan)
    this.deps.logger.info('setup plan applied', { results: outcome.results.length })
    return outcome
  }

  private async applyFixPlan(
    profile: PlatformProfile,
    plan: Pick<FixPlan, 'edits' | 'commands'>
  ): Promise<{ results: { target: string; ok: boolean; detail?: string }[]; notes: readonly string[] }> {
    const pending = plan.edits.filter((edit) => edit.state === 'will-add' || edit.state === 'will-update')
    const results = applyPlan(pending, stamp()).map((result) => ({
      target: result.path,
      ok: result.ok,
      ...(result.detail === undefined ? {} : { detail: result.detail })
    }))

    const commandFixes = plan.commands.filter(
      (command) => command.state === 'will-add' || command.state === 'will-update'
    )
    for (const fix of commandFixes) {
      for (const result of await runCommands(fix.commands, runQuiet)) {
        results.push({
          target: result.path,
          ok: result.ok,
          ...(result.detail === undefined ? {} : { detail: result.detail })
        })
      }
    }

    // A written unit is not a running one: systemd has to be told it exists.
    // Both commands are `--user` — nothing here touches system units or root.
    if (results.some((result) => result.ok && result.target.endsWith('lumanin.service'))) {
      for (const args of [
        ['--user', 'daemon-reload'],
        ['--user', 'enable', '--now', 'lumanin.service']
      ]) {
        const ok = await runQuiet('systemctl', args)
        results.push({ target: `systemctl ${args.join(' ')}`, ok })
      }
    }

    return { results, notes: reloadNotes(profile, plan) }
  }

  async readBinds(): Promise<readonly { path: string; keyText: string; hotkey: ReturnType<typeof parseHotkey>; target: string | null }[]> {
    const profile = await this.deps.profile()
    if (!bindable(profile)) return []
    return readManagedBinds(profile, this.fixDirs()).map((bind) => ({
      path: bind.path,
      keyText: bind.keyText,
      hotkey: bind.hotkey,
      target: bind.target
    }))
  }

  // --- pickers ---------------------------------------------------------------

  private appCache: readonly { id: string; title: string }[] | null = null

  async apps(): Promise<readonly { id: string; title: string }[]> {
    if (this.appCache !== null) return this.appCache
    const profile = await this.deps.profile()
    this.appCache = buildAppIndex({
      env: process.env,
      home: this.deps.paths.home,
      desktops: profile.desktops
    }).entries.map((entry) => ({ id: entry.id, title: entry.name }))
    return this.appCache
  }

  /** Item pinning asks the plugin what a category holds, which needs a daemon. */
  async enumerate(params: { command: string; category: string | null }): Promise<EnumerateData['items']> {
    if (typeof params.command !== 'string' || params.command.length === 0) return []
    const verb = { kind: 'enumerate' as const, command: params.command, category: params.category }
    let reply = await request(this.deps.paths.socket, verb, ENUMERATE_TIMEOUT_MS)
    if (reply === null) {
      // A null reply is also what a *timeout* against a live-but-slow daemon
      // looks like, and a spawned daemon's empty argv parses as `toggle` — so
      // an enumerate that merely ran long must not pop the panel open. Only a
      // dead socket earns a start.
      if ((await request(this.deps.paths.socket, { kind: 'ping' })) !== null) {
        throw new Error('the daemon did not answer in time')
      }
      if (!(await startDaemon(this.deps.paths.socket))) {
        throw new Error('the daemon could not be started, and only it can run the plugin')
      }
      reply = await request(this.deps.paths.socket, verb, ENUMERATE_TIMEOUT_MS)
    }
    if (reply === null) throw new Error('the daemon did not answer')
    if (!reply.ok) throw new Error(reply.error)
    return (reply.data as EnumerateData | undefined)?.items ?? []
  }

  // --- plugins ---------------------------------------------------------------

  private extensionStore(): ExtensionStore {
    this.store ??= new ExtensionStore(this.deps.paths.data)
    return this.store
  }

  dispose(): void {
    this.store?.close()
    this.store = null
  }

  plugins(): readonly PluginDto[] {
    const index = scanAllExtensions({
      extensionsDir: this.deps.paths.extensionsDir,
      bundledDir: this.deps.bundledDir,
      dataDir: this.deps.paths.data
    })
    this.deps.logger.debug('plugins scanned', {
      bundledDir: this.deps.bundledDir,
      found: index.extensions.map((extension) => extension.manifest.name)
    })
    const disabled = this.deps.currentConfig().extensions.disabled.value
    const store = this.extensionStore()

    return index.extensions.map((extension) => {
      const name = extension.manifest.name
      const commands = index.commands
        .filter((command) => command.extension === extension)
        .map((command) => ({
          id: command.id,
          name: command.spec.name,
          title: command.spec.title,
          description: command.spec.description ?? '',
          enabled: isExtensionCommandEnabled(disabled, command.id),
          root: command.spec.root,
          categories: command.spec.categories
        }))

      const groups: PluginPreferenceGroupDto[] = []
      if (extension.manifest.preferences.length > 0) {
        groups.push({
          command: '',
          title: 'Extension',
          preferences: extension.manifest.preferences.map((spec) => ({
            ...spec,
            title: spec.title ?? spec.name,
            description: spec.description ?? '',
            ...valueOf(spec.type, store.preferences(name, '')[spec.name])
          }))
        })
      }
      for (const command of index.commands.filter((candidate) => candidate.extension === extension)) {
        if (command.spec.preferences.length === 0) continue
        groups.push({
          command: command.spec.name,
          title: command.spec.title,
          preferences: command.spec.preferences.map((spec) => ({
            ...spec,
            title: spec.title ?? spec.name,
            description: spec.description ?? '',
            ...valueOf(spec.type, store.preferences(name, command.spec.name)[spec.name])
          }))
        })
      }

      return {
        name,
        title: extension.manifest.title,
        description: extension.manifest.description,
        author: extension.manifest.author,
        bundled: extension.bundled,
        enabled: !disabled.includes(name),
        origin: extension.source?.label ?? null,
        commands,
        preferenceGroups: groups
      }
    })
  }

  /** Add or remove one name (or `<ext>/<cmd>` id) in `[extensions].disabled`. */
  private setDisabledEntry(entry: string, disable: boolean): { ok: boolean; detail?: string } {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 256) {
      return { ok: false, detail: 'not a plugin name' }
    }
    const result = this.write((data) => {
      const raw = getValue(data, ['extensions', 'disabled'])
      const list = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
      const next = disable ? [...new Set([...list, entry])] : list.filter((item) => item !== entry)
      setValue(data, ['extensions', 'disabled'], next.length === 0 ? undefined : next)
    })
    void this.reloadDaemon()
    return result
  }

  private setPreference(params: {
    extension: string
    command: string
    name: string
    value: string | number | boolean
  }): { ok: boolean; detail?: string } {
    if (typeof params.extension !== 'string' || typeof params.name !== 'string') {
      return { ok: false, detail: 'not a preference' }
    }
    this.extensionStore().setPreference(
      params.extension,
      typeof params.command === 'string' ? params.command : '',
      params.name,
      params.value
    )
    return { ok: true }
  }

  private removePlugin(params: { name: string }): { ok: boolean; detail?: string } {
    const name = params.name
    // The typeof check must run before `resolve` — resolve throws on a
    // non-string, which would turn the polite refusal into an invoke rejection.
    if (typeof name !== 'string') return { ok: false, detail: 'no plugin name given' }
    const directory = resolve(this.deps.paths.extensionsDir, name)
    // The argument is a *name*; one resolving anywhere else is not one.
    if (basename(directory) !== name || !existsSync(directory)) {
      if (existsSync(resolve(this.deps.bundledDir, name))) {
        return {
          ok: false,
          detail: `${name} ships with the app and cannot be removed - turn it off instead.`
        }
      }
      return { ok: false, detail: `no plugin called "${name}" is installed` }
    }
    rmSync(directory, { recursive: true, force: true })
    void this.reloadDaemon()
    // Its stored data is kept, in case of a reinstall — same policy as the CLI.
    return { ok: true }
  }

  private async reloadDaemon(): Promise<void> {
    await request(this.deps.paths.socket, { kind: 'reload' })
  }

  // --- plugin export ---------------------------------------------------------

  /**
   * The CLI's `plugin-export`, as a button. Same function, same destination
   * (the XDG downloads dir); the GUI adds only the license choice and — when
   * `gh` is signed in — the offer to publish.
   */
  private async exportPlugin(params: { name: string; license: 'mit' | null }): Promise<PluginExportDto> {
    const name = params.name
    if (typeof name !== 'string' || !PUBLISHABLE_NAME.test(name)) {
      return { ok: false, detail: 'no plugin name given' }
    }
    const downloads = resolveDownloadsDir(this.deps.paths.configHome, this.deps.paths.home)
    // Installed plugins first; a bundled one exports from the app directory,
    // which keeps `src/` for exactly this reason.
    const from = existsSync(join(this.deps.paths.extensionsDir, name, MANIFEST_BASENAME))
      ? this.deps.paths.extensionsDir
      : this.deps.bundledDir
    try {
      const result = exportPlugin(from, name, downloads, params.license === 'mit' ? { license: 'mit' } : {})
      return {
        ok: true,
        directory: result.directory,
        ...(result.publishedAt === null ? {} : { publishedAt: result.publishedAt }),
        ghReady: await runQuiet('gh', ['auth', 'status'])
      }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Publishing is outward-facing and irreversible in practice, so it only ever
   * runs from an explicit button whose text says exactly this: a public
   * repository named after the plugin, on the user's own GitHub account, via
   * their own signed-in `gh`. The directory is recomputed from the name — the
   * renderer never sends a path.
   */
  private async publishPlugin(params: { name: string }): Promise<{ ok: boolean; detail: string; url?: string }> {
    const name = params.name
    if (typeof name !== 'string' || !PUBLISHABLE_NAME.test(name)) {
      return { ok: false, detail: 'no plugin name given' }
    }
    const directory = join(resolveDownloadsDir(this.deps.paths.configHome, this.deps.paths.home), name)
    if (!existsSync(join(directory, MANIFEST_BASENAME))) {
      return { ok: false, detail: `${directory} is not an exported plugin - export it first` }
    }

    if (!existsSync(join(directory, '.git'))) {
      const init = await runCapture('git', ['init', '--quiet', '-b', 'main'], directory)
      if (!init.ok) return { ok: false, detail: `git init failed: ${init.output}` }
    }
    const add = await runCapture('git', ['add', '-A'], directory)
    if (!add.ok) return { ok: false, detail: `git add failed: ${add.output}` }
    // "nothing to commit" on a re-run is fine; a real failure (say, no git
    // identity configured) surfaces on the create step with git's own words.
    await runCapture('git', ['commit', '--quiet', '-m', name], directory)

    const created = await runCapture(
      'gh',
      ['repo', 'create', name, '--public', '--source=.', '--push'],
      directory
    )
    if (!created.ok) return { ok: false, detail: created.output || 'gh repo create failed' }

    const url = created.output.split('\n').find((line) => line.startsWith('https://'))?.trim()
    return {
      ok: true,
      detail: 'published',
      ...(url === undefined ? {} : { url })
    }
  }

  // --- plugin install --------------------------------------------------------

  private progress(line: string): void {
    this.deps.send('settings.installProgress', { line })
  }

  /** The official index, with each entry marked installed or not. */
  private async officialPlugins(): Promise<{
    ok: boolean
    error?: string
    plugins: readonly OfficialPluginDto[]
  }> {
    const index = await fetchOfficialIndex()
    return {
      ok: index.ok,
      ...(index.error === undefined ? {} : { error: index.error }),
      plugins: index.plugins.map((plugin) => ({
        ...plugin,
        installed: existsSync(resolve(this.deps.paths.extensionsDir, plugin.name, MANIFEST_BASENAME))
      }))
    }
  }

  /**
   * Fetch and describe. Same facts the CLI prints before its `[y/N]` — who
   * wrote it, which commit, what it declares, what it would pull in — so the
   * GUI's consent screen is made of facts rather than a URL.
   */
  async inspectPlugin(params: { source: string }): Promise<PluginInspectionDto> {
    try {
      const checkout = await this.checkout(params.source)
      const manifestPath = join(checkout.directory, MANIFEST_BASENAME)
      if (!existsSync(manifestPath)) {
        return { ok: false, error: 'that repository has no package.json - is it a plugin?' }
      }
      const { manifest, problems } = parseManifest(
        JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
      )
      if (manifest === null) {
        return { ok: false, error: `that package.json cannot be used: ${problems.join('; ')}` }
      }
      if (foreignManifest(manifestPath)) {
        return { ok: false, error: FOREIGN_PLUGIN_MESSAGE }
      }

      return {
        ok: true,
        name: manifest.name,
        title: manifest.title,
        description: manifest.description,
        author: manifest.author,
        commands: manifest.commands.map((command) => command.name),
        dependencies: thirdPartyDependencies(manifestPath),
        ...(checkout.provenance === null ? {} : { commit: checkout.provenance.commit.slice(0, 12) }),
        label: checkout.label,
        replacing: existsSync(resolve(this.deps.paths.extensionsDir, manifest.name)),
        directory: checkout.directory
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async installPlugin(params: { source: string; allowDependencies: boolean }): Promise<{ ok: boolean; detail: string }> {
    try {
      const checkout = await this.checkout(params.source)
      const manifestPath = join(checkout.directory, MANIFEST_BASENAME)
      const { manifest } = parseManifest(
        JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
      )
      if (manifest === null) return { ok: false, detail: 'that package.json cannot be used' }
      if (foreignManifest(manifestPath)) return { ok: false, detail: FOREIGN_PLUGIN_MESSAGE }

      const dependencies = thirdPartyDependencies(manifestPath)
      if (dependencies.length > 0 && !params.allowDependencies) {
        return {
          ok: false,
          detail: `it needs ${String(dependencies.length)} npm package(s): ${dependencies.join(', ')}`
        }
      }

      const destination = resolve(this.deps.paths.extensionsDir, manifest.name)
      // `manifest.name` comes from a fetched repository — a name with a `/` or
      // `..` in it must not place the build outside the extensions directory.
      if (basename(destination) !== manifest.name) {
        return { ok: false, detail: `"${manifest.name}" is not a name a plugin can have` }
      }
      const result = await buildExtension({
        source: checkout.directory,
        destination,
        production: true,
        installDependencies: params.allowDependencies,
        onProgress: (message) => this.progress(message)
      })
      // A wholly failed build gets no provenance record and no daemon reload —
      // recording it would present the wreckage as an install.
      if (result.built.length === 0) {
        return {
          ok: false,
          detail: result.failures.map((failure) => `${failure.command}: ${failure.reason}`).join('; ')
        }
      }
      if (checkout.provenance !== null) writeProvenance(destination, checkout.provenance)
      await this.reloadDaemon()
      return {
        ok: true,
        detail: `installed ${result.manifest.title} - ${String(result.built.length)} command${
          result.built.length === 1 ? '' : 's'
        }`
      }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /** A local directory wins over the `owner/name` shorthand, like the CLI. */
  private async checkout(target: string): Promise<{
    directory: string
    provenance: Provenance | null
    label: string
  }> {
    if (typeof target !== 'string' || target.trim().length === 0) {
      throw new Error('paste a repository URL or a directory path')
    }
    const trimmed = target.trim()

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      try {
        // Against the home directory, not the process cwd: a detached GUI
        // process inherits whatever directory its launcher happened to be in,
        // which is nothing a person typing "Projects/my-plugin" is picturing.
        const path = resolve(this.deps.paths.home, trimmed)
        if (statSync(path).isDirectory()) {
          return { directory: path, provenance: null, label: path }
        }
      } catch {
        // Not a directory; fall through to the repository parser.
      }
    }

    let source
    try {
      source = parsePluginSource(trimmed)
    } catch (error) {
      throw new Error(error instanceof PluginSourceError ? error.message : String(error))
    }

    const fetched = await fetchPlugin({
      source,
      cacheDir: this.deps.paths.cache,
      onProgress: (message) => this.progress(message)
    })
    return {
      directory: fetched.directory,
      provenance: {
        label: source.label,
        remote: source.remote,
        ref: source.ref,
        // The subdirectory the plugin was *found* in, when the URL named the
        // repository root — so a reinstall repeats the same choice.
        subdirectory: fetched.subdirectory,
        commit: fetched.commit,
        installedAt: new Date().toISOString()
      },
      label: source.label
    }
  }
}

/**
 * `exactOptionalPropertyTypes`: an absent stored value must be absent, not
 * `undefined`. A `password` value is never echoed to the renderer — the page
 * only needs "one is set", so the secret itself stays out of the DOM and the
 * IPC transcript. The masked spelling keeps the DTO shape unchanged.
 */
function valueOf(
  type: string,
  stored: string | number | boolean | undefined
): { value?: string | number | boolean } {
  if (stored === undefined) return {}
  if (type === 'password') return typeof stored === 'string' && stored.length > 0 ? { value: 'set' } : {}
  return { value: stored }
}

/** Backups and temp files are stamped so two writes cannot collide. */
function stamp(): string {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

/** Run a command, argv array never a shell string (SECURITY.md §Processes). */
function runQuiet(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((settle) => {
    const child = spawn(command, [...args], { stdio: 'ignore' })
    child.on('error', () => settle(false))
    child.on('exit', (code) => settle(code === 0))
  })
}

/**
 * A plugin name that can double as a repository name. Tighter than the
 * manifest's own rules on purpose — this string reaches `gh` and a path.
 */
const PUBLISHABLE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/

/**
 * Run a command and keep its words. Prompting is disabled the same way the
 * store's git runner disables it: a credential prompt behind a captured pipe
 * is a hang nobody can see.
 */
function runCapture(
  command: string,
  args: readonly string[],
  cwd: string
): Promise<{ ok: boolean; output: string }> {
  return new Promise((settle) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('error', (cause) => settle({ ok: false, output: cause.message }))
    child.on('exit', (code) => settle({ ok: code === 0, output: output.trim() }))
  })
}
