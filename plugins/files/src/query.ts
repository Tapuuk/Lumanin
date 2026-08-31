/**
 * The query as a pattern, and the tool's answer as a result — the pure half of
 * the search, kept free of UI imports so it can be tested as plain functions.
 */

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
 */
export function locatePattern(query: string, root: string): string {
  const words = query.trim().split(/\s+/).filter(Boolean).map(escapeBasic)
  return `^${escapeBasic(root)}/.*${words.join('[^/]*')}[^/]*$`
}

export interface SearchOutcome {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly error?: Error
}

/**
 * A tool with no matches exits non-zero, and that is not an error — it is the
 * answer. Nor is exit 1 with output: `find` (and fd) exit 1 whenever any
 * directory was unreadable, while still printing every match they found, so
 * that shape is a partial result, not a failure. Only a failed spawn or an
 * exit past 1 reaches the error card.
 */
export function parseSearchOutput({ stdout, stderr, exitCode, error }: SearchOutcome): string {
  if (error !== undefined) {
    // A timeout arrives as { error, exitCode: null } with whatever the tool had
    // printed by then — a failed spawn has that shape too, but never any
    // stdout. What was found before the clock ran out is worth showing.
    if (exitCode === null && stdout.length > 0) return stdout
    throw error
  }
  if (exitCode !== 0 && exitCode !== 1) {
    const line = stderr.trim().split('\n')[0] ?? ''
    throw new Error(line.length > 0 ? line : `search tool exited with code ${String(exitCode)}`)
  }
  return stdout
}
