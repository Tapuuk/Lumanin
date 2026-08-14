import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { resolveBinary } from '../probe/binaries'
import { parseDesktopEntry, type DesktopEntry, type SkipReason } from './desktop-entry'

/**
 * The application index (PLATFORM-MATRIX §8).
 *
 * Freedesktop only, and therefore universal: every desktop environment on Linux
 * agrees about `.desktop` files, which is why this is the one capability with a
 * single backend rather than a chain.
 *
 * The rule that shapes everything here is **desktop-file IDs**. An entry is
 * identified by its path relative to an `applications/` directory with `/`
 * turned into `-`, and the *first* directory in `$XDG_DATA_HOME` +
 * `$XDG_DATA_DIRS` order to provide a given ID wins. That is what makes a user's
 * override in `~/.local/share/applications` replace the system entry instead of
 * appearing next to it — without it, anyone who has ever customised a launcher
 * entry sees every app twice.
 */

export interface AppIndexStats {
  readonly directories: readonly string[]
  readonly found: number
  readonly shadowed: number
  readonly skipped: Readonly<Record<SkipReason, number>>
  readonly unreadable: number
  readonly elapsedMs: number
}

export interface AppIndexResult {
  readonly entries: readonly DesktopEntry[]
  readonly stats: AppIndexStats
}

/**
 * Where to look, in precedence order.
 *
 * Flatpak and Snap are listed explicitly because they are the two cases where
 * being spec-correct is not enough: both install exports outside the default
 * `$XDG_DATA_DIRS` on many distributions, and an index that misses them is a
 * launcher that cannot find half of what a modern desktop has installed.
 */
export function applicationDirectories(
  env: Readonly<Record<string, string | undefined>>,
  home: string
): readonly string[] {
  const dataHome = env['XDG_DATA_HOME']
  const userData = dataHome !== undefined && dataHome.startsWith('/') ? dataHome : join(home, '.local', 'share')

  const dataDirs = (env['XDG_DATA_DIRS'] ?? '/usr/local/share:/usr/share')
    .split(':')
    .filter((dir) => dir.startsWith('/'))

  const candidates = [
    userData,
    ...dataDirs,
    // Per-user and system Flatpak exports.
    join(home, '.local', 'share', 'flatpak', 'exports', 'share'),
    '/var/lib/flatpak/exports/share'
  ].map((dir) => join(dir, 'applications'))

  // Snap publishes straight into a fixed directory rather than an exports tree.
  candidates.push('/var/lib/snapd/desktop/applications')

  // Order is precedence, so duplicates must keep their *first* occurrence.
  return [...new Set(candidates)]
}

function walk(directory: string, prefix: string, out: { id: string; path: string }[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return // Missing or unreadable directories are the normal case, not an error.
  }

  for (const entry of entries) {
    const path = join(directory, entry.name)
    // Subdirectories become part of the ID with `-`, per the spec: a file at
    // `kde/foo.desktop` has the ID `kde-foo.desktop`, not `foo.desktop`.
    if (entry.isDirectory()) {
      walk(path, `${prefix}${entry.name}-`, out)
      continue
    }
    if (!entry.name.endsWith('.desktop')) continue
    out.push({ id: `${prefix}${entry.name}`, path })
  }
}

export interface IndexOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  /** `$XDG_CURRENT_DESKTOP` split and lowercased. */
  readonly desktops: readonly string[]
  /** Injectable so the index can be tested without a $PATH full of real binaries. */
  readonly resolveBinary?: (name: string) => string | null
  /**
   * Directories to scan, in precedence order. Defaults to
   * {@link applicationDirectories}.
   *
   * Overridable because the default deliberately includes absolute system paths
   * (`/var/lib/flatpak/…`, `/var/lib/snapd/…`) that no environment variable
   * controls — correct in production, and impossible to test against without an
   * injection point, since a test tree would silently index the real machine.
   */
  readonly directories?: readonly string[]
}

export function buildAppIndex(options: IndexOptions): AppIndexResult {
  const started = Date.now()
  const directories = options.directories ?? applicationDirectories(options.env, options.home)

  const skipped: Record<SkipReason, number> = {
    'not-an-application': 0,
    hidden: 0,
    'no-display': 0,
    'wrong-desktop': 0,
    'try-exec-missing': 0,
    'no-exec': 0,
    'no-name': 0
  }

  // POSIX: LC_MESSAGES overrides LANG for translated text specifically, which is
  // exactly what a desktop entry's Name is.
  const locale = options.env['LC_MESSAGES'] ?? options.env['LANG']
  const context = {
    desktops: options.desktops,
    resolveBinary: options.resolveBinary ?? ((name: string) => resolveBinary(name, options.env)),
    ...(locale === undefined ? {} : { locale })
  }

  const byId = new Map<string, DesktopEntry>()
  const seenIds = new Set<string>()
  let shadowed = 0
  let unreadable = 0

  for (const directory of directories) {
    const files: { id: string; path: string }[] = []
    walk(directory, '', files)

    for (const file of files) {
      // Precedence: an ID already claimed by an earlier directory wins, and the
      // later file is not even parsed. `Hidden=true` in a user override is how
      // the spec says to remove a system entry, and it only works if the user's
      // file is the one that decides.
      if (seenIds.has(file.id)) {
        shadowed += 1
        continue
      }
      seenIds.add(file.id)

      let contents: string
      try {
        contents = readFileSync(file.path, 'utf8')
      } catch {
        unreadable += 1
        continue
      }

      const result = parseDesktopEntry(contents, file.id, file.path, context)
      if (!result.ok) {
        skipped[result.reason] += 1
        continue
      }
      byId.set(file.id, result.entry)
    }
  }

  return {
    entries: [...byId.values()],
    stats: {
      directories: directories.filter(exists),
      found: byId.size,
      shadowed,
      skipped,
      unreadable,
      elapsedMs: Date.now() - started
    }
  }
}

function exists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
