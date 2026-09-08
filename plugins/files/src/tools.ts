import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolName } from './query'

/**
 * Which program answers a search, and where it is. Split from the view so the
 * decision that makes Search Files work at all on a machine without `fd` can
 * be asserted with a fake lookup instead of a real PATH.
 */

export interface Tool {
  readonly name: ToolName
  /** Absolute path, so nothing depends on the worker's PATH at spawn time. */
  readonly path: string
}

/**
 * Find an executable on PATH without spawning anything.
 *
 * `which` would mean a child process per candidate on every view open, to answer
 * a question `readdir`-free `existsSync` answers in microseconds. It also keeps
 * this honest about the argv rule: there is no shell here at all,
 * not even to look something up.
 */
export function onPath(names: readonly string[]): string | null {
  const path = process.env['PATH'] ?? ''
  for (const name of names) {
    for (const directory of path.split(':')) {
      if (directory.length === 0) continue
      const candidate = join(directory, name)
      try {
        // `statSync`, not `lstatSync`: a PATH entry is allowed to be a symlink
        // (Nix, `~/.local/bin` shims), and what matters is what it points at.
        if (statSync(candidate).isFile()) return candidate
      } catch {
        continue
      }
    }
  }
  return null
}

/**
 * Which tool answers this search.
 *
 * Order is by how good the answer is, not by how common the tool is. `fd`
 * respects `.gitignore` unless Ignored Files is on, which is the difference
 * between finding your source file and finding forty copies of it under
 * `node_modules`. `plocate` is
 * instant but answers from a database that is as old as the last `updatedb`, so
 * a file saved a minute ago is not in it. `find` is always there and is always
 * the slowest; it exists so that this feature never simply does not work.
 */
export function pickTool(
  preferred: 'auto' | ToolName | undefined,
  lookup: (names: readonly string[]) => string | null = onPath
): Tool | null {
  const fd = (): Tool | null => {
    // Debian and Ubuntu ship the binary as `fdfind`, because `fd` was taken.
    const path = lookup(['fd', 'fdfind'])
    return path === null ? null : { name: 'fd', path }
  }
  const locate = (): Tool | null => {
    const path = lookup(['plocate', 'locate'])
    return path === null ? null : { name: 'locate', path }
  }
  const find = (): Tool | null => {
    const path = lookup(['find'])
    return path === null ? null : { name: 'find', path }
  }

  if (preferred === 'fd') return fd()
  if (preferred === 'locate') return locate()
  if (preferred === 'find') return find()
  return fd() ?? locate() ?? find()
}
