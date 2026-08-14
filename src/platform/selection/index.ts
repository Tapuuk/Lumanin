import type { BinaryMap } from '../probe/binaries'
import type { Exec } from '../exec'
import { createPrimarySelection } from './backends/primary'

/**
 * Reading the user's current text selection (PLATFORM-MATRIX §6) — the capability
 * behind `getSelectedText`.
 *
 * Both implemented backends read the **PRIMARY** selection, which on Linux is
 * "the text you last highlighted" and is set automatically by GTK, Qt and every
 * terminal without the user copying anything. That is close enough to what
 * `getSelectedText` means on macOS for the overwhelming majority of extensions —
 * and unlike synthesising Ctrl+C it touches nothing, which matters because Ctrl+C
 * means "interrupt" in exactly the terminal windows a launcher gets used over.
 *
 * When nothing can read it, this rejects. RAYCAST-COMPAT's macOS-only policy is
 * explicit that a rejected promise is the honest answer and a silent empty string
 * is not: an extension can handle the first and cannot detect the second.
 */

export interface SelectionBackend {
  readonly id: string
  /** Rejects with {@link PlatformNotSupportedError} where nothing can read PRIMARY. */
  readText(): Promise<string>
}

export class PlatformNotSupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlatformNotSupportedError'
  }
}

export interface SelectionDeps {
  readonly exec: Exec
  readonly binaries: BinaryMap
}

export const SELECTION_BACKEND_IDS = ['wl-primary', 'x11-primary'] as const

export function createSelection(id: string | null, deps: SelectionDeps): SelectionBackend {
  switch (id) {
    case 'wl-primary':
      return createPrimarySelection('wl-primary', deps.exec, 'wl-paste', [
        '--primary',
        '--no-newline',
        '--type',
        'text'
      ])

    case 'x11-primary':
      // Either helper does the job and distros disagree about which is installed,
      // so take whichever the probe found rather than declaring one canonical.
      return deps.binaries.xclip !== null
        ? createPrimarySelection('x11-primary', deps.exec, 'xclip', [
            '-selection',
            'primary',
            '-out'
          ])
        : createPrimarySelection('x11-primary', deps.exec, 'xsel', ['--primary', '--output'])

    case null:
      return unsupportedSelection()

    default:
      throw new Error(`no selection implementation for backend '${id}'`)
  }
}

/**
 * PLATFORM-MATRIX §6 backend 4: GNOME Wayland, or any session with no helper
 * installed. Nothing can read the selection there without a companion shell
 * extension, so say so rather than returning a plausible empty string.
 */
function unsupportedSelection(): SelectionBackend {
  return {
    id: 'unsupported',
    readText: () =>
      Promise.reject(
        new PlatformNotSupportedError(
          'reading the selection needs wl-clipboard on Wayland or xclip/xsel on X11; neither is available'
        )
      )
  }
}
