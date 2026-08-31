import type { Exec } from '../exec'
import { createElectronClipboard, type SyncTextClipboard } from './backends/electron-clipboard'
import { createWlClipboard } from './backends/wl-clipboard'

/**
 * Clipboard read/write, the capability behind the Raycast
 * `Clipboard.copy` / `Clipboard.read` API.
 *
 * The interface says nothing about Wayland, X11 or subprocesses — that is the
 * whole point of the capability split. Callers get text in and text out; which
 * of the two mechanisms is running is `doctor`'s business, not theirs.
 */

export interface ClipboardBackend {
  readonly id: string
  /** The empty string for an empty or non-text clipboard — never a rejection. */
  readText(): Promise<string>
  /**
   * `sensitive` asks the backend to mark the offer so clipboard managers skip
   * recording it. Only `wl-clipboard` can honour it; the Electron backend
   * copies plainly, which is the documented degradation, not an error.
   */
  writeText(text: string, options?: { sensitive?: boolean }): Promise<void>
}

export interface ClipboardDeps {
  readonly exec: Exec
  /** Electron's `clipboard`, injected so this module never imports Electron. */
  readonly systemClipboard: SyncTextClipboard
}

export const CLIPBOARD_BACKEND_IDS = ['wl-clipboard', 'electron-clipboard'] as const

export function createClipboard(id: string, deps: ClipboardDeps): ClipboardBackend {
  switch (id) {
    case 'wl-clipboard':
      return createWlClipboard(deps.exec)
    case 'electron-clipboard':
      return createElectronClipboard(deps.systemClipboard)
    default:
      // Unreachable: ids come from `BACKENDS.clipboard`, and a test asserts every
      // one of them is constructible. Loud rather than silent if that ever slips.
      throw new Error(`no clipboard implementation for backend '${id}'`)
  }
}

export type { SyncTextClipboard }
