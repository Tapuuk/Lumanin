import { describe, expect, it } from 'vitest'
import { parseIndex } from '../src/store/official'

/**
 * The index is remote content: whatever it says, the worst it may do is name a
 * folder inside the official repository. Everything else about an install —
 * consent, provenance, the URL parser — happens downstream on the same path a
 * pasted URL takes, so these tests are about not letting a bad index entry
 * build a URL pointing anywhere surprising.
 */

const entry = {
  name: 'steam',
  title: 'Steam',
  description: 'Your Steam library',
  author: 'Tapuuk',
  directory: 'steam'
}

describe('parseIndex', () => {
  it('builds the browse URL for a well-formed entry', () => {
    const plugins = parseIndex({ plugins: [entry] })
    expect(plugins).toHaveLength(1)
    expect(plugins[0]?.source).toBe(
      'https://github.com/Tapuuk/Lumanin-Plugins/tree/main/plugins/steam'
    )
  })

  it('drops entries that lost a field, and keeps the rest', () => {
    const plugins = parseIndex({
      plugins: [{ ...entry, title: undefined }, entry, 'nonsense', null]
    })
    expect(plugins).toHaveLength(1)
    expect(plugins[0]?.name).toBe('steam')
  })

  it('refuses a directory that is not a plain folder name', () => {
    for (const directory of ['../escape', 'a/b', '.hidden', 'x?y=1', 'a#b', '']) {
      expect(parseIndex({ plugins: [{ ...entry, directory }] })).toHaveLength(0)
    }
  })

  it('answers an empty list for anything that is not an index', () => {
    expect(parseIndex(null)).toEqual([])
    expect(parseIndex('[]')).toEqual([])
    expect(parseIndex({ plugins: 'many' })).toEqual([])
  })
})
