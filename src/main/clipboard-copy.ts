import type { ClipboardBackend } from '../platform/clipboard/index'

/**
 * The `Clipboard.copy` capability's write path, extracted from the daemon so
 * the concealed routing is testable without Electron.
 *
 * A concealed copy exists for passwords: external clipboard managers (cliphist,
 * Klipper, CopyQ) record every plain offer permanently, so a vault plugin's
 * 30-second clear wipes the live selection while the manager's database keeps
 * the secret. All three skip an offer carrying the `x-kde-passwordManagerHint`
 * target, which `wl-copy --sensitive` provides (probed on wl-clipboard
 * 2.3.0: one process offers the hint alongside `text/plain`).
 * Electron's clipboard cannot add MIME targets, so a concealed copy routes
 * through the platform backend; when that is unavailable or fails, the copy
 * still happens — plainly, which is what the plugin's own clear timer already
 * covers.
 *
 * HTML never takes the concealed path: `wl-copy` serves one payload, and no
 * vault copies markup.
 */

export interface CopyContent {
  readonly text?: string
  readonly html?: string
  readonly file?: string
  readonly concealed: boolean
}

export interface ElectronTextClipboard {
  writeText(text: string): void
  write(data: { text: string; html: string }): void
}

export function createCopy(deps: {
  readonly electron: ElectronTextClipboard
  readonly backend: () => Promise<ClipboardBackend | undefined>
}): (content: CopyContent) => Promise<void> {
  return async ({ text, html, file, concealed }) => {
    if (concealed && html === undefined) {
      const backend = await deps.backend()
      if (backend !== undefined) {
        try {
          await backend.writeText(file ?? text ?? '', { sensitive: true })
          return
        } catch {
          // The helper is missing or too old — fall through to a plain copy.
        }
      }
    }
    if (file !== undefined) deps.electron.writeText(file)
    else if (html !== undefined) deps.electron.write({ text: text ?? '', html })
    else deps.electron.writeText(text ?? '')
  }
}
