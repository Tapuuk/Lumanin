import type { ClipboardBackend } from '../../clipboard/index'
import type { Exec } from '../../exec'
import type { PasteBackend, PasteOutcome } from '../index'

/**
 * The shape all three injection backends share: put the text on the clipboard,
 * synthesise Ctrl+V, and — if the helper is missing, its daemon is down, or it
 * refuses the arguments — return the copy-and-prompt outcome instead of throwing.
 *
 * That last part is PLATFORM-MATRIX §5's "never fail silently" read the other way
 * round: the user's text is already on their clipboard by the time injection is
 * attempted, so a failed keystroke costs them one Ctrl+V, not their snippet.
 */
export function clipboardThenKeystroke(options: {
  readonly id: string
  readonly exec: Exec
  readonly clipboard: ClipboardBackend
  readonly command: string
  readonly args: readonly string[]
  /** Named in the fallback message so the user knows what to fix. */
  readonly helperHint: string
}): PasteBackend {
  const { id, exec, clipboard, command, args, helperHint } = options

  return {
    id,
    injects: true,

    async paste(text): Promise<PasteOutcome> {
      await clipboard.writeText(text)

      const result = await exec.run(command, args)
      if (result.ok) return { injected: true, detail: `pasted via ${id}` }

      return {
        injected: false,
        detail: `Copied - press Ctrl+V to paste (${helperHint})`
      }
    }
  }
}
