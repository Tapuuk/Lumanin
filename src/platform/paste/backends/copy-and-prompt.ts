import type { PasteBackend, PasteDeps } from '../index'

/**
 * The backend that cannot fail (paste backend 4).
 *
 * No helper is installed, so nothing can synthesise the keystroke — but the user
 * still gets their text, on the clipboard, with a toast saying to press Ctrl+V.
 * That is the difference between a feature that degrades and one that breaks,
 * and it is why this sits at the end of the chain instead of an error.
 *
 * On the dev machine this is the *live* backend, not a theoretical last resort:
 * none of ydotool, wtype or xdotool ships by default on Arch or anywhere else.
 * `doctor` says so prominently for the same reason.
 */
export function createCopyAndPrompt({ clipboard }: PasteDeps): PasteBackend {
  return {
    id: 'copy-and-prompt',
    injects: false,

    async paste(text) {
      await clipboard.writeText(text)
      return {
        injected: false,
        detail: 'Copied - press Ctrl+V to paste'
      }
    }
  }
}
