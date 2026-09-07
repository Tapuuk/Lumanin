import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, clipboard, ipcMain, net, Notification, protocol, shell, type IpcMainInvokeEvent } from 'electron'
import { detectPlatform, describePlatform, probePlatform } from '../platform/detect'
import { createRuntime, type PlatformRuntime } from '../platform/runtime'
import type { BinaryMap } from '../platform/probe/binaries'
import { openPath } from '../platform/apps/launch'
import { FrecencyStore } from '../node/frecency-store'
import { pinIconPath, storePinIcon } from '../node/pin-icons'
import { SearchService } from './search'
import { isExtensionCommandEnabled, loadConfig, type ResolvedConfig } from '../shared/config'
import { escapeAction } from '../shared/escape'
import { coalesceToggle } from '../shared/toggle'
import {
  APP_DISPLAY_NAME,
  CONFIG_BASENAME,
  ICON_SCHEME,
  RAYCAST_API_VERSION
} from '../shared/identity'
import {
  EVENT_CHANNEL,
  INVOKE_CHANNEL,
  INVOKE_METHODS,
  type EventMap,
  type EventName,
  type InvokeMethod
} from '../shared/ipc'
import { createFileSink, createStderrSink, Logger } from '../node/logger'
import { firstRunPending, markFirstRunOffered } from '../node/first-run'
import { bundledPluginsDir, resolvePaths } from '../node/paths'
import { parseArgs, type DaemonStatus, type EnumerateData, type Request, type Response } from '../shared/protocol'
import { HOST_NOT_RUNNING, type ExtensionHostStatus } from '../shared/ext-protocol'
import { actionHandlerOf, listItemsOf, type RenderNode } from '../shared/render-tree'
import { createCopy } from './clipboard-copy'
import { rootCommands, type RegisteredCommand } from './commands'
import { launchSettings } from '../cli/client'
import { applyCsp } from './csp'
import { ExtensionHost } from './extensions/host'
import { answerHeadlessAlert } from './extensions/headless-alert'
import type { AlertPayload } from '../shared/ext-protocol'
import {
  cachedRootCommands,
  emptyIndex,
  scanAllExtensions,
  type ExtensionIndex,
  type InstalledCommand
} from './extensions/registry'
import { ExtensionStore } from './extensions/storage'
import { ControlSocket } from './socket'
import { ThemeService } from './theme'
import { PanelWindow } from './window'
import type { RootCommand } from './root-search'

/**
 * Electron main: the daemon.
 *
 * The window is created once at startup and thereafter only hidden and shown.
 * Nothing on the toggle path allocates, reads config, or touches disk: the
 * toggle has a latency budget of a few milliseconds and that is what keeps it.
 */

// The application's name, class and ozone hint are set by the entry dispatcher
// (`index.ts`), synchronously — a switch appended from here, a dynamically
// imported module, lands after Chromium has snapshotted the command line.

const paths = resolvePaths()
const profile = detectPlatform()

/**
 * The icon scheme, registered before app-ready because Chromium requires it.
 *
 * Application icons live all over the filesystem — `/usr/share/icons`,
 * `~/.local/share`, Flatpak exports — and the renderer is sandboxed and must
 * never be handed a path. A scheme means main resolves the id, decides what it
 * will serve, and the renderer only ever writes `<img src="lumanin-icon://…">`.
 * `file:` would have meant the opposite: real paths crossing the bridge, and a
 * future extension-supplied result able to point at any readable file.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: ICON_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
])


for (const dir of [paths.config, paths.data, paths.cache, paths.state, paths.logDir]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

// Electron derives `userData` from XDG_CONFIG_HOME on Linux, so naming the app
// `lumanin` silently makes `~/.config/lumanin/` Chromium's profile directory —
// Cache/, GPUCache/, Local Storage/, Crashpad/, SingletonLock and friends land
// next to `config.toml`. That directory is promised to be user-authored and
// safe to copy between machines, so the profile is moved to where its contents
// actually belong: regenerable caches under the cache dir, profile state under
// the state dir.
//
// This must run before `requestSingleInstanceLock()` — the lock file lives in
// `userData`, so moving it afterwards would lock the wrong path.
app.setPath('userData', join(paths.state, 'chromium'))
app.setPath('sessionData', join(paths.cache, 'chromium'))

const logger = Logger.fromEnv([createStderrSink(), createFileSink(paths.logDir)])

function readConfigFile(): string | null {
  try {
    return readFileSync(paths.configFile, 'utf8')
  } catch {
    return null // No config file is the normal case, not an error.
  }
}

/**
 * The live configuration.
 *
 * A `let` and a getter rather than a `const` passed around, because the file is
 * watched: saving `config.toml` — from an editor or from `lumanin config` —
 * re-resolves it in place. Everything that reads a setting takes {@link current}
 * and calls it at the point of use, so nobody is holding a snapshot from
 * startup.
 */
let config: ResolvedConfig = loadConfig({ fileContents: readConfigFile(), env: process.env })
const current = (): ResolvedConfig => config

function reportConfig(loaded: ResolvedConfig): void {
  for (const problem of loaded.problems) logger.warn('config', { problem })
  if (loaded.unrecognized.length > 0) {
    logger.warn('config contains unrecognized sections (preserved, not applied)', {
      sections: loaded.unrecognized
    })
  }
}

reportConfig(config)

/**
 * Settings the window was built around, which a reload therefore cannot change.
 *
 * The panel window is created once and never resized, so new dimensions need
 * a new window, which means a restart. Reload says so rather than pretending
 * it applied them.
 */
function needsRestart(_before: ResolvedConfig, _after: ResolvedConfig): readonly string[] {
  // Width and height were the two entries here until the panel learned to refit
  // itself (`PanelWindow.fit()`); nothing in `config.toml` needs a restart today.
  // The plumbing stays because the honest answer to "did that apply?" has to
  // remain available the day a key does.
  return []
}

/** Re-read `config.toml`. Returns what changed but could not be applied live. */
function reloadConfig(reason: string): readonly string[] {
  const loaded = loadConfig({ fileContents: readConfigFile(), env: process.env })
  const pending = needsRestart(config, loaded)
  config = loaded
  reportConfig(loaded)
  logger.info('configuration reloaded', { reason, ...(pending.length > 0 ? { pending } : {}) })

  // The theme is part of the chain's first link, so a changed `[appearance]`
  // has to re-run it; everything else reads `current()` on demand.
  void theme.refresh(reason)
  // `[general].width` / `.height` are read at fit time; tell the window to look.
  panel?.reconfigure()
  // The renderer holds its keymap rather than asking per keystroke, so a change
  // has to be pushed. Sent unconditionally — comparing two keymaps to save one
  // small message would be more code than the message costs.
  emit('keys.changed', loaded.keys.value)
  return pending
}

/**
 * How long to let a save settle before re-reading.
 *
 * Editors and our own writer both replace the file by writing a temp and
 * renaming, which is two events; a plain editor writing in place can be several
 * more. Without a debounce a single save re-parses the file three times, and
 * once mid-write.
 */
const CONFIG_RELOAD_DEBOUNCE_MS = 120
let configWatcher: FSWatcher | null = null
let configReloadTimer: NodeJS.Timeout | null = null

/**
 * Watch `config.toml` so a save just takes effect.
 *
 * The directory is watched rather than the file: an atomic save replaces the
 * inode, and a watch on the old one would survive exactly one save and then go
 * quiet — the failure mode where it works when you test it and not afterwards.
 */
function watchConfigFile(): void {
  try {
    configWatcher = watch(paths.config, { persistent: false }, (_event, filename) => {
      if (filename !== null && filename !== CONFIG_BASENAME) return
      if (configReloadTimer !== null) clearTimeout(configReloadTimer)
      configReloadTimer = setTimeout(() => {
        configReloadTimer = null
        reloadConfig('config.toml changed')
      }, CONFIG_RELOAD_DEBOUNCE_MS)
      configReloadTimer.unref?.()
    })
    configWatcher.on('error', (error: unknown) => {
      logger.warn('stopped watching config.toml', { error })
    })
  } catch (error) {
    // Not fatal: `lumanin reload` and a restart both still work. It is logged
    // because "my edit did nothing" is otherwise unexplainable.
    logger.warn('could not watch config.toml; use `lumanin reload` after editing', { error })
  }
}

const startedAt = Date.now()

// ---------------------------------------------------------------------------
// Single instance: the second invocation is a CLI verb, not a second window.
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  // Argv was already forwarded to the running daemon by Electron; nothing to do.
  app.exit(0)
}

let panel: PanelWindow | null = null
let socket: ControlSocket | null = null
let platform: PlatformRuntime | null = null
let search: SearchService | null = null
/** Resolves once the probes have run; `null` before `whenReady`. */
let platformReady: Promise<PlatformRuntime> | null = null
/**
 * What the probes found, for the two callers that need a *binary* rather than a
 * backend. Kept beside the runtime rather than on it: the runtime deliberately
 * exposes capabilities and not the profile, so that nothing downstream can start
 * asking which desktop is running.
 */
let probedBinaries: BinaryMap | null = null

const theme = new ThemeService({
  config: current,
  configDir: paths.config,
  logger,
  onChange: (payload) => {
    emit('theme.changed', payload)
    panel?.setTextScale(payload.textScale, theme.toolkitScaleNow)
  }
})

// ---------------------------------------------------------------------------
// Extensions. The store and the index are cheap and eager; the host process is
// not, and is started a moment after the daemon has settled.
// ---------------------------------------------------------------------------

let extensions: ExtensionIndex = emptyIndex()
let extensionHost: ExtensionHost | null = null
let extensionStore: ExtensionStore | null = null

/**
 * How long after start-up to fork the extension host.
 *
 * Late enough that it is not competing with the probes and the application
 * index, which are what the very first keypress waits on, and early enough that
 * it is up before a person has finished reading their screen.
 */
const PREWARM_DELAY_MS = 3000
let prewarmTimer: NodeJS.Timeout | null = null

/**
 * Whether any plugin command is switched on.
 *
 * The guard on pre-starting the host: a plugin ships inside the application, so
 * "nothing to run" is not a state a stock install can be in, and the process
 * and its warm worker are worth paying for at rest instead of in front of
 * whichever launch happened to ask first. Somebody who has switched every
 * command off has nothing to run after all, and pays nothing.
 */
function anyExtensionEnabled(): boolean {
  const disabled = current().extensions.disabled.value
  return extensions.commands.some((command) => isExtensionCommandEnabled(disabled, command.id))
}

/**
 * Where the plugins that ship inside the application live. Written by
 * `scripts/build-plugins.mjs`, the last step of `npm run build`.
 */
const pluginsDir = bundledPluginsDir(__dirname, process.resourcesPath)

function rescanExtensions(): void {
  extensions = scanAllExtensions({
    extensionsDir: paths.extensionsDir,
    bundledDir: pluginsDir,
    dataDir: paths.data,
    logger
  })

  for (const problem of extensions.problems) {
    logger.warn('an installed extension cannot be used', problem)
  }
  logger.info('extensions indexed', {
    extensions: extensions.extensions.length,
    bundled: extensions.extensions.filter((extension) => extension.bundled).length,
    commands: extensions.commands.length,
    unusable: extensions.problems.length
  })
}

/**
 * The command behind a launch, from an index that may have gone stale.
 *
 * The index is a snapshot of two directories that other programs write to: the
 * user removes a plugin, an upgrade replaces the bundled ones, `ext dev`
 * rebuilds one. A snapshot taken at startup and refreshed only on `reload` was
 * how a plugin that no longer existed stayed on the root list and answered Enter
 * with a Node stack trace naming a file nobody had heard of.
 *
 * So a lookup that comes up empty — or finds a row whose entry is gone — rescans
 * once and asks again, and the answer is whatever is true now. Costing a
 * directory scan on the launches that were going to fail anyway is the cheap
 * half of that trade; `watchExtensionsDir` below is what keeps it rare.
 */
function extensionCommand(match: (candidate: InstalledCommand) => boolean): InstalledCommand | null {
  const found = extensions.commands.find(match)
  if (found !== undefined && existsSync(found.entryPath)) return found

  rescanExtensions()
  return extensions.commands.find(match) ?? null
}

/**
 * How long to let the extensions directory settle before rescanning.
 *
 * An install writes a manifest, a `commands/` tree and an `assets/` tree; a
 * removal unlinks all of it. Either is dozens of events, and a scan per event
 * would re-read every other plugin's manifest dozens of times for one install.
 */
const EXTENSIONS_RESCAN_DEBOUNCE_MS = 250
let extensionsWatcher: FSWatcher | null = null
let extensionsRescanTimer: NodeJS.Timeout | null = null

/**
 * Notice plugins appearing and disappearing without being told.
 *
 * `lumanin plugin-install` ends by sending `reload`, so the happy path never
 * needed this. Everything else does: `rm -rf` on a plugin directory, a package
 * upgrade, a second checkout's `ext dev`, an install that was interrupted. The
 * directory is the truth and the index is a cache of it, so the cache follows.
 *
 * Non-recursive on purpose. Direct children are what an install or a removal
 * creates and destroys, which is exactly the resolution needed here; watching
 * every file inside every plugin would cost an inotify watch per asset to learn
 * nothing the debounce would not have coalesced away.
 */
function watchExtensionsDir(): void {
  try {
    mkdirSync(paths.extensionsDir, { recursive: true, mode: 0o700 })
    extensionsWatcher = watch(paths.extensionsDir, { persistent: false }, () => {
      if (extensionsRescanTimer !== null) clearTimeout(extensionsRescanTimer)
      extensionsRescanTimer = setTimeout(() => {
        extensionsRescanTimer = null
        rescanExtensions()
      }, EXTENSIONS_RESCAN_DEBOUNCE_MS)
      extensionsRescanTimer.unref?.()
    })
    extensionsWatcher.on('error', (error: unknown) => {
      logger.warn('stopped watching the extensions directory', { error })
    })
  } catch (error) {
    // Not fatal — `extensionCommand` rescans on a stale hit and `lumanin reload`
    // still works. Logged because "I removed it and it is still listed" would
    // otherwise have no explanation.
    logger.warn('could not watch the extensions directory', { error })
  }
}

/**
 * Open a file with the application the desktop associates with it.
 *
 * `gio` first, Electron's `shell.openPath` second — `openPath` in
 * `platform/apps/launch.ts` has the whole reason, which is that `xdg-open` decides a file's
 * type by sniffing its *contents* and so opens a zstd-compressed `.blend` in the
 * file manager rather than in Blender.
 *
 * Errors are reported rather than thrown at the caller in one case and swallowed
 * in the other: an extension's `open()` is a promise somebody awaits, and a root
 * command is not.
 */
async function openFile(target: string): Promise<void> {
  await platformReady
  if (probedBinaries !== null && (await openPath(target, { binaries: probedBinaries }))) return

  const error = await shell.openPath(target)
  if (error !== '') throw new Error(error)
}

/**
 * The root commands. Built here because every one of them needs something the
 * daemon owns — the index, the theme service, the process itself.
 */
const commands: readonly RegisteredCommand[] = rootCommands({
  reloadApplications: () => search?.reindex(),
  reloadConfig: () => reloadConfig('reload command'),
  reloadTheme: () => void theme.refresh('reload command'),
  openPath: (path) => shell.openPath(path),
  openSettings: () => launchSettings(),
  quit: () => quit(),
  reloadExtensions: () => rescanExtensions(),
  configFile: paths.configFile,
  logFile: join(paths.logDir, 'lumanin.jsonl')
})

const rootCommandList = cachedRootCommands(commands)

/**
 * Everything the root can run: ours, then whatever is installed.
 *
 * One list, so the ranking sees them together — an extension's command competes
 * with an application and with `Reload Theme` on the same scale rather than in a
 * section of its own (see "ranked together" in `root-search.ts`).
 */
function allCommands(): readonly RootCommand[] {
  // Read per call rather than captured: `[extensions].disabled` is watched like
  // every other setting, so switching an extension off in `lumanin plugins` takes
  // effect on the next keystroke rather than on the next restart.
  const disabled = current().extensions.disabled.value
  return rootCommandList(extensions, disabled)
}

function status(host: ExtensionHostStatus): DaemonStatus {
  return {
    version: app.getVersion(),
    pid: process.pid,
    visible: panel?.isVisible ?? false,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    sessionType: profile.sessionType,
    desktop: describePlatform(profile),
    backends: chosenBackends(),
    extensionHost: host
  }
}

function chosenBackends(): Readonly<Record<string, string>> {
  if (platform === null) return {}
  return Object.fromEntries(platform.report.map((c) => [c.capability, c.chosen ?? c.status]))
}

/**
 * `status` is the one verb worth waiting on the probes for. The CLI starts the
 * daemon and asks immediately, so without this the first `lumanin status` after
 * boot would report an empty backend set — which reads as "nothing works" rather
 * than "ask again in 300 ms".
 */
async function statusWhenProbed(): Promise<DaemonStatus> {
  await platformReady
  return status((await extensionHost?.probe()) ?? HOST_NOT_RUNNING)
}

function emit<E extends EventName>(event: E, payload: EventMap[E]): void {
  // A headless session's `confirmAlert` never reaches the renderer: nothing
  // there would answer it, and the blocked worker would be killed after the
  // grace window with its action silently untaken. Main answers instead —
  // always dismissed, never confirmed — and tells the user where to run it.
  if (event === 'ext.alert') {
    const consumed = answerHeadlessAlert(
      payload as AlertPayload,
      (sessionId) => headlessSessions.get(sessionId),
      (token, confirmed) => extensionHost?.answerAlert(token, confirmed),
      (text) => headlessNotice(text)
    )
    if (consumed) return
  }
  panel?.webContents?.send(EVENT_CHANNEL, { event, payload })
}

/**
 * A user-visible notice from a session that has no window.
 *
 * The HUD event alone would land in a hidden panel, which is nothing on
 * screen, so a desktop notification carries the same text where one exists.
 */
function headlessNotice(text: string): void {
  logger.info('headless notice', { text })
  emit('ext.hud', { title: text })
  if (Notification.isSupported()) {
    new Notification({ title: APP_DISPLAY_NAME, body: text }).show()
  }
}

// ---------------------------------------------------------------------------
// Verb dispatch — one implementation shared by the socket and by Electron's
// second-instance argv forwarding, so the two transports cannot drift.
// ---------------------------------------------------------------------------

let lastToggleAt: number | null = null

/**
 * The last `open` and when, for burst coalescing — **per target**.
 *
 * `open` flips the panel now, so a held key would otherwise open and close it
 * once per repeat, which is the same problem `toggle` has and the same fix. Kept
 * per target rather than as one timestamp because a burst is one key repeating:
 * two *different* keys arriving in the same 120 ms are two decisions, and
 * swallowing the second would mean a bound key silently doing nothing.
 */
let lastOpen: { readonly target: string; readonly at: number } | null = null

/**
 * The `open` target the panel is currently showing, or `null` for anything else.
 *
 * Every key that is not the global one runs `lumanin open <target>` — file
 * search, a plugin command, a pinned category or row. A key that only ever
 * opened would be the one key on the desktop that cannot put away what it took
 * out, so pressing it again while its own target is up hides the panel, which
 * ends the session with it (see `onVisibilityChange`).
 *
 * Set only when the target actually opened a window: a bound *action* runs
 * headless and never shows anything, so it has nothing to close.
 */
let panelTarget: string | null = null

function handleVerb(request: Request): Response | Promise<Response> {
  const { id, verb } = request
  logger.debug('verb', { kind: verb.kind })

  switch (verb.kind) {
    case 'toggle': {
      // Holding the hotkey fires one of these every ~30 ms, and each is a real
      // map or unmap of a Wayland surface — see `shared/toggle.ts`.
      const now = Date.now()
      const burst = coalesceToggle(now, lastToggleAt)
      lastToggleAt = now
      if (burst) {
        // Answered `ok`, not refused: the caller asked for the panel to be
        // toggled and it has been, just not twice.
        logger.debug('coalesced a repeated toggle')
        return { id, ok: true }
      }
      panel?.toggle()
      return { id, ok: true }
    }
    case 'show':
      panel?.show()
      return { id, ok: true }
    case 'hide':
      panel?.hide()
      return { id, ok: true }
    case 'status':
      return statusWhenProbed().then((data) => ({ id, ok: true, data }))
    case 'ping':
      return { id, ok: true }
    case 'reload': {
      // "Reload" means everything the daemon reads off disk, not just the config
      // file — `lumanin plugin-install` finishes by sending this, and an install
      // that needed a second command to become visible would be a worse install.
      rescanExtensions()
      const pending = reloadConfig('reload verb')
      return pending.length === 0
        ? { id, ok: true }
        : {
            id,
            ok: false,
            error: `reloaded, but ${pending.join(' and ')} need a restart (\`lumanin quit\` then your hotkey)`
          }
    }
    case 'quit':
      // Reply first; the socket is torn down inside `quit()`.
      setTimeout(() => quit(), 0)
      return { id, ok: true }
    case 'open': {
      // What a `[[hotkeys]]` bind runs. Activation is the same code path as
      // Enter on a row, so a `shell:` target stays gated on being named in the
      // config, and an unknown target is refused rather than guessed at.
      if (search === null) return { id, ok: false, error: 'the daemon is still starting' }
      const now = Date.now()
      const burst = coalesceToggle(now, lastOpen?.target === verb.target ? lastOpen.at : null)
      lastOpen = { target: verb.target, at: now }
      if (burst) {
        logger.debug('coalesced a repeated open', { target: verb.target })
        return { id, ok: true }
      }
      if (panel !== null && panel.isVisible && panelTarget === verb.target) {
        // The same key on what it opened: put it away, however deep the user
        // navigated inside it. Hiding is what ends the session, so this closes
        // the whole stack rather than one pushed view of it.
        panelTarget = null
        panel.hide()
        return { id, ok: true }
      }
      return search.activate(verb.target).then((outcome) => {
        if (!outcome.ok) return { id, ok: false, error: outcome.detail }
        if (outcome.session !== undefined) {
          // The panel becomes the plugin's view. Told to the renderer first,
          // shown second, so what appears is already the right screen.
          //
          // `standalone`: this session *is* the panel — a key opened it, and
          // there is no root list behind it to go back to. See `SessionInfo`.
          emit('ext.started', { ...outcome.session, standalone: true })
          panelTarget = verb.target
          panel?.show()
        }
        return { id, ok: true }
      })
    }
    case 'enumerate':
      return enumerateItems(verb.command, verb.category).then(
        (data) => ({ id, ok: true, data }),
        (error: unknown) => ({
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      )
  }
}

/** How long a plugin gets to render its list for `enumerate` before we give up. */
const ENUMERATE_TIMEOUT_MS = 8000

/**
 * How long a headless action gets to finish before its worker is taken away.
 *
 * An action's `onAction` is fire-and-forget from here — nothing acknowledges it
 * — so this is the window in which it can still be doing work: opening a file,
 * writing to storage, finishing a request. Ending sooner would kill work the
 * user asked for mid-flight; the session is closed the moment the plugin ends
 * it itself (`popToRoot`), which is the common case and costs nothing.
 */
const ACTION_GRACE_MS = 5000

/**
 * Sessions running with no window, by id — the value is what a notice about
 * the session calls it: the action title for a bound action, else the command
 * title. `emit` consults this to answer a `confirmAlert` that would otherwise
 * wait forever on a renderer that does not exist.
 */
const headlessSessions = new Map<string, string>()

/**
 * Run a plugin's command with no window and hand its settled tree to `read`.
 *
 * The `enumerate` verb's mechanism, and the one a bound action uses too: launch
 * exactly as a real launch would — same context contract, plus `enumerate: true`
 * so a plugin can skip cosmetic work if it wants — then poll main's own
 * materialised tree until the top view is a `List` that has finished loading.
 * The session is destroyed either way; nothing of it ever reaches the panel.
 *
 * `retain` hands that last part to the caller. An action needs its worker to
 * outlive the answer — it may still be doing what it was asked to do — while a
 * caller that only read the tree has no reason to keep one alive.
 */
async function withHeadlessList<T>(
  commandId: string,
  context: Readonly<Record<string, unknown>>,
  read: (tree: RenderNode, sessionId: string) => T | Promise<T>,
  retain = false,
  label?: string
): Promise<T> {
  const command = extensionCommand((candidate) => candidate.id === commandId)
  if (command === null || extensionHost === null) {
    throw new Error('that plugin command is not installed')
  }

  const host = extensionHost
  // Registered before the command runs, not after `launch` resolves: a
  // `confirmAlert` fired during the initial render must already find the
  // session here, or `emit` would forward it to a renderer that does not exist.
  const name = label ?? command.spec.title
  let launchedId: string | null = null
  let session
  try {
    session = await host.launch(
      command,
      { ...context, enumerate: true },
      {
        headless: true,
        onSession: (sessionId) => {
          launchedId = sessionId
          headlessSessions.set(sessionId, name)
        }
      }
    )
  } catch (error) {
    if (launchedId !== null) headlessSessions.delete(launchedId)
    throw error
  }
  let keep = false
  try {
    const deadline = Date.now() + ENUMERATE_TIMEOUT_MS
    for (;;) {
      const snapshot = host.snapshot(session.sessionId)
      if (snapshot === null) throw new Error('the plugin stopped before it finished rendering')
      if (listItemsOf(snapshot.tree) !== null) {
        const answer = await read(snapshot.tree, session.sessionId)
        keep = retain
        return answer
      }
      if (Date.now() > deadline) {
        throw new Error('the plugin did not finish rendering in time')
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } finally {
    // A failed read closes the session whatever `retain` says: there is nothing
    // left running that anyone is waiting on.
    if (!keep) {
      headlessSessions.delete(session.sessionId)
      host.close(session.sessionId)
    }
  }
}

/**
 * Ask a plugin what rows a category holds, without a window.
 *
 * The config screen's half of item pinning — and of binding a key to one action
 * on one row, which is why each row reports its actions too.
 */
async function enumerateItems(commandId: string, category: string | null): Promise<EnumerateData> {
  const extension = extensionCommand((candidate) => candidate.id === commandId)?.extension.manifest.name ?? ''
  return await withHeadlessList(commandId, category === null ? {} : { category }, (tree) => ({
    items: (listItemsOf(tree, extension) ?? []).map((item) => ({
      ...item,
      // An inline image is written to disk once and the pin keeps a short URL.
      icon: item.icon !== null && item.icon.startsWith('data:') ? storePinIcon(paths.data, item.icon) : item.icon
    }))
  }))
}

/**
 * Run one action on one row, with no window at all.
 *
 * This is the whole of what a key bound to "Dawnline → Open project" does: the
 * plugin renders headless, the row is found by the `id` it declared, its action
 * is found by title, and the handler behind it is dispatched exactly as if the
 * user had pressed Enter on it. The panel never appears — a bound action is a
 * key that *does the thing*, which is the entire reason to bind one.
 *
 * Feedback follows the rule every other `open` target already lives by: the
 * outcome goes back over the socket and into the log, and a plugin's own
 * `showHUD` is its own business. Nothing here opens a window to report success.
 */
async function runItemAction(
  commandId: string,
  category: string,
  item: string,
  action: string
): Promise<{ ok: boolean; detail: string }> {
  const context = { ...(category.length === 0 ? {} : { category }), item }
  return await withHeadlessList(
    commandId,
    context,
    (tree, sessionId) => {
      const handlerId = actionHandlerOf(tree, item, action)
      if (handlerId === null) {
        // Nothing was dispatched, so there is nothing to keep alive: release
        // the worker now rather than retaining a session with no work in it.
        headlessSessions.delete(sessionId)
        extensionHost?.close(sessionId)
        return { ok: false, detail: `that plugin no longer offers “${action}” on that row` }
      }

      extensionHost?.event(sessionId, handlerId, null)
      void releaseAfterAction(sessionId)
      // Answered as soon as the action has been dispatched, not when its worker
      // is finally released: what runs this is a compositor bind, and a process
      // that lingers five seconds after the work is done is a process somebody
      // will eventually wonder about.
      return { ok: true, detail: `ran ${action}` }
    },
    true,
    action
  )
}

/**
 * Keep a dispatched action's worker for as long as it might still be working.
 *
 * Nothing acknowledges an action — `onAction` is fire-and-forget from here — so
 * the only honest options are a grace window or killing work the user asked
 * for. The window ends early the moment the plugin ends its own session, which
 * is what `popToRoot` and a finished command already do.
 */
async function releaseAfterAction(sessionId: string): Promise<void> {
  try {
    const deadline = Date.now() + ACTION_GRACE_MS
    while (Date.now() < deadline) {
      if (extensionHost?.snapshot(sessionId) == null) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    extensionHost?.close(sessionId)
  } finally {
    headlessSessions.delete(sessionId)
  }
}

function quit(): void {
  logger.info('daemon shutting down')
  if (configReloadTimer !== null) clearTimeout(configReloadTimer)
  if (extensionsRescanTimer !== null) clearTimeout(extensionsRescanTimer)
  if (prewarmTimer !== null) clearTimeout(prewarmTimer)
  configWatcher?.close()
  extensionsWatcher?.close()
  search?.dispose()
  extensionHost?.dispose()
  extensionStore?.close()
  theme.dispose()
  socket?.close()
  panel?.destroy()
  app.exit(0)
}

// ---------------------------------------------------------------------------
// Renderer IPC. Method names are checked against an allow-list before dispatch;
// the renderer is untrusted input by design.
// ---------------------------------------------------------------------------

// The daemon's renderer is the panel and only the panel: `settings.close`
// belongs to the settings app, which is a separate process with its own
// `ipcMain` — a daemon that answered it would be answering for a window it
// does not own.
const invokeMethods = new Set<string>(INVOKE_METHODS.filter((method) => method !== 'settings.close'))

function registerIpc(): void {
  ipcMain.handle(INVOKE_CHANNEL, (event: IpcMainInvokeEvent, method: unknown, params: unknown) => {
    if (typeof method !== 'string' || !invokeMethods.has(method)) {
      logger.warn('rejected renderer invoke', { method: String(method) })
      throw new Error('unknown method')
    }

    // A frame we did not create must not be able to drive the daemon. This is
    // unconditional on purpose: gating it on `senderFrame` being populated meant
    // the check skipped itself in exactly the cases where the sender was unusual.
    if (panel?.webContents?.id !== event.sender.id) {
      logger.warn('rejected invoke from unexpected sender', { method })
      throw new Error('unknown method')
    }

    switch (method as InvokeMethod) {
      case 'app.status':
        return statusWhenProbed()
      case 'window.hide':
        panel?.hide()
        return undefined
      case 'window.escape': {
        // `esc_at_root` governs the root only; anywhere else Esc backs out one
        // step. Anything but an explicit `atRoot: true` is treated as "not at
        // root" — the conservative reading, since backing out is recoverable and
        // hiding the panel is not.
        const atRoot = (params as { atRoot?: unknown } | undefined)?.atRoot === true
        const action = escapeAction(config.general.escAtRoot.value, atRoot)
        if (action === 'hide') panel?.hide()
        // 'clear' is the renderer's job (clear the query); 'none' does nothing.
        return { action }
      }
      case 'theme.current':
        return theme.payloadNow
      case 'keys.current':
        return current().keys.value
      case 'search.query': {
        const query = (params as { query?: unknown } | undefined)?.query
        if (typeof query !== 'string' || search === null) return []
        return search.search(query)
      }
      case 'search.launch': {
        const id = (params as { id?: unknown } | undefined)?.id
        if (typeof id !== 'string' || search === null) {
          return { ok: false, detail: 'the application index is not ready yet' }
        }
        return search.activate(id).then((result) => {
          // Hiding is the daemon's call, not the renderer's: the panel must be
          // gone before the launched window maps, or it steals the focus back.
          //
          // An extension launch is the exception, and the only one: the panel
          // *becomes* the extension's view, so hiding it would close the thing
          // that was just opened.
          if (result.ok && result.session === undefined) panel?.hide()
          return result
        })
      }

      case 'ext.event': {
        const { sessionId, handlerId, payload } = (params ?? {}) as {
          sessionId?: unknown
          handlerId?: unknown
          payload?: unknown
        }
        if (typeof sessionId !== 'string' || typeof handlerId !== 'string') return undefined
        extensionHost?.event(sessionId, handlerId, payload)
        return undefined
      }
      case 'ext.pop':
        extensionHost?.pop(sessionIdOf(params))
        return undefined
      case 'ext.close':
        extensionHost?.close(sessionIdOf(params))
        return undefined
      case 'ext.reload':
        extensionHost?.reload(sessionIdOf(params))
        return undefined
      case 'ext.attach':
        return extensionHost?.snapshot(sessionIdOf(params)) ?? null
      case 'ext.alertAnswer': {
        const { token, confirmed } = (params ?? {}) as { token?: unknown; confirmed?: unknown }
        if (typeof token !== 'string') return undefined
        extensionHost?.answerAlert(token, confirmed === true)
        return undefined
      }
      case 'ext.pickFiles': {
        const { sessionId, directories, multiple } = (params ?? {}) as {
          sessionId?: unknown
          directories?: unknown
          multiple?: unknown
        }
        // Gated on a live session: this opens a dialog, and a renderer that could
        // ask for one without a command running could pop a file picker over
        // whatever the user is doing.
        if (typeof sessionId !== 'string' || extensionHost?.snapshot(sessionId) == null) return []
        // The promise is returned rather than awaited: `ipcMain.handle` resolves
        // one for us, and making this whole switch `async` for one case would
        // reindent every other verb in it.
        return panel?.openFiles({
          directories: directories === true,
          multiple: multiple === true
        }) ?? []
      }
    }
  })
}

function sessionIdOf(params: unknown): string {
  const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId
  return typeof sessionId === 'string' ? sessionId : ''
}


/**
 * How long the renderer may reuse an icon it already has.
 *
 * A URL here names an application id or an icon name, and it keeps naming the
 * same one when an upgrade replaces the file behind it, so the panel can go on
 * painting the old bytes until the window reloads. That staleness is accepted
 * for the price it pays: scrolling a long list twice reads the disk once.
 */
const ICON_MAX_AGE_SECONDS = 86_400

/**
 * Serve `lumanin-icon://app/<desktop-file-id>`.
 *
 * The renderer never names a file — it names a result, and main answers with
 * whatever that result's icon resolved to. An id that is not in the current
 * index gets a 404, so a stale URL cannot read anything.
 */
function registerIconProtocol(): void {
  protocol.handle(ICON_SCHEME, async (request) => {
    const url = new URL(request.url)
    // `lumanin-icon://app/<id>`, `lumanin-icon://ext/<extension>/<path>`,
    // `lumanin-icon://theme/<names>` and `lumanin-icon://pin/<hash>.<ext>`.
    // The host is the namespace rather than a path segment, because Chromium
    // normalises the host and leaves the path alone — putting the namespace in
    // the path would let `..` in a crafted URL escape it.
    const file =
      url.host === 'ext'
        ? extensionAsset(url.pathname)
        : url.host === 'theme'
          ? themeIcon(url.pathname)
          : url.host === 'pin'
            ? pinIconPath(paths.data, url.pathname)
            : appIcon(url.pathname)

    if (file === null) return new Response(null, { status: 404 })

    try {
      const response = await net.fetch(pathToFileURL(file).toString())
      const headers = new Headers(response.headers)
      headers.set('Cache-Control', `max-age=${ICON_MAX_AGE_SECONDS}`)
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      })
    } catch {
      // A file that vanished between resolving and reading is a 404 like any
      // other missing icon; left to reject, it surfaces as an unhandled promise.
      return new Response(null, { status: 404 })
    }
  })
}

function appIcon(pathname: string): string | null {
  const id = decodeURIComponent(pathname.replace(/^\//, ''))
  return search?.iconPath(id) ?? null
}

/**
 * `lumanin-icon://theme/<name>[,<fallback>…]` — an icon from the desktop's own
 * icon theme.
 *
 * The renderer names an *icon*, never a file: the answer comes out of the theme
 * directories the application index already searches, so this cannot be turned
 * into a general file reader by a crafted URL. The name is checked for it —
 * anything with a separator in it is refused rather than sanitised, because a
 * legitimate icon name has never contained one.
 */
function themeIcon(pathname: string): string | null {
  const names = decodeURIComponent(pathname.replace(/^\//, ''))
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)

  if (names.length === 0) return null
  if (names.some((name) => /[/\\]|\.\./.test(name))) {
    logger.warn('refused a theme icon name containing a path separator')
    return null
  }
  return search?.themeIconPath(names) ?? null
}

/**
 * An asset inside an installed extension's `assets/` directory.
 *
 * Three checks, and each one has to be there. The extension must be *installed*
 * (a name from the renderer is not a directory name); the resolved path must
 * still be inside that extension's assets directory after `..` is resolved; and
 * the request cannot escape into the extension's code or its stored data, which
 * live next to `assets/` and are not ours to serve to a web page.
 */
function extensionAsset(pathname: string): string | null {
  const segments = pathname
    .replace(/^\//, '')
    .split('/')
    .map((segment) => decodeURIComponent(segment))

  const name = segments.shift()
  if (name === undefined || segments.length === 0) return null

  const extension = extensions.extensions.find((candidate) => candidate.manifest.name === name)
  if (extension === undefined) return null

  const resolved = resolve(extension.assetsPath, ...segments)
  const root = `${resolve(extension.assetsPath)}/`
  if (!resolved.startsWith(root)) {
    logger.warn('refused an extension asset outside its assets directory', { extension: name })
    return null
  }
  return resolved
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.on('second-instance', (_event, argv, workingDirectory) => {
  const parsed = parseArgs(userArgsFrom(argv, workingDirectory))

  if (parsed.verb === null) {
    logger.warn('second instance had no runnable verb', { unknown: parsed.unknown })
    return
  }
  // Argv forwarding has no reply channel — the second process has already
  // printed and exited — so the result is discarded, but never left unhandled.
  void Promise.resolve(handleVerb({ id: 0, verb: parsed.verb })).catch((error: unknown) => {
    logger.error('forwarded verb failed', { kind: parsed.verb?.kind, error })
  })
})

/**
 * Extract what the user actually typed from a second instance's argv.
 *
 * Electron hands over the raw argv, which starts with the executable and — when
 * the app is run from a source tree rather than packaged — also carries the app
 * directory (`electron . toggle`). Treating that path as a positional argument
 * makes every verb look like an unknown one, so it is dropped explicitly rather
 * than by scanning for something that happens to parse.
 */
function userArgsFrom(argv: readonly string[], workingDirectory: string): string[] {
  const appPath = app.getAppPath()

  return argv.slice(1).filter((arg) => {
    if (arg.startsWith('-')) return false
    return resolve(workingDirectory, arg) !== appPath
  })
}

app.whenReady().then(async () => {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'] ?? null

  applyCsp(devServerUrl)
  registerIpc()
  registerIconProtocol()

  // Started here and awaited later. The probes shell out a dozen times, and
  // holding the socket closed for that long would make the very first
  // `lumanin toggle` after login wait on a diagnostic — but anything that needs
  // a backend can wait on the promise instead of racing it.
  platformReady = probePlatform().then((probed) => {
    probedBinaries = probed.binaries
    const runtime = createRuntime({
      profile: probed,
      systemClipboard: clipboard,
      home: paths.home,
      dataHome: paths.dataHome
    })
    platform = runtime

    // The chain's second link needs a probed backend, so the theme starts as the
    // built-in default and upgrades to the desktop's a moment later. That is a
    // visible repaint only on the first window of a session, and only if the user
    // beats the probes to it.
    void theme.attach(runtime.appearance, runtime.blurGranted, runtime.toolkitTextScale)

    // The index needs the probe's binary map and desktop list, so it is built
    // here rather than earlier. Indexing is disk-bound and takes tens of
    // milliseconds; doing it once at startup is what keeps every later keystroke
    // pure arithmetic.
    extensionStore = new ExtensionStore(paths.data)
    extensionHost = new ExtensionHost({
      logger,
      store: extensionStore,
      hostScript: join(__dirname, 'host.js'),
      compileCacheDir: join(paths.cache, 'compile-cache'),
      // `EmitMap` is a narrow view of the renderer's `EventMap` — the host may
      // raise the `ext.*` events and nothing else — so the daemon's `emit` is
      // handed over restricted to exactly those.
      emit: (event, payload) => emit(event, payload as EventMap[typeof event]),
      closeWindow: ({ clearRootSearch }) => {
        // `clearRootSearch` is the renderer's to honour — it owns the query —
        // and it hears about the hide through `window.visibility`, which already
        // resets the panel. So there is nothing extra to do here, and doing it
        // anyway would be a second reset racing the first.
        void clearRootSearch
        panel?.hide()
      },
      commands: {
        /**
         * The target of a `launchCommand`.
         *
         * Matched on the manifest's `name`, not the display title — that is what
         * the spec's `name` field means and what an extension author writes.
         * `ownerOrAuthorName` is deliberately not part of the match: we have no
         * registry namespace, so an installed extension name is already unique
         * here, and requiring the author would refuse launches that are exactly
         * right.
         */
        find: (extensionName, commandName) =>
          extensionCommand(
            (candidate) =>
              candidate.extension.manifest.name === extensionName &&
              candidate.spec.name === commandName
          ),
        present: (session) => {
          emit('ext.started', session)
          panel?.show()
        }
      },
      clipboard: {
        // A concealed copy goes through `wl-copy --sensitive` so clipboard
        // managers skip recording it; routing and probe notes in clipboard-copy.ts.
        copy: createCopy({
          electron: clipboard,
          backend: async () => (await platformReady)?.clipboard
        }),
        paste: async ({ text, html, file }) => {
          const payload = file ?? text ?? html ?? ''
          const backend = (await platformReady)?.paste
          // The panel has to be gone before anything is injected: the paste goes
          // to whatever is focused, and while we are up, that is us.
          panel?.hide()
          await backend?.paste(payload)
        },
        read: async () => {
          await Promise.resolve()
          return { text: clipboard.readText() }
        },
        clear: async () => {
          clipboard.clear()
          await Promise.resolve()
        }
      },
      selection: async () => (await (await platformReady)?.selection.readText()) ?? '',
      open: async (target, application) => {
        void application // `OpenWith` is not built; `open()` uses the desktop's default.
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) await shell.openExternal(target)
        else await openFile(target)
      },
      trash: async (targets) => {
        for (const target of targets) await shell.trashItem(target)
      },
      applications: async (query) => {
        void query
        await Promise.resolve()
        // Backed by the `.desktop` index the launcher already builds, so an extension's
        // `getApplications()` sees exactly what the launcher does.
        return search?.applications() ?? []
      },
      appearance: () => theme.payloadNow.meta.variant,
      apiVersion: RAYCAST_API_VERSION,
      isDevelopment: devServerUrl !== null
    })

    rescanExtensions()
    watchExtensionsDir()

    search = new SearchService({
      config: current,
      commands: allCommands,
      actions: {
        // Electron's clipboard rather than the platform backend: this is our own
        // window's copy, not an injection into somebody else's, so it needs
        // nothing the platform layer provides.
        copy: (text) => clipboard.writeText(text),
        openUrl: (url) => void shell.openExternal(url),
        runCommand: async (id) => {
          const command = commands.find((candidate) => candidate.id === id)
          if (command === undefined) return { ok: false, detail: 'that command no longer exists' }
          return await command.run()
        },
        runExtension: async (id, context) => {
          const command = extensionCommand((candidate) => candidate.id === id)
          if (command === null || extensionHost === null) {
            return { ok: false, detail: 'that extension command is no longer installed' }
          }
          try {
            const session = await extensionHost.launch(command, context)
            return { ok: true, detail: `started ${command.spec.title}`, session }
          } catch (error) {
            // The message is shown verbatim, because the useful ones are written
            // for a person: a missing required preference names the preference.
            const detail = error instanceof Error ? error.message : String(error)
            logger.error('could not start an extension command', { id, error })
            return { ok: false, detail }
          }
        },
        runExtensionAction: async (id, category, item, action) => {
          try {
            return await runItemAction(id, category, item, action)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            logger.error('could not run a plugin action', { id, item, action, error })
            return { ok: false, detail }
          }
        }
      },
      env: process.env,
      home: process.env['HOME'] ?? '',
      desktops: probed.desktops,
      binaries: probed.binaries,
      frecency: new FrecencyStore(paths.data),
      logger
    })
    search.reindex()
    // Watch after the first build: the watch list comes from the directories
    // that actually exist, which is something only the index knows.
    search.watch()

    // Ids only. `doctor` prints the full chain and the reasons; the log needs the
    // outcome, and a line per candidate would bury the startup record.
    logger.info('platform backends selected', { chosen: chosenBackends() })

    prewarmTimer = setTimeout(() => {
      prewarmTimer = null
      if (!anyExtensionEnabled()) return
      extensionHost?.prewarm()
    }, PREWARM_DELAY_MS)
    prewarmTimer.unref?.()

    return runtime
  })

  panel = new PanelWindow({
    config: current,
    profile,
    logger,
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: devServerUrl,
    rendererFile: join(__dirname, '../renderer/index.html'),
    onVisibilityChange: (visible) => {
      emit('window.visibility', { visible })
      // Freshness backstop, deliberately after the show rather than before it:
      // it stats the application directories and re-indexes only when one of
      // them changed, or when a directory has no watcher and the index is old.
      // The rebuild is armed on a short timer so it cannot run inside the first
      // frames after the show.
      if (visible) search?.refreshIfStale()
      // The first time the panel is ever summoned on an unconfigured machine,
      // open the setup wizard alongside it — the panel works with defaults, but
      // the person has no way of knowing there are keys to choose. Offered
      // once, ever: the marker is written first, so this cannot nag.
      if (visible && firstRunPending(paths.configFile, paths.state)) {
        markFirstRunOffered(paths.state)
        if (launchSettings()) logger.info('first run: opened the setup wizard')
      }
      // Dismissing the panel ends whatever it was showing. An extension that
      // kept running invisibly would keep polling, keep its worker's heap, and
      // — worse — be there again with stale data the next time the panel opened,
      // which reads as the launcher having remembered something it should not.
      //
      // `!visible`, never an `else` off the first-run check above: chained that
      // way, every *show* on a configured machine landed here and closed the
      // session the panel had just opened — a standalone view died the moment
      // its window appeared.
      if (!visible) {
        extensionHost?.closeAll()
        // Whatever a key opened is gone with it, whether it was that key,
        // Escape, the global toggle or a lost focus that closed the panel. The
        // next press of that key opens rather than closes.
        panelTarget = null
      }
    }
  })
  panel.setTextScale(theme.payloadNow.textScale, theme.toolkitScaleNow)
  panel.create()

  watchConfigFile()

  socket = new ControlSocket({
    socketPath: paths.socket,
    logger,
    uid: process.getuid?.() ?? 0,
    version: app.getVersion(),
    handle: handleVerb
  })

  try {
    await socket.listen()
  } catch (error) {
    // Without the socket the CLI falls back to spawning us, which still works —
    // it is just slower. This is a degradation, not a failure to start.
    logger.error('control socket unavailable; CLI will use the slow path', { error })
    socket = null
  }

  logger.info(`${APP_DISPLAY_NAME} daemon ready`, {
    platform: describePlatform(profile),
    placement: panel.placementMode,
    config: paths.config,
    version: app.getVersion()
  })

  // A launcher's whole point is being ready before you ask for it. Starting
  // hidden is the intended behaviour, not a bug to work around.
  if (process.argv.includes('--show')) panel.show()
})

// The daemon outlives its window by design; closing all windows must not quit.
app.on('window-all-closed', () => {})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => quit())
}
