import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEYS,
  formatKeyChord,
  isTypeable,
  keyActionFor,
  keyConflicts,
  matchesKeyAction,
  parseKeyChord,
  PANEL_KEYS,
  panelKeyLabel
} from '../src/shared/keys'
import { loadConfig } from '../src/shared/config'

/**
 * `[keys]` — the panel's own keys.
 *
 * The third kind of key in this application and the only one that is entirely
 * ours: a global hotkey lives in a compositor's config, a plugin shortcut is
 * declared by the plugin, and these are answered by the renderer while our own
 * window has focus. That is what makes them a plain setting with no consent
 * step and no file of somebody else's to write.
 */

const event = (
  key: string,
  modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}
): { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean } => ({
  key,
  ctrlKey: modifiers.ctrl === true,
  altKey: modifiers.alt === true,
  shiftKey: modifiers.shift === true,
  metaKey: modifiers.meta === true
})

describe('parsing a chord', () => {
  it('accepts the spellings people actually write', () => {
    expect(parseKeyChord('Ctrl+Enter')).toEqual({ modifiers: ['ctrl'], key: 'enter' })
    expect(parseKeyChord('ctrl enter')).toEqual({ modifiers: ['ctrl'], key: 'enter' })
    expect(parseKeyChord('Space')).toEqual({ modifiers: [], key: ' ' })
    expect(parseKeyChord('Down')).toEqual({ modifiers: [], key: 'arrowdown' })
    expect(parseKeyChord('Esc')).toEqual({ modifiers: [], key: 'escape' })
    // cmd → ctrl, the same mapping plugin shortcuts get.
    expect(parseKeyChord('Cmd+K')).toEqual({ modifiers: ['ctrl'], key: 'k' })
  })

  it('canonicalises the modifier order, so two spellings compare equal', () => {
    expect(parseKeyChord('Shift+Ctrl+P')).toEqual(parseKeyChord('Ctrl+Shift+P'))
    expect(formatKeyChord(parseKeyChord('shift ctrl p') as never)).toBe('Ctrl+Shift+P')
  })

  it('refuses anything it cannot bind exactly', () => {
    // A chord that half-parses is worse than one that is refused: it silently
    // binds something other than what was written.
    expect(parseKeyChord('Ctrl+Nope')).toBeNull()
    expect(parseKeyChord('Ctrl')).toBeNull()
    expect(parseKeyChord('')).toBeNull()
    expect(parseKeyChord('a b')).toBeNull()
  })

  it('offers only keys it can parse back', () => {
    for (const key of PANEL_KEYS) {
      expect(parseKeyChord(key), key).not.toBeNull()
      expect(panelKeyLabel(key).length).toBeGreaterThan(0)
    }
  })
})

describe('matching', () => {
  it('matches modifiers exactly', () => {
    expect(matchesKeyAction(DEFAULT_KEYS, 'actionPanel', event('k', { ctrl: true }))).toBe(true)
    expect(matchesKeyAction(DEFAULT_KEYS, 'actionPanel', event('k'))).toBe(false)
    expect(matchesKeyAction(DEFAULT_KEYS, 'actionPanel', event('k', { ctrl: true, shift: true }))).toBe(false)
  })

  it('answers one action per event, in a fixed order', () => {
    expect(keyActionFor(DEFAULT_KEYS, event('Enter'))).toBe('open')
    expect(keyActionFor(DEFAULT_KEYS, event('ArrowDown'))).toBe('next')
    expect(keyActionFor(DEFAULT_KEYS, event('Escape'))).toBe('back')
    expect(keyActionFor(DEFAULT_KEYS, event('q'))).toBeNull()
  })

  it('lets a bare key act only while the search box is empty', () => {
    // Space is what a file manager uses to open the thing under the cursor, and
    // it is also a character. Both have to stay true: it acts while nothing has
    // been typed, and goes back to being text the moment something has.
    expect(matchesKeyAction(DEFAULT_KEYS, 'secondary', event(' '), { searchEmpty: true })).toBe(true)
    expect(matchesKeyAction(DEFAULT_KEYS, 'secondary', event(' '), { searchEmpty: false })).toBe(false)

    // Its other binding has a modifier, so it is unambiguous and always fires —
    // which is what stops "open the second action" being unreachable mid-query.
    const typing = { searchEmpty: false }
    expect(matchesKeyAction(DEFAULT_KEYS, 'secondary', event('Enter', { ctrl: true }), typing)).toBe(true)
    // And a named key is not typing either, whatever is in the box.
    expect(matchesKeyAction(DEFAULT_KEYS, 'open', event('Enter'), typing)).toBe(true)
  })

  it('knows which chords are indistinguishable from typing', () => {
    expect(isTypeable({ modifiers: [], key: ' ' })).toBe(true)
    expect(isTypeable({ modifiers: [], key: 'a' })).toBe(true)
    expect(isTypeable({ modifiers: [], key: 'enter' })).toBe(false)
    expect(isTypeable({ modifiers: ['ctrl'], key: 'a' })).toBe(false)
  })

  it('reports a chord bound to two actions rather than refusing it', () => {
    // Refusing would make swapping two keys impossible: you cannot set the first
    // without colliding with the second.
    const clashing = { ...DEFAULT_KEYS, next: [{ modifiers: [] as never, key: 'enter' }] }
    expect(keyConflicts(clashing)).toEqual([{ chord: 'enter', actions: ['open', 'next'] }])
    expect(keyConflicts(DEFAULT_KEYS)).toEqual([])
  })
})

describe('[keys] in config.toml', () => {
  const load = (text: string) => loadConfig({ fileContents: text, env: {} })

  it('is the defaults when the section is absent', () => {
    const config = load('')
    expect(config.keys.value).toEqual(DEFAULT_KEYS)
    expect(config.keys.layer).toBe('default')
  })

  it('takes one chord or a list of them', () => {
    const config = load('[keys]\nopen = "Ctrl+O"\nsecondary = ["Space", "Ctrl+Enter"]\n')
    expect(config.keys.value.open).toEqual([{ modifiers: ['ctrl'], key: 'o' }])
    expect(config.keys.value.secondary).toEqual([
      { modifiers: [], key: ' ' },
      { modifiers: ['ctrl'], key: 'enter' }
    ])
    expect(config.keys.layer).toBe('file')
    // Untouched actions keep theirs.
    expect(config.keys.value.back).toEqual(DEFAULT_KEYS.back)
  })

  it('keeps the default when a chord does not parse, and says so', () => {
    // The failure this avoids is the worst one available: a typo in `back`
    // leaving the panel with no way out of it.
    const config = load('[keys]\nback = "Ctrl+Nope"\n')
    expect(config.keys.value.back).toEqual(DEFAULT_KEYS.back)
    expect(config.problems.join(' ')).toContain('not a key we understand')
  })

  it('honours an empty list as "unbind", but not an all-invalid one', () => {
    expect(load('[keys]\nsecondary = []\n').keys.value.secondary).toEqual([])
    expect(load('[keys]\nsecondary = ["nope"]\n').keys.value.secondary).toEqual(
      DEFAULT_KEYS.secondary
    )
  })

  it('reports a collision without refusing the file', () => {
    const config = load('[keys]\nnext = "Enter"\n')
    expect(config.keys.value.next).toEqual([{ modifiers: [], key: 'enter' }])
    expect(config.problems.join(' ')).toContain('bound to open and next')
  })
})
