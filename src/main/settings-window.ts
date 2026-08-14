import { BrowserWindow } from 'electron'
import { SETTINGS_WINDOW_TITLE } from '../shared/identity'
import type { Logger } from '../node/logger'
import { hardenNavigation } from './window'

/**
 * The settings app's window. The process it runs in is `settings-app.ts` — its
 * own application with its own window class, so nothing here has anything to do
 * with the panel or its compositor rules.
 *
 * Frameless like the panel — the titlebar is the renderer's, drawn with the
 * theme's own tokens, so the settings app looks like the launcher rather than
 * like a GTK dialog wearing its colours. That shared visual language is the
 * whole of what the two applications have in common.
 */

export interface SettingsWindowDeps {
  readonly logger: Logger
  readonly preloadPath: string
  /** Dev server URL, or `null` to load the built renderer from disk. */
  readonly rendererUrl: string | null
  readonly rendererFile: string
}

const DEFAULT_WIDTH = 920
const DEFAULT_HEIGHT = 620
const MIN_WIDTH = 680
const MIN_HEIGHT = 440

export class SettingsWindow {
  private window: BrowserWindow | null = null

  constructor(private readonly deps: SettingsWindowDeps) {}

  /** Open the window, creating it if there is none, and give it the focus. */
  open(): void {
    const existing = this.window
    if (existing !== null && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return
    }

    const { logger, preloadPath, rendererUrl, rendererFile } = this.deps

    const window = new BrowserWindow({
      title: SETTINGS_WINDOW_TITLE,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      // Shown on ready-to-show instead: the first paint should already be the
      // themed page, not a flash of the background colour below.
      show: false,
      frame: false,
      autoHideMenuBar: true,
      // A stand-in for the theme's dark ground, painted only in the frames
      // before the renderer's CSS takes over. Not a themed surface — components
      // never see it — which is why a literal is tolerable here and nowhere
      // else.
      backgroundColor: '#161616',
      webPreferences: {
        preload: preloadPath,
        // Same renderer contract as the panel — SECURITY.md §Renderer. The
        // allow-list in main is per sender, so this window's page can reach
        // only `SETTINGS_INVOKE_METHODS` even though the bridge is shared.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false
      }
    })

    this.window = window
    hardenNavigation(window, logger, rendererUrl)

    window.webContents.on('did-fail-load', (_e, code, description, url) => {
      logger.error('settings renderer failed to load', { code, description, url })
    })
    window.webContents.on('preload-error', (_e, preload, error) => {
      logger.error('settings preload threw', { preload, error: error.message })
    })
    // Same reason the panel logs these: nobody is watching a GUI's console, and
    // a rejected invoke would otherwise fail into silence.
    window.webContents.on('console-message', (event) => {
      const level = event.level === 'error' || event.level === 'warning' ? 'warn' : 'debug'
      logger[level]('settings renderer console', {
        message: event.message,
        source: `${event.sourceId}:${String(event.lineNumber)}`
      })
    })

    const reveal = (): void => {
      if (window.isDestroyed() || window.isVisible()) return
      window.show()
      window.focus()
    }
    window.once('ready-to-show', reveal)
    // `ready-to-show` is the first paint — and on Wayland a hidden window may
    // never be given a frame to paint, so waiting for it can wait forever
    // (observed on sway: the window existed, the DOM was live, and not one
    // frame was ever produced). The timer is the honest fallback: one beat for
    // the pretty first-paint path, then shown regardless, because a window
    // that flashes its background once beats a window that never appears.
    setTimeout(reveal, 500)

    // Closed means closed: the daemon keeps running, the window is rebuilt on
    // the next `lumanin settings`. `destroy` in flight sets `window` first, so
    // the handler tolerates already being forgotten.
    window.on('closed', () => {
      if (this.window === window) this.window = null
    })

    if (rendererUrl !== null) {
      void window.loadURL(`${rendererUrl.replace(/\/$/, '')}/settings.html`)
    } else {
      void window.loadFile(rendererFile)
    }

    logger.info('settings window opened', { title: SETTINGS_WINDOW_TITLE })
  }

  close(): void {
    const window = this.window
    if (window === null || window.isDestroyed()) return
    window.close()
  }

  destroy(): void {
    const window = this.window
    this.window = null
    if (window === null || window.isDestroyed()) return
    window.destroy()
  }

  /** Only for wiring IPC senders; callers must not reach past this. */
  get webContents(): Electron.WebContents | null {
    const window = this.window
    return window === null || window.isDestroyed() ? null : window.webContents
  }
}
