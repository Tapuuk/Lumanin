import { BrowserWindow, dialog, screen } from 'electron'
import { placementMode, type PlacementMode, type PlatformEnv } from '../platform/detect'
import type { ResolvedConfig } from '../shared/config'
import { WINDOW_CLASS } from '../shared/identity'
import { panelTop, PANEL_TOP_FRACTION } from '../shared/placement'
import type { Logger } from '../node/logger'

/**
 * The panel window.
 *
 * It is created once at daemon start and then only hidden and shown — never
 * closed, never re-created. ARCHITECTURE.md's latency budget (toggle → painted
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

export class PanelWindow {
  private window: BrowserWindow | null = null
  private closingForQuit = false
  /** How many things are currently keeping the panel up despite losing focus. */
  private holds = 0
  private readonly placement: PlacementMode

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

    const window = new BrowserWindow({
      width: config.general.width.value,
      // The window is the panel's *maximum* extent, not its content, and it
      // never changes size. See §"Panel sizing" — the panel draws itself as
      // tall as it needs at the top of this box and leaves the rest
      // transparent.
      height: config.general.height.value,
      show: false,
      frame: false,
      // Nobody should be able to drag a panel's edges, and nothing here ever
      // resizes it — so this is simply true, and it also pins the toplevel's
      // min/max size hints to the size above, which is what a compositor
      // actually reads. (`WM_NORMAL_HINTS` on X11.)
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      minimizable: false,
      skipTaskbar: true,
      // X11 only; harmless elsewhere. On Wayland the compositor decides.
      alwaysOnTop: true,
      autoHideMenuBar: true,
      // Load-bearing, not decoration. The window is the panel's full extent and
      // the panel usually fills only the top of it; everything below has to be
      // genuinely absent, not painted. It is also what THEMING.md's Glass themes
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
        // SECURITY.md §Renderer. None of these three is negotiable.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false
      }
    })

    this.window = window
    this.hardenNavigation(window)

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
    window.on('hide', () => this.deps.onVisibilityChange(false))

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
      width: config.general.width.value,
      height: config.general.height.value,
      placement: this.placement,
      windowClass: WINDOW_CLASS
    })

    return window
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
   * Placement per PLATFORM-MATRIX §2. On Wayland this is intentionally a no-op:
   * `setPosition`/`center` are unsupported there and calling them would be a lie
   * in the log rather than a bug the user can see. X11 centres on the display
   * under the cursor.
   *
   * The box is positioned as a whole and the search bar sits at the top of it,
   * so the bar lands at the same place on screen no matter how many results
   * there are — at {@link PANEL_TOP_FRACTION}, matching the Wayland rule.
   */
  private position(window: BrowserWindow): void {
    if (this.placement !== 'SELF') return

    const preference = this.deps.config().general.openOnMonitor.value
    try {
      const display =
        preference === 'primary'
          ? screen.getPrimaryDisplay()
          : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())

      const { width } = window.getBounds()
      const { x, y, width: dw, height: dh } = display.workArea
      window.setPosition(Math.round(x + (dw - width) / 2), panelTop(y, dh))
    } catch (error) {
      this.deps.logger.warn('self-centering failed; accepting default placement', { error })
    }
  }

  destroy(): void {
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
 * SECURITY.md: block `window.open` and all in-page navigation. Extension-supplied
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
