import { matchFields, matchGroup } from './fuzzy'

/**
 * Which rows of a plugin's list the panel shows for a query.
 *
 * A plugin view is part of the launcher, so it searches the way the launcher
 * does rather than by scanning for a substring: the item's **title**, plus its
 * explicit `keywords`, with the same one forgiven typo as the root list — and
 * **never the subtitle**. A subtitle is a description; matching it made every
 * row whose description contained the query look like a result. Title matches
 * rank above keyword matches above repaired typos, author order within each
 * group. A plugin that wants different rules owns the query with
 * `onSearchTextChange`.
 *
 * Lives here rather than beside the view so the rule can be asserted without a
 * window, and so a filtered list is a pure function of the rows and the text.
 */

/** The only two fields a row is searched by. */
export interface SearchableRow {
  readonly title: string
  /** The item's `keywords`, joined into one string. */
  readonly keywords: string
}

/**
 * Returns the input array itself when nothing is being filtered out, so a row
 * object and the array holding it both survive a keystroke unchanged. Callers
 * memoize on that identity.
 */
export function filterRows<T extends SearchableRow>(
  rows: readonly T[],
  query: string,
  filtering: boolean
): readonly T[] {
  const needle = query.trim()
  if (!filtering || needle.length === 0) return rows

  const matched = rows.flatMap((row) => {
    const match = matchFields(needle, [
      { name: 'title', text: row.title, weight: 1, isName: true },
      { name: 'keywords', text: row.keywords, weight: 0.7, mode: 'word' as const }
    ])
    return match === null ? [] : [{ row, group: matchGroup(match.tier) }]
  })
  // `sort` is stable, so within a group the extension's own order survives.
  matched.sort((a, b) => a.group - b.group)
  return matched.map((entry) => entry.row)
}
