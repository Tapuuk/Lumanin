/**
 * The query as a pattern, the tool's argv, and the tool's answer as a result —
 * the pure half of the search, kept free of UI imports so it can be tested as
 * plain functions.
 */

/** How many rows are worth showing. Past this nobody scrolls; they retype. */
export const LIMIT = 200

export type ToolName = 'fd' | 'locate' | 'find'

/** Every character that means something to fd's regex (ERE-shaped), quoted. */
export function escapeExtended(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The BRE escape, for `locate --regexp`. Only `.[*^$\` are special there —
 * escaping `+` or `?` would *create* GNU operators (`\+`, `\?`), so a query for
 * "c++" must leave them alone.
 */
export function escapeBasic(text: string): string {
  return text.replace(/[.[*^$\\]/g, '\\$&')
}

/**
 * Words are joined with `.*` so "src index" finds `src/index.ts` — typing two
 * halves of a name in order is how people actually search — and each word is
 * quoted first, so a query containing `(` or `+` is a search for those
 * characters rather than a regex error.
 */
export function fdPattern(query: string): string {
  return query.trim().split(/\s+/).filter(Boolean).map(escapeExtended).join('.*')
}

/**
 * The same query for `locate`, anchored under the root so `--limit` counts
 * rows we will actually show; without the anchor, /usr matches consume the cap
 * and in-home files go missing. `[^/]*` between words keeps the whole match
 * inside the last path component, which is what `--basename` used to do.
 *
 * `hidden` is in the pattern for the same reason the root is. `locate` has no
 * hidden flag, so filtering dot paths out of its answer lets `.cache` and
 * `.local` consume the whole `--limit` before one visible file is reached: for
 * common words that is measurably an empty list, not a shorter one. With
 * `hidden` off every component under the root must therefore start with a
 * non-dot, which filters at the source and keeps the cap meaningful.
 */
export function locatePattern(query: string, root: string, hidden: boolean): string {
  const words = query.trim().split(/\s+/).filter(Boolean).map(escapeBasic).join('[^/]*')
  const under = hidden ? '.*' : '\\([^./][^/]*/\\)*\\([^./][^/]*\\)\\{0,1\\}'
  return `^${escapeBasic(root)}/${under}${words}[^/]*$`
}

/** The argv for one search. Never a shell string. */
export function argsFor(
  tool: ToolName,
  query: string,
  root: string,
  options: { readonly hidden: boolean; readonly noIgnore: boolean }
): readonly string[] {
  switch (tool) {
    case 'fd':
      return [
        '--absolute-path',
        '--color', 'never',
        '--ignore-case',
        '--print0',
        '--max-results', String(LIMIT),
        ...(options.hidden ? ['--hidden'] : []),
        ...(options.noIgnore ? ['--no-ignore'] : []),
        // Ours, not the user's project layout: `.git` is never the answer to a
        // file search, and its object files are half the entries under any repo.
        // Unconditional, because with `--hidden --no-ignore` fd would otherwise
        // walk every object file in every repository.
        '--exclude', '.git',
        '--', fdPattern(query), root
      ]
    case 'locate':
      // Both the scope and the hidden rule are in the pattern (see
      // `locatePattern`), which is what keeps `--limit` counting rows we will
      // actually show.
      return [
        '--null',
        '--ignore-case',
        '--limit', String(LIMIT * 4),
        '--regexp', locatePattern(query, root, options.hidden)
      ]
    case 'find': {
      // No regex, but `-iname` globs: words joined with `*` still match a name
      // in order, so "quarterly report" finds `quarterly-report.md` here too.
      // Depth-bounded because an unbounded `find ~` on a cold cache is minutes.
      const glob = `*${query.trim().split(/\s+/).map((word) => word.replace(/[*?[\]]/g, '')).join('*')}*`
      return [
        root,
        '-maxdepth', '6',
        // `-prune`s a dotdir rather than merely excluding its contents from the
        // results: `-not -path '*/.*'` still *descends* into every dotdir, and
        // `.cache` alone is enough to burn the whole timeout.
        ...(options.hidden
          ? ['-iname', glob, '-print0']
          : ['-name', '.*', '-prune', '-o', '-iname', glob, '-print0'])
      ]
    }
  }
}

/**
 * One record per path, in scope, visible, capped.
 *
 * NUL is the only byte a Linux filename cannot contain, so it is the only
 * delimiter that always means "next record": splitting on newlines invents two
 * paths out of a name containing one, and trimming loses a name with a leading
 * or trailing space.
 *
 * `locate` cannot be scoped, so the scope is applied here. It is also what
 * drops entries for files that have been deleted since the last updatedb.
 *
 * The hidden check runs whichever tool answered, so the preference means one
 * thing everywhere: the pattern and the flags are the optimisation that keeps
 * each tool's cap meaningful, and this is the guarantee.
 */
export function splitOutput(stdout: string, root: string, hidden: boolean): string[] {
  const prefix = `${root}/`
  return stdout
    .split('\0')
    .filter((record) => record.length > 0)
    .filter((record) => record === root || record.startsWith(prefix))
    .filter(
      (record) =>
        hidden ||
        !record
          .slice(prefix.length)
          .split('/')
          .some((segment) => segment.startsWith('.'))
    )
    .slice(0, LIMIT)
}

export interface SearchOutcome {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly error?: Error
}

function firstLine(stderr: string): string {
  return stderr.trim().split('\n')[0] ?? ''
}

/**
 * A tool with no matches exits non-zero, and that is not an error — it is the
 * answer. The two conventions differ, which is why the tool has to say who it
 * is:
 *
 * `fd` and `find` exit 0 when they simply found nothing, so their exit 1 is
 * always "some directory was unreadable, here is everything else I found" and
 * that shape is a partial result, not a failure.
 *
 * `plocate` exits 1 for both "no matches" and "could not open the database",
 * and writes to stderr only in the second. That pairing is the one signal there
 * is, and it is what makes the "run updatedb" hint reachable.
 *
 * Otherwise only a failed spawn or an exit past 1 reaches the error card.
 */
export function parseSearchOutput(
  { stdout, stderr, exitCode, error }: SearchOutcome,
  tool: ToolName | null
): string {
  if (error !== undefined) {
    // A timeout arrives as { error, exitCode: null } with whatever the tool had
    // printed by then — a failed spawn has that shape too, but never any
    // stdout. What was found before the clock ran out is worth showing.
    if (exitCode === null && stdout.length > 0) return stdout
    throw error
  }
  if (tool === 'locate' && exitCode === 1 && stdout.length === 0 && stderr.trim().length > 0) {
    throw new Error(firstLine(stderr))
  }
  if (exitCode !== 0 && exitCode !== 1) {
    const line = firstLine(stderr)
    throw new Error(line.length > 0 ? line : `search tool exited with code ${String(exitCode)}`)
  }
  return stdout
}
