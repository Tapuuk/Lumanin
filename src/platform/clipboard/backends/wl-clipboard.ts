import type { Exec } from '../../exec'
import type { ClipboardBackend } from '../index'

/**
 * `wl-copy` / `wl-paste` (clipboard backend 1).
 *
 * Two details in here are load-bearing and both cost a debugging session if you
 * get them wrong:
 *
 * 1. **The text goes on stdin.** `wl-copy -- <text>` would publish the copied
 *    value in `/proc/<pid>/cmdline`, readable by every process on the machine.
 *    A launcher copies passwords and tokens routinely, so argv is not an option.
 *
 * 2. **`wl-copy` daemonizes itself and that is required, not incidental.** A
 *    Wayland selection is owned by a live client and dies with it, so the process
 *    serving the clipboard has to outlive this call. `wl-copy` forks a persister
 *    and the foreground process exits immediately — which is exactly why the copy
 *    survives the daemon hiding the panel a moment later. Never "fix" this by
 *    holding the child, and never pass `--foreground`.
 */
export function createWlClipboard(exec: Exec): ClipboardBackend {
  return {
    id: 'wl-clipboard',

    async readText() {
      // `--no-newline` because wl-paste otherwise appends one that was never
      // copied, and a trailing newline in a pasted password is a support ticket.
      const result = await exec.run('wl-paste', ['--no-newline', '--type', 'text'])
      // An empty clipboard makes wl-paste exit non-zero with "Nothing is copied".
      // That is a state, not a failure.
      return result.ok ? result.stdout : ''
    },

    async writeText(text) {
      const result = await exec.run('wl-copy', ['--type', 'text/plain;charset=utf-8'], {
        stdin: text
      })
      if (!result.ok) {
        throw new Error(`wl-copy failed: ${result.stderr.trim() || result.error || 'unknown error'}`)
      }
    }
  }
}
