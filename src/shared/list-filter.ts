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

/** The only two fields a row is searched by, and the section it belongs to. */
export interface SearchableRow {
  readonly title: string
  /** The item's `keywords`, joined into one string. */
  readonly keywords: string
  /** The `List.Section` title the row sits under; absent or null is no section. */
  readonly sectionTitle?: string | null
}

/**
 * Returns the input array itself when nothing is being filtered out, so a row
 * object and the array holding it both survive a keystroke unchanged. Callers
 * memoize on that identity.
 *
 * Sections stay whole: the view draws a heading whenever a row's section
 * differs from the one before it, so rows of one section must come back
 * contiguous or the same heading repeats down the list. Ranking orders the
 * rows *within* a section; `keepSectionOrder` decides the order *of* the
 * sections (the author's when true, else the section holding the best match
 * first, ties in author order).
 */
export function filterRows<T extends SearchableRow>(
  rows: readonly T[],
  query: string,
  filtering: boolean,
  keepSectionOrder = false
): readonly T[] {
  const needle = query.trim()
  if (!filtering || needle.length === 0) return rows

  const buckets = new Map<string | null, { row: T; group: number }[]>()
  for (const row of rows) {
    const match = matchFields(needle, [
      { name: 'title', text: row.title, weight: 1, isName: true },
      { name: 'keywords', text: row.keywords, weight: 0.7, mode: 'word' as const }
    ])
    if (match === null) continue
    const section = row.sectionTitle ?? null
    const bucket = buckets.get(section)
    const entry = { row, group: matchGroup(match.tier) }
    if (bucket === undefined) buckets.set(section, [entry])
    else bucket.push(entry)
  }

  // `sort` is stable, so within a group the extension's own order survives,
  // and buckets with the same best group keep their first-appearance order.
  const ordered = [...buckets.values()].map((bucket) => {
    bucket.sort((a, b) => a.group - b.group)
    return bucket
  })
  if (!keepSectionOrder) {
    ordered.sort((a, b) => (a[0]?.group ?? 0) - (b[0]?.group ?? 0))
  }
  return ordered.flatMap((bucket) => bucket.map((entry) => entry.row))
}
