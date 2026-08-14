import type { ClipboardBackend } from '../clipboard/index'
import type { Exec } from '../exec'
import { createCopyAndPrompt } from './backends/copy-and-prompt'
import { createWtype } from './backends/wtype'
import { createXdotool } from './backends/xdotool'
import { createYdotool } from './backends/ydotool'

/**
 * Paste-into-the-previous-app (PLATFORM-MATRIX §5) — what `Clipboard.paste`
 * maps to.
 *
 * The sequence is the same on every backend: hide the panel, let focus return to
 * whatever the user was in, then inject. Only the injection step differs, which
 * is why `hideAndRestoreFocus` is the caller's job and this interface starts
 * after it.
 *
 * PLATFORM-MATRIX's hard rule for this capability: **never fail silently.** The
 * chain therefore ends in a backend that cannot fail — it puts the text on the
 * clipboard and tells the user to press Ctrl+V — and on the dev machine, with
 * none of ydotool/wtype/xdotool installed, that last one is the live path rather
 * than a rare edge case.
 */

export interface PasteOutcome {
  /** False when the text was placed on the clipboard for the user to paste. */
  readonly injected: boolean
  /** Shown to the user when `injected` is false; logged either way. */
  readonly detail: string
}

export interface PasteBackend {
  readonly id: string
  /** True if this backend synthesises input rather than asking the user to. */
  readonly injects: boolean
  paste(text: string): Promise<PasteOutcome>
}

export interface PasteDeps {
  readonly exec: Exec
  /**
   * Injection backends paste the *clipboard*, they do not type the text: a
   * synthesised Ctrl+V is one event whatever the payload, where typing a 200-line
   * snippet character by character races every autocomplete in the target app.
   * So all four backends put the text on the clipboard first.
   */
  readonly clipboard: ClipboardBackend
}

export const PASTE_BACKEND_IDS = ['ydotool', 'wtype', 'xdotool', 'copy-and-prompt'] as const

export function createPaste(id: string, deps: PasteDeps): PasteBackend {
  switch (id) {
    case 'ydotool':
      return createYdotool(deps)
    case 'wtype':
      return createWtype(deps)
    case 'xdotool':
      return createXdotool(deps)
    case 'copy-and-prompt':
      return createCopyAndPrompt(deps)
    default:
      throw new Error(`no paste implementation for backend '${id}'`)
  }
}
