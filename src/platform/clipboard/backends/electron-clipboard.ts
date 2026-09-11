import type { ClipboardBackend } from '../index'

/**
 * Electron's own clipboard module (clipboard backend 2).
 *
 * Fine on X11, where the X server holds the selection independently of any
 * client, and the honest fallback anywhere `wl-clipboard` is missing. On Wayland
 * it inherits Chromium's clipboard, which means a copy performed as the window
 * hides can lose its selection owner — the reason `wl-clipboard` sits above it in
 * the chain rather than below.
 *
 * The Electron object is injected rather than imported. `src/platform/` is
 * reachable from the CLI, and the CLI must never load Electron: `lumanin doctor`
 * exists to work when the app does not, and pulling in a 200 MB runtime to print
 * a report would also put Electron's startup cost on every diagnostic.
 */
export interface SyncTextClipboard {
  readText(): string
  writeText(text: string): void
}

export function createElectronClipboard(clipboard: SyncTextClipboard): ClipboardBackend {
  return {
    id: 'electron-clipboard',
    // Synchronous under the hood; the promise belongs to the interface.
    readText: () => Promise.resolve(clipboard.readText()),
    writeText: (text) => {
      clipboard.writeText(text)
      return Promise.resolve()
    }
  }
}
