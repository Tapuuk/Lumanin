import { BrowserWindow, dialog, screen } from 'electron'
import { placementMode, type PlacementMode, type PlatformEnv } from '../platform/detect'
import type { ResolvedConfig } from '../shared/config'
import { WINDOW_CLASS } from '../shared/identity'
import { panelTop, panelTopFraction } from '../shared/placement'
import type { Logger } from '../node/logger'
import { applyTextScale } from './text-scale'

/**
 * The panel window.
 *
 * It is created once at daemon start and then only hidden and shown — never
 * closed, never re-created. The latency budget (toggle → painted
 * ≤ 80 ms p95) is only achievable because nothing here is on the toggle path.
 */

export interface WindowDeps {
  /** Read per use, so a reloaded config takes effect without a new window. */
  readonly config: () => ResolvedConfig
  readonly profile: PlatformEnv
  readonly logger: Logger
  readonly preloadPath: string
  /** Dev server URL, or `null` to load the built renderer from disk. */
  readonly rendererUrl: string | null
  readonly rendererFile: string
  readonly onVisibilityChange: (visible: boolean) => void
}

/**
 * How much of a display's work area the panel may take. The rest is what keeps
 * it recognisably a panel over the desktop rather than a window that fills it,
 * and is the reason a `width = 1100` config on a 960-logical-pixel screen (a
 * 1080p laptop at scale 2) still fits.
 */
const MAX_WIDTH_FRACTION = 0.94
const MAX_HEIGHT_FRACTION = 0.9

export class PanelWindow {
  private window: BrowserWindow | null = null
  private closingForQuit = false
  /** How many things are currently keeping the panel up despite losing focus. */
  private holds = 0
  private readonly placement: PlacementMode
  /** The zoom applied for the desktop's text size - see `text-scale.ts`. */
  private textScale = 1
  /**
   * The text scale Chromium's toolkit already folded into its device scale
   * (`platform/appearance/toolkit-scale.ts`). It is also, measured, the ratio
   * between a window's size in Electron's DIPs and its size in the compositor's
   * logical pixels - which is what makes `fittedSize()` need it.
   */
  private toolkitScale = 1
  private stopWatchingDisplays: (() => void) | null = null
  /**
   * The size the current window was created at. Compared against instead of
   * `getSize()`, which reads back the compositor's configure divided by the
   * toolkit scale and lands a pixel off - enough to re-create the window on
   * every hide if it were the reference.
   */
  private createdSize: { width: number; height: number } | null = null

  constructor(private readonly deps: WindowDeps) {
    this.placement = placementMode(deps.profile)
  }

  get placementMode(): PlacementMode {
    return this.placement
  }

  get isVisible(): boolean {
    return this.window !== null && !this.window.isDestroyed() && this.window.isVisible()
  }

  create(): BrowserWindow {
    const { logger, preloadPath, rendererUrl, rendererFile } = this.deps
    const config = this.deps.config()

    const size = this.fittedSize()
    this.createdSize = size
    const window = new BrowserWindow({
      width: size.width,
      // The window is the panel's *maximum* extent, not its content. The
      // panel draws itself as tall as it needs at the top of this
      // box and leaves the rest transparent. Its size changes only when the
      // reasons for it change: `config.toml`, the desktop's text size, or the
      // display it has to fit on (`fit()`), and never while it is visible.
      height: size.height,
      show: false,
      frame: false,
      // `true`, and not for the user's benefit - a frameless panel has no edge
      // to drag. `false` makes Chromium pin the toplevel's min/max hints to the
      // size above, and on Wayland it computes those hints in DIPs while it
      // sizes the surface's *content* in DIPs times the toolkit's text scale
      // (Omarchy at 14px text: 1.19). The compositor honours the hint, the
      // content is 19% wider than the surface, and the right border and a
      // sixth of every row are simply not on screen. Measured on
      // Hyprland, Electron 43: `resizable: false` → 1100 logical for 1100 DIP,
      // clipped; `resizable: true` → 1306 logical, whole. Since the window is
      // only ever resized by being re-created (`fit()`), nothing is lost.
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      minimizable: false,
      skipTaskbar: true,
      // X11 only; harmless elsewhere. On Wayland the compositor decides.
      alwaysOnTop: true,
      autoHideMenuBar: true,
      // Load-bearing, not decoration. The window is the panel's full extent and
      // the panel usually fills only the top of it; everything below has to be
      // genuinely absent, not painted. It is also what Glass themes
      // need, so one switch serves both.
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath,
        // The renderer spends nearly all of its life hidden, and Chromium
        // throttles hidden renderers hard — timers clamped, rAF stopped. For a
        // window that is shown by a hotkey and expected to be painted by the
        // time the key is released, that throttling is paid back on the very
        // first interaction, which is the "the first few opens take a second"
        // shape. Our hidden window is not a background tab; it is a window
        // waiting to be needed.
        backgroundThrottling: false,
        // None of these three is negotiable: contextIsolation on, nodeIntegration off, sandbox on.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false
      }
    })

    this.window = window
    this.hardenNavigation(window)
    applyTextScale(window.webContents, this.textScale)

    // A monitor's scale changing under us is exactly the case the clamp exists
    // for: 1080p at 1.25 has room for a 1100-wide panel, the same panel at 2
    // does not. Electron reports every such change here on every platform it
    // knows the display on.
    const refit = (): void => this.fit()
    screen.on('display-metrics-changed', refit)
    screen.on('display-added', refit)
    screen.on('display-removed', refit)
    this.stopWatchingDisplays = () => {
      screen.removeListener('display-metrics-changed', refit)
      screen.removeListener('display-added', refit)
      screen.removeListener('display-removed', refit)
    }

    // A daemon's renderer fails silently by construction — nobody is ever
    // watching a hidden window's console. These four listeners are the whole
    // difference between "the panel is the wrong size" and knowing why.
    window.webContents.on('did-fail-load', (_e, code, description, url) => {
      logger.error('renderer failed to load', { code, description, url })
    })
    window.webContents.on('preload-error', (_e, preload, error) => {
      logger.error('preload threw', { preload, error: error.message })
    })
    window.webContents.on('did-finish-load', () => {
      logger.debug('renderer loaded')
    })

    window.webContents.on('console-message', (event) => {
      const level = event.level === 'error' || event.level === 'warning' ? 'warn' : 'debug'
      logger[level]('renderer console', {
        message: event.message,
        source: `${event.sourceId}:${String(event.lineNumber)}`
      })
    })

    window.on('blur', () => {
      // A hold means something we opened has the focus — a native file dialog,
      // say. Hiding then would take the panel away underneath the thing the user
      // is using and lose the form they were half-way through filling in.
      if (this.holds === 0 && this.deps.config().general.hideOnBlur.value) this.hide()
    })
    window.on('show', () => this.deps.onVisibilityChange(true))
    window.on('hide', () => {
      this.deps.onVisibilityChange(false)
      // A resize deferred because the panel was up is applied the moment it is
      // not - a window that changes size in front of the user is a jump.
      this.fit()
    })

    // The daemon owns the window's lifetime; a close request means "hide".
    window.on('close', (event) => {
      if (this.closingForQuit) return
      event.preventDefault()
      this.hide()
    })

    if (rendererUrl !== null) {
      void window.loadURL(rendererUrl)
    } else {
      void window.loadFile(rendererFile)
    }

    logger.info('panel window created', {
      width: size.width,
      height: size.height,
      configured: { width: config.general.width.value, height: config.general.height.value },
      textScale: this.textScale,
      placement: this.placement,
      windowClass: WINDOW_CLASS
    })

    return window
  }

  /**
   * Adopt the desktop's text size: zoom the renderer and let the box grow with
   * it, the way the shell's bar grows with its font, so a bigger text setting
   * shows the same number of rows rather than fewer.
   *
   * @param zoom what to zoom the page by
   * @param toolkitScale what Chromium's toolkit already scaled by, for the fit
   */
  setTextScale(zoom: number, toolkitScale = 1): void {
    const sameZoom = zoom === this.textScale
    this.textScale = zoom
    this.toolkitScale = toolkitScale > 0 && Number.isFinite(toolkitScale) ? toolkitScale : 1
    const window = this.window
    if (window === null || window.isDestroyed()) return
    if (!sameZoom) applyTextScale(window.webContents, zoom)
    this.fit()
  }

  /** `config.toml` changed - `[general].width` / `.height` may have. */
  reconfigure(): void {
    this.fit()
  }

  /**
   * The size the panel should be right now, in DIPs: the configured box, scaled
   * with the text, clamped to the display it has to fit on.
   *
   * Which display: the primary when the user asked for it; otherwise the
   * smallest work area of any connected display, so the panel fits wherever
   * the compositor decides to put it. On Wayland this process cannot ask which
   * output it is on, and a box that fits the smallest one fits them all.
   *
   * Units: Electron reports work areas in the compositor's logical pixels but
   * takes window sizes in DIPs, and on Linux the two differ by the toolkit's
   * text scale (measured: a 749-logical tiled window reads as 631 DIPs at 1.19).
   * The work area is divided by that scale so both sides of the comparison are
   * DIPs.
   */
  private fittedSize(): { width: number; height: number } {
    const config = this.deps.config().general
    const wanted = {
      width: Math.round(config.width.value * this.textScale),
      height: Math.round(config.height.value * this.textScale)
    }
    let area: { width: number; height: number } | null = null
    try {
      const displays = screen.getAllDisplays()
      const chosen =
        config.openOnMonitor.value === 'primary'
          ? [screen.getPrimaryDisplay()]
          : displays.length > 0
            ? displays
            : [screen.getPrimaryDisplay()]
      for (const display of chosen) {
        const work = display.workArea
        if (work.width <= 0 || work.height <= 0) continue
        area =
          area === null
            ? { width: work.width, height: work.height }
            : { width: Math.min(area.width, work.width), height: Math.min(area.height, work.height) }
      }
    } catch {
      area = null
    }
    if (area === null) return wanted
    const dip = { width: area.width / this.toolkitScale, height: area.height / this.toolkitScale }
    return {
      width: Math.max(240, Math.min(wanted.width, Math.floor(dip.width * MAX_WIDTH_FRACTION))),
      height: Math.max(160, Math.min(wanted.height, Math.floor(dip.height * MAX_HEIGHT_FRACTION)))
    }
  }

  /**
   * Bring the window to `fittedSize()` if it is not there already - only while
   * hidden; a visible panel keeps its size and gets it on the next hide.
   *
   * By re-creating it. A Wayland toplevel does not own its geometry,
   * and the one way to make a
   * resize land without size hints - which are what break under the toolkit's
   * text scale, see `resizable` above - is to map a new surface at the new
   * size. Measured: `setSize`/`setBounds` on a hidden resizable window change
   * nothing, not even Electron's own bookkeeping. The window is created once
   * per size, then; the toggle path is still never on it.
   */
  private fit(): void {
    const window = this.window
    if (window === null || window.isDestroyed() || window.isVisible()) return
    const size = this.fittedSize()
    const created = this.createdSize
    if (created !== null && created.width === size.width && created.height === size.height) return
    this.deps.logger.info('panel re-created for its new size', {
      width: size.width,
      height: size.height,
      textScale: this.textScale,
      toolkitScale: this.toolkitScale
    })
    this.stopWatchingDisplays?.()
    this.stopWatchingDisplays = null
    this.closingForQuit = true
    window.destroy()
    this.closingForQuit = false
    this.window = null
    this.create()
  }

  private hardenNavigation(window: BrowserWindow): void {
    hardenNavigation(window, this.deps.logger, this.deps.rendererUrl)
  }

  /**
   * Keep the panel up while something else has the focus.
   *
   * For anything we open that is a window in its own right — today the file
   * dialog behind `Form.FilePicker`. Counted rather than a flag, so two holds
   * cannot cancel each other, and the release is idempotent because the caller
   * will usually be a `finally`.
   */
  private hold(): () => void {
    this.holds++
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds = Math.max(0, this.holds - 1)
    }
  }

  /**
   * The desktop's open dialog, behind `Form.FilePicker`.
   *
   * Here rather than in main's IPC switch so the hold and the dialog cannot be
   * separated: the panel must stay up for the dialog's whole life, or the blur
   * that opening it causes hides the window and the user comes back from
   * choosing a file to find the form — and everything else they had typed into
   * it — gone.
   */
  async openFiles(options: { directories: boolean; multiple: boolean }): Promise<readonly string[]> {
    const window = this.window
    if (window === null) return []

    const release = this.hold()
    try {
      const result = await dialog.showOpenDialog(window, {
        properties: [
          options.directories ? 'openDirectory' : 'openFile',
          ...(options.multiple ? (['multiSelections'] as const) : [])
        ]
      })
      return result.canceled ? [] : result.filePaths
    } catch (error) {
      this.deps.logger.warn('the file dialog failed', { error })
      return []
    } finally {
      release()
    }
  }

  /**
   * Show the panel.
   *
   * Nothing is waited on. The window has been at its final size since it was
   * created, so there is no first-measurement race to lose — which is what used
   * to make it appear at half height every few opens.
   */
  show(): void {
    const window = this.window
    if (window === null || window.isDestroyed()) return

    this.position(window)
    window.show()
    window.focus()
  }

  hide(): void {
    const window = this.window
    if (window === null || window.isDestroyed() || !window.isVisible()) return
    window.hide()
  }

  toggle(): void {
    if (this.isVisible) this.hide()
    else this.show()
  }

  /**
   * Placement. On Wayland this is intentionally a no-op:
   * `setPosition`/`center` are unsupported there and calling them would be a lie
   * in the log rather than a bug the user can see. X11 centres on the display
   * under the cursor.
   *
   * The box is positioned as a whole and the search bar sits at the top of it,
   * so the bar lands at the same place on screen no matter how many results
   * there are — at `[general].top`, matching the Wayland rule.
   */
  private position(window: BrowserWindow): void {
    if (this.placement !== 'SELF') return

    const general = this.deps.config().general
    const preference = general.openOnMonitor.value
    try {
      const display =
        preference === 'primary'
          ? screen.getPrimaryDisplay()
          : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())

      const { width } = window.getBounds()
      const { x, y, width: dw, height: dh } = display.workArea
      window.setPosition(Math.round(x + (dw - width) / 2), panelTop(y, dh, panelTopFraction(general.top.value)))
    } catch (error) {
      this.deps.logger.warn('self-centering failed; accepting default placement', { error })
    }
  }

  destroy(): void {
    this.stopWatchingDisplays?.()
    this.stopWatchingDisplays = null
    const window = this.window
    if (window === null || window.isDestroyed()) return
    this.closingForQuit = true
    window.destroy()
    this.window = null
  }

  /** Only for wiring IPC senders; callers must not reach past this. */
  get webContents(): Electron.WebContents | null {
    const window = this.window
    return window === null || window.isDestroyed() ? null : window.webContents
  }
}

/**
 * Block `window.open` and all in-page navigation. Extension-supplied
 * markdown renders in the panel, and a renderer that can be navigated is a
 * renderer that can be replaced. Shared with the settings window — same
 * renderer privileges, same rule.
 */
export function hardenNavigation(
  window: BrowserWindow,
  logger: Logger,
  rendererUrl: string | null
): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    logger.warn('blocked window.open from renderer', { url })
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    // The dev server needs to navigate on HMR full-reload; the built app never does.
    if (rendererUrl !== null && url.startsWith(rendererUrl)) return
    event.preventDefault()
    logger.warn('blocked renderer navigation', { url })
  })

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

// There is deliberately no path helper here. This module is shared by both
// applications, so rollup emits it under `chunks/` — and a `__dirname`-relative
// path computed in a chunk points at `out/main/chunks/…`, which is how the
// panel once loaded `ERR_FILE_NOT_FOUND` instead of its renderer. Entry files
// (`daemon.ts`, `settings-app.ts`) are pinned to the out/main root by the
// build config and resolve their own renderer and preload paths.
