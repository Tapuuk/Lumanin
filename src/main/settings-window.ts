import { BrowserWindow, screen } from 'electron'
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
// Low on purpose. These are Chromium DIPs, and on Linux a DIP is the
// compositor's logical pixel times whatever text scale GTK reports (see
// `platform/appearance/toolkit-scale.ts`) - so a 680-DIP minimum was 807
// compositor pixels at Omarchy's 14px text size, wider than the half-screen a
// tiling compositor hands a new window. Chromium then kept its minimum, drew
// past the surface and the right third of every row was clipped. The layout
// reflows fine down to well under this (measured: no horizontal overflow at
// 480); the minimum only stops it becoming a sliver.
const MIN_WIDTH = 480
const MIN_HEIGHT = 360

export class SettingsWindow {
  private window: BrowserWindow | null = null
  private zoom = 1
  private toolkitScale = 1
  /** Set once the user has dragged the window to a size of their own. */
  private userSized = false

  constructor(private readonly deps: SettingsWindowDeps) {}

  /**
   * The text scale the page is zoomed by, and what the toolkit already applies
   * to every DIP (see `platform/appearance/toolkit-scale.ts`). The window is
   * sized so the same layout fits at any zoom: 920x620 at 1.0 is a cramped
   * 613x413 worth of content at 1.5, so the default grows with the zoom and is
   * clamped to the display. Applied on the next open, and to an open window
   * the user has not resized themselves - their size is theirs.
   */
  setScale(zoom: number, toolkitScale: number): void {
    this.zoom = zoom
    this.toolkitScale = toolkitScale
    const window = this.window
    if (window === null || window.isDestroyed() || this.userSized) return
    const size = this.fittedSize()
    const [w, h] = window.getSize()
    if (w === size.width && h === size.height) return
    this.applying = true
    this.deps.logger.info('settings window resized for text scale', { from: [w, h], to: size, zoom, toolkitScale })
    window.setSize(size.width, size.height)
    // The resize event this causes is ours, not the user's; it arrives after
    // this call returns, so the flag is cleared a beat later - and a second
    // call within that beat pushes the clearing out, never lets it fire early.
    if (this.applyingTimer !== null) clearTimeout(this.applyingTimer)
    this.applyingTimer = setTimeout(() => {
      this.applying = false
      this.applyingTimer = null
    }, 250)
  }
  private applying = false
  private applyingTimer: ReturnType<typeof setTimeout> | null = null

  private fittedSize(): { width: number; height: number } {
    const wanted = { width: DEFAULT_WIDTH * this.zoom, height: DEFAULT_HEIGHT * this.zoom }
    let area: { width: number; height: number } | null = null
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      area = display.workArea
    } catch {
      area = null
    }
    if (area === null) return { width: Math.round(wanted.width), height: Math.round(wanted.height) }
    // Work areas are compositor-logical; window sizes are DIPs, which differ by
    // the toolkit scale (same arithmetic as the panel's `fittedSize`).
    const maxW = (area.width / this.toolkitScale) * 0.94
    const maxH = (area.height / this.toolkitScale) * 0.9
    return {
      width: Math.max(MIN_WIDTH, Math.round(Math.min(wanted.width, maxW))),
      height: Math.max(MIN_HEIGHT, Math.round(Math.min(wanted.height, maxH)))
    }
  }

  /** Open the window, creating it if there is none, and give it the focus. */
  open(): void {
    const existing = this.window
    if (existing !== null && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return
    }

    const { logger, preloadPath, rendererUrl, rendererFile } = this.deps

    const size = this.fittedSize()
    this.userSized = false
    const window = new BrowserWindow({
      title: SETTINGS_WINDOW_TITLE,
      width: size.width,
      height: size.height,
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
        // Same renderer contract as the panel. The
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
    // A resize in the first moments is the compositor placing the window (a
    // tiler hands it whatever slot is free), not the user; only later ones
    // are theirs. Ours are flagged by `applying`.
    const createdAt = Date.now()
    window.on('resize', () => {
      if (!this.applying && Date.now() - createdAt > 1500) this.userSized = true
    })

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

    logger.info('settings window opened', {
      title: SETTINGS_WINDOW_TITLE,
      width: size.width,
      height: size.height,
      zoom: this.zoom,
      toolkitScale: this.toolkitScale
    })
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
