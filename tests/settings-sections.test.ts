import { describe, expect, it } from 'vitest'
import {
  firstSectionMatching,
  matchesFilter,
  SECTIONS,
  sectionIndex
} from '../src/renderer/src/settings/sections'

describe('settings filter', () => {
  it('matches a case-insensitive substring of any text, and everything when empty', () => {
    expect(matchesFilter('', 'anything')).toBe(true)
    expect(matchesFilter('   ')).toBe(true)
    expect(matchesFilter('FOCUS', 'Hide when focus is lost')).toBe(true)
    expect(matchesFilter('lost', 'Hide', 'Off keeps the panel open when focus is lost.')).toBe(true)
    expect(matchesFilter('lost', 'Hide', undefined)).toBe(false)
    expect(matchesFilter('nothing here')).toBe(false)
  })

  it('jumps to the first section whose index matches', () => {
    expect(firstSectionMatching('escape', [])).toBe('panel')
    expect(firstSectionMatching('engines', [])).toBe('search')
    expect(firstSectionMatching('action panel', [])).toBe('keys')
    expect(firstSectionMatching('install', [])).toBe('plugins')
    expect(firstSectionMatching('qzxv no such setting', [])).toBeNull()
    expect(firstSectionMatching('', [])).toBeNull()
  })

  it('indexes every section', () => {
    const index = sectionIndex([{ value: 'tokyo-day', label: 'Tokyo Day' }])
    for (const section of SECTIONS) {
      expect(index[section.id].length, section.id).toBeGreaterThan(0)
    }
    expect(firstSectionMatching('tokyo', [{ value: 'tokyo-day', label: 'Tokyo Day' }])).toBe('panel')
  })
})
