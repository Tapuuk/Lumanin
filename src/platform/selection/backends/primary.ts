import type { Exec } from '../../exec'
import type { SelectionBackend } from '../index'

/**
 * Read the PRIMARY selection through a helper binary.
 *
 * Wayland and X11 differ only in which helper and which flags, so they share an
 * implementation: `wl-paste --primary` and `xclip -selection primary -out` answer
 * the same question about the same selection.
 *
 * An empty PRIMARY makes every one of these helpers exit non-zero ("Nothing is
 * copied", "target STRING not available"). That is not an error to propagate —
 * nothing is selected, and the honest answer is the empty string. A *missing*
 * helper is a different case, and the probe has already ruled it out before this
 * backend is ever constructed.
 */
export function createPrimarySelection(
  id: string,
  exec: Exec,
  command: string,
  args: readonly string[]
): SelectionBackend {
  return {
    id,
    async readText() {
      const result = await exec.run(command, args)
      if (!result.ok) return ''
      // xclip does not have wl-paste's --no-newline, so trim the one trailing
      // newline the X11 helpers add. Only one, and only at the end: a multi-line
      // selection's own blank lines are part of what the user selected.
      return result.stdout.replace(/\n$/, '')
    }
  }
}
