import { mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { app, clipboard } from 'electron'
import { probePlatform, type PlatformProfile } from '../platform/detect'
import { createRuntime } from '../platform/runtime'
import { loadConfig, type ResolvedConfig } from '../shared/config'
import { CONFIG_BASENAME, SETTINGS_WINDOW_CLASS } from '../shared/identity'
import { EVENT_CHANNEL, type EventMap, type EventName } from '../shared/ipc'
import { createFileSink, createStderrSink, Logger } from '../node/logger'
import { bundledPluginsDir, resolvePaths } from '../node/paths'
import { applyCsp } from './csp'
import { SettingsIpc } from './settings-ipc'
import { SettingsWindow } from './settings-window'
import { loadWindowBounds, saveWindowBounds } from './settings-window-state'
import { ThemeService } from './theme'
import { applyTextScale } from './text-scale'

/**
 * The settings app — `lumanin settings`, and what `lumanin-settings.desktop`
 * launches.
 *
 * A completely separate application from the launcher. Its own process, its own
 * window class ({@link SETTINGS_WINDOW_CLASS}), its own profile directories and
 * single-instance lock; no socket, no daemon, no extension host. It shares the
 * launcher's *visual language* — the theme chain and the semantic tokens — and
 * nothing else: the panel's compositor rules can never match this window, and
 * the launcher does not know or care whether this process exists.
 *
 * It edits `config.toml` through the same code the CLI uses, and the daemon —
 * if one is running — picks the changes up through the file watch it already
 * has. That is the whole integration: a file both applications read.
 */

// The application's name, class (`lumanin-settings` — what keeps the panel's
// `class:^(lumanin)$` rules away) and ozone hint are set by the entry
// dispatcher (`index.ts`), synchronously; see the timing note there.

const paths = resolvePaths()

// `data` included: the plugin screens read the installed extensions, which live
// under it, and a first run has none of these yet.
for (const dir of [paths.config, paths.data, paths.cache, paths.state, paths.logDir]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

// Its own Chromium profile, apart from the daemon's — two Electron processes
// sharing one profile directory corrupt it, and the daemon's is under
// `state/chromium` (see the daemon's note on why none of this may land in
// `~/.config/lumanin`).
app.setPath('userData', join(paths.state, 'chromium-settings'))
app.setPath('sessionData', join(paths.cache, 'chromium-settings'))

const logger = Logger.fromEnv([
  createStderrSink(),
  // Its own log file: two processes appending one JSONL interleave writes.
  createFileSink(paths.logDir, 'lumanin-settings.jsonl')
])

// One settings app at a time; a second launch focuses the first. The lock file
// lives in the userData set above, so it can never contend with the daemon's.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

function readConfigFile(): string | null {
  try {
    return readFileSync(paths.configFile, 'utf8')
  } catch {
    return null // No config file is the normal case, not an error.
  }
}

let config: ResolvedConfig = loadConfig({ fileContents: readConfigFile(), env: process.env })
const current = (): ResolvedConfig => config

const theme = new ThemeService({
  config: current,
  configDir: paths.config,
  logger,
  onChange: (payload) => {
    settingsWindow?.webContents?.send(EVENT_CHANNEL, { event: 'theme.changed', payload })
    const contents = settingsWindow?.webContents
    if (contents) applyTextScale(contents, payload.textScale)
    settingsWindow?.setScale(payload.textScale, theme.toolkitScaleNow)
  }
})

let settingsWindow: SettingsWindow | null = null
let configWatcher: FSWatcher | null = null
let configReloadTimer: ReturnType<typeof setTimeout> | null = null

/**
 * One probe for the whole app: the theme chain and the bind planner share it.
 * A rejection clears the slot — a cached rejected promise would fail every
 * later `settings.state`/`planBind` for the life of the process with no retry.
 */
let profilePromise: Promise<PlatformProfile> | null = null
const profileReady = (): Promise<PlatformProfile> => {
  profilePromise ??= probePlatform().catch((cause: unknown) => {
    profilePromise = null
    throw cause
  })
  return profilePromise
}

function send<E extends EventName>(event: E, payload: EventMap[E]): void {
  settingsWindow?.webContents?.send(EVENT_CHANNEL, { event, payload })
}

/**
 * Latest wins: a write and the watcher can both push, and `ipc.state()` is
 * async, so an older snapshot must not land after a newer one.
 */
let pushSequence = 0
function pushState(reason: 'write' | 'watch'): void {
  const sequence = ++pushSequence
  logger.debug('settings state push', { reason })
  void ipc
    .state()
    .then((state) => {
      if (sequence === pushSequence) send('settings.changed', state)
    })
    .catch((error: unknown) => {
      logger.warn('settings state push failed', { error })
    })
}

const ipc = new SettingsIpc({
  logger,
  paths,
  bundledDir: bundledPluginsDir(__dirname, process.resourcesPath),
  theme,
  profile: profileReady,
  senderId: () => settingsWindow?.webContents?.id ?? null,
  send,
  close: () => settingsWindow?.close(),
  currentConfig: current,
  onWritten: () => {
    config = loadConfig({ fileContents: readConfigFile(), env: process.env })
    pushState('write')
  }
})

/**
 * Watch `config.toml` — the daemon does the same, and this is the settings
 * app's half of following along: an edit made in the terminal menu, an editor,
 * or by our own save shows up here without a restart.
 */
function watchConfigFile(): void {
  try {
    configWatcher = watch(paths.config, { persistent: false }, (_event, filename) => {
      if (filename !== null && filename !== CONFIG_BASENAME) return
      if (configReloadTimer !== null) clearTimeout(configReloadTimer)
      configReloadTimer = setTimeout(() => {
        config = loadConfig({ fileContents: readConfigFile(), env: process.env })
        void theme.refresh('config.toml changed')
        // Whoever wrote the file — this app, the CLI, an editor — the screens
        // re-draw from what is now true.
        pushState('watch')
      }, 120)
    })
    configWatcher.on('error', () => undefined)
  } catch {
    // No watch, no live reload — correctness is unaffected.
  }
}

app.on('second-instance', () => {
  settingsWindow?.open()
})

app.whenReady().then(async () => {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'] ?? null

  applyCsp(devServerUrl)
  ipc.register()

  const savedBounds = loadWindowBounds(paths.state)
  settingsWindow = new SettingsWindow({
    logger,
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: devServerUrl,
    rendererFile: join(__dirname, '../renderer/settings.html'),
    savedBounds,
    onBounds: (bounds) => {
      try {
        saveWindowBounds(paths.state, bounds)
      } catch (error) {
        logger.debug('settings window bounds not saved', { error })
      }
    }
  })

  // The theme chain needs the platform's appearance backend — Omarchy's
  // palette, the portal's light/dark, and the desktop's text scale. It is
  // ~150 ms; the cap keeps a stuck probe from keeping the window away, at the
  // cost of the built-in theme and a repaint when the real one lands.
  const attach = (async (): Promise<void> => {
    try {
      const probed = await profileReady()
      const runtime = createRuntime({
        profile: probed,
        systemClipboard: clipboard,
        home: paths.home,
        dataHome: paths.dataHome
      })
      await theme.attach(runtime.appearance, runtime.blurGranted, runtime.toolkitTextScale)
    } catch (error) {
      logger.warn('appearance probing failed; staying on the built-in theme', { error })
    }
  })()
  const attachOrCap = Promise.race([attach, new Promise<void>((done) => setTimeout(done, 1500))])

  await attachOrCap
  settingsWindow.setScale(theme.payloadNow.textScale, theme.toolkitScaleNow)
  settingsWindow.open()
  {
    const contents = settingsWindow.webContents
    if (contents) applyTextScale(contents, theme.payloadNow.textScale)
  }

  watchConfigFile()
  await attach

  logger.info('settings app ready', { class: SETTINGS_WINDOW_CLASS })
})

// A normal application: the last window closing is the app closing.
app.on('window-all-closed', () => {
  if (configReloadTimer !== null) clearTimeout(configReloadTimer)
  configWatcher?.close()
  theme.dispose()
  ipc.dispose()
  app.quit()
})
