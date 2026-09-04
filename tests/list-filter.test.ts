import { describe, expect, it } from 'vitest'
import { filterRows, type SearchableRow } from '../src/shared/list-filter'

interface Row extends SearchableRow {
  readonly id: string
  readonly subtitle: string
}

function row(id: string, title: string, keywords = '', subtitle = ''): Row {
  return { id, title, keywords, subtitle }
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
