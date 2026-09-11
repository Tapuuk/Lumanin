import { describe, expect, it } from 'vitest'
import { filterRows, type SearchableRow } from '../src/shared/list-filter'

interface Row extends SearchableRow {
  readonly id: string
  readonly subtitle: string
}

function row(id: string, title: string, keywords = '', subtitle = '', sectionTitle: string | null = null): Row {
  return { id, title, keywords, subtitle, sectionTitle }
}

const sections = (rows: readonly Row[]): (string | null)[] => rows.map((entry) => entry.sectionTitle ?? null)

/** Every section appears as one contiguous run: no heading is drawn twice. */
function contiguous(values: readonly (string | null)[]): boolean {
  const seen = new Set<string | null>()
  let previous: string | null | undefined
  for (const value of values) {
    if (value !== previous && seen.has(value)) return false
    seen.add(value)
    previous = value
  }
  return true
}

const titles = (rows: readonly Row[]): string[] => rows.map((entry) => entry.title)

/**
 * Which rows of a plugin's list a query leaves on screen.
 *
 * Extracted from the view so the rule can be asserted directly, rather than by
 * typing at a real window and reading the DOM back.
 */
describe('filtering an extension list', () => {
  it('ranks a title match above a keyword match above a repaired typo', () => {
    const rows = [
      row('typo', 'Appel'),
      row('keyword', 'Banana', 'apple fruit'),
      row('title', 'Apple')
    ]

    expect(titles(filterRows(rows, 'apple', true))).toEqual(['Apple', 'Banana', 'Appel'])
  })

  it('keeps the extension order within one group', () => {
    const rows = [row('a', 'Apply'), row('b', 'App'), row('c', 'Apparatus')]

    expect(titles(filterRows(rows, 'app', true))).toEqual(['Apply', 'App', 'Apparatus'])
  })

  it('does not match text that is neither the title nor the keywords', () => {
    const rows = [row('only-subtitle', 'Banana', '', 'a crisp apple pastry')]

    expect(filterRows(rows, 'apple', true)).toEqual([])
  })

  it('drops a row nothing about it matches', () => {
    const rows = [row('apple', 'Apple'), row('zebra', 'Zebra', 'stripes')]

    expect(titles(filterRows(rows, 'apple', true))).toEqual(['Apple'])
  })

  /**
   * The identity the memoized rows above this depend on: a list that is not
   * being narrowed must come back as the very array that went in, or every row
   * below re-renders for a query the panel never applied.
   */
  it('returns the same array when the list does not filter itself', () => {
    const rows = [row('a', 'Apple'), row('b', 'Banana')]

    expect(filterRows(rows, 'app', false)).toBe(rows)
  })

  it('returns the same array for a query that is only whitespace', () => {
    const rows = [row('a', 'Apple'), row('b', 'Banana')]

    expect(filterRows(rows, '   ', true)).toBe(rows)
    expect(filterRows(rows, '', true)).toBe(rows)
  })

  it('returns the rows it was given, not copies of them', () => {
    const rows = [row('a', 'Apple'), row('b', 'Apricot'), row('c', 'Banana')]

    const visible = filterRows(rows, 'ap', true)

    expect(visible).toHaveLength(2)
    expect(visible[0]).toBe(rows[0])
    expect(visible[1]).toBe(rows[1])
  })
})

/**
 * Sections. The view draws a heading whenever a row's section differs from the
 * one before it, so interleaving two sections drew the same heading again and
 * again on the first keystroke.
 */
describe('sections', () => {
  const grouped = [
    row('t1', 'Appel', '', '', 'Today'),
    row('t2', 'Zebra', 'apple', '', 'Today'),
    row('y1', 'Banana', 'apple', '', 'Yesterday'),
    row('y2', 'Apple', '', '', 'Yesterday'),
    row('o1', 'Cider', 'apple', '', 'Older'),
    row('o2', 'Apple Pie', '', '', 'Older')
  ]

  it('keeps every section contiguous, so a heading is drawn once', () => {
    const visible = filterRows(grouped, 'apple', true)
    expect(visible).toHaveLength(6)
    expect(contiguous(sections(visible))).toBe(true)
  })

  it('puts the section holding the best match first by default', () => {
    const visible = filterRows(grouped, 'apple', true)
    // Yesterday holds the only exact title match, so it rises above Today.
    expect(sections(visible)[0]).toBe('Yesterday')
  })

  it('keeps the author’s section order when asked to', () => {
    const visible = filterRows(grouped, 'apple', true, true)
    expect(sections(visible)).toEqual(['Today', 'Today', 'Yesterday', 'Yesterday', 'Older', 'Older'])
  })

  it('still ranks by tier inside one section', () => {
    const visible = filterRows(grouped, 'apple', true, true)
    expect(titles(visible.filter((entry) => entry.sectionTitle === 'Yesterday'))).toEqual(['Apple', 'Banana'])
    expect(titles(visible.filter((entry) => entry.sectionTitle === 'Today'))).toEqual(['Zebra', 'Appel'])
  })

  it('is the old behaviour for a list with no sections', () => {
    const rows = [row('typo', 'Appel'), row('keyword', 'Banana', 'apple fruit'), row('title', 'Apple')]
    expect(titles(filterRows(rows, 'apple', true))).toEqual(['Apple', 'Banana', 'Appel'])
    expect(filterRows(rows, 'app', false)).toBe(rows)
  })
})
