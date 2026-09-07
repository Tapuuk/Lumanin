import { describe, expect, it } from 'vitest'
import {
  deserializeShortcut,
  formatShortcut,
  formatShortcutCompact,
  matchesShortcut,
  parseShortcut,
  serializeShortcut
} from '../src/shared/shortcut'

/**
 * `Keyboard.Shortcut`, mapped onto a Linux keyboard.
 *
 * The mapping is a product decision as much as a technical one, and it is
 * invisible in the UI until it is wrong: a shortcut that
 * silently maps to a modifier the window manager owns simply never fires, and
 * the extension looks broken.
 */

describe('parseShortcut', () => {
  /**
   * `cmd` is macOS's *primary* modifier — the one on Copy, Save, New — and its
   * Linux equivalent by role is Ctrl. Mapping it to Super instead would be
   * literal and useless: Super is the compositor's, so half of every extension's
   * shortcuts would be swallowed before reaching the panel.
   */
  it('maps cmd to ctrl and opt to alt', () => {
    expect(parseShortcut({ modifiers: ['cmd'], key: 'c' })).toEqual({ modifiers: ['ctrl'], key: 'c' })
    expect(parseShortcut({ modifiers: ['opt'], key: 'x' })).toEqual({ modifiers: ['alt'], key: 'x' })
    expect(parseShortcut({ modifiers: ['windows'], key: 'k' })).toEqual({
      modifiers: ['super'],
      key: 'k'
    })
  })

  it('orders modifiers canonically, so two spellings of one chord match', () => {
    const a = parseShortcut({ modifiers: ['shift', 'cmd'], key: 'p' })
    const b = parseShortcut({ modifiers: ['cmd', 'shift'], key: 'p' })
    expect(a).toEqual(b)
    expect(serializeShortcut(a!)).toBe('ctrl+shift+p')
  })

  /**
   * An author who wrote a `Windows` variant has already done the cmd→ctrl
   * thinking for a PC keyboard, so taking it gives us their intent rather than
   * our mechanical translation of the Mac one.
   */
  it('prefers the Windows variant over the macOS one', () => {
    const shortcut = parseShortcut({
      macOS: { modifiers: ['cmd', 'shift'], key: '.' },
      Windows: { modifiers: ['ctrl', 'alt'], key: 'c' }
    })
    expect(shortcut).toEqual({ modifiers: ['ctrl', 'alt'], key: 'c' })
  })

  it('falls back to macOS when there is no Windows variant', () => {
    const shortcut = parseShortcut({ macOS: { modifiers: ['cmd'], key: 'y' } })
    expect(shortcut).toEqual({ modifiers: ['ctrl'], key: 'y' })
  })

  it('translates the named keys that are not `event.key` values', () => {
    expect(parseShortcut({ modifiers: [], key: 'arrowUp' })?.key).toBe('arrowup')
    expect(parseShortcut({ modifiers: [], key: 'return' })?.key).toBe('enter')
    // macOS's `delete` is the Backspace key; its `deleteForward` is Delete.
    expect(parseShortcut({ modifiers: [], key: 'delete' })?.key).toBe('backspace')
    expect(parseShortcut({ modifiers: [], key: 'deleteForward' })?.key).toBe('delete')
    expect(parseShortcut({ modifiers: [], key: 'space' })?.key).toBe(' ')
  })

  it('returns null for anything that is not a shortcut', () => {
    expect(parseShortcut(undefined)).toBeNull()
    expect(parseShortcut('ctrl+c')).toBeNull()
    expect(parseShortcut({ modifiers: ['cmd'] })).toBeNull()
  })

  it('round-trips through the wire form', () => {
    const shortcut = parseShortcut({ modifiers: ['cmd', 'shift'], key: 'c' })!
    expect(deserializeShortcut(serializeShortcut(shortcut))).toEqual(shortcut)
  })

  it('survives a `+` that is itself the key', () => {
    const shortcut = parseShortcut({ modifiers: ['cmd'], key: '+' })!
    expect(deserializeShortcut(serializeShortcut(shortcut))).toEqual(shortcut)
  })
})

describe('formatShortcut', () => {
  it('spells a chord the way a Linux user reads one', () => {
    expect(formatShortcut({ modifiers: ['ctrl', 'shift'], key: 'c' })).toBe('Ctrl+Shift+C')
    expect(formatShortcut({ modifiers: ['ctrl'], key: 'arrowup' })).toBe('Ctrl+↑')
    expect(formatShortcut({ modifiers: [], key: 'escape' })).toBe('Esc')
  })
})

describe('formatShortcutCompact', () => {
  it('turns shift into the symbol, tight against the key', () => {
    expect(formatShortcutCompact({ modifiers: ['shift'], key: 'u' })).toBe('⇧U')
    expect(formatShortcutCompact({ modifiers: ['ctrl', 'shift'], key: 'k' })).toBe('Ctrl+⇧K')
  })

  it('keeps Ctrl and Alt as names, not Mac symbols', () => {
    expect(formatShortcutCompact({ modifiers: ['ctrl'], key: 'u' })).toBe('Ctrl+U')
    expect(formatShortcutCompact({ modifiers: ['alt'], key: 'enter' })).toBe('Alt+↵')
  })

  it('uses the key labels for named keys, and the bare key without modifiers', () => {
    expect(formatShortcutCompact({ modifiers: [], key: 'enter' })).toBe('↵')
    expect(formatShortcutCompact({ modifiers: ['shift'], key: 'arrowup' })).toBe('⇧↑')
  })
})

describe('matchesShortcut', () => {
  const event = (over: Partial<Parameters<typeof matchesShortcut>[0]>): Parameters<typeof matchesShortcut>[0] => ({
    key: 'c',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...over
  })

  it('matches an exact chord', () => {
    expect(matchesShortcut(event({ key: 'c', ctrlKey: true }), { modifiers: ['ctrl'], key: 'c' })).toBe(true)
  })

  /**
   * Exact modifier matching, not "at least these". The permissive version makes
   * every unmodified action shadow the modified one that was meant to be
   * distinct — `Copy` would fire on `Ctrl+Shift+C` as well as `Ctrl+C`.
   */
  it('does not fire when an extra modifier is held', () => {
    expect(
      matchesShortcut(event({ key: 'c', ctrlKey: true, shiftKey: true }), {
        modifiers: ['ctrl'],
        key: 'c'
      })
    ).toBe(false)
  })

  /**
   * The physical key decides when Shift is involved. `{modifiers:["shift"],
   * key:"1"}` has to fire on Shift+1 whatever that produces — `!` on a US
   * layout, `+` on a German one — and matching the produced character would make
   * an extension's shortcuts depend on a keyboard its author cannot test.
   */
  it('matches a shifted key by its physical code', () => {
    expect(
      matchesShortcut(event({ key: '!', code: 'Digit1', shiftKey: true }), {
        modifiers: ['shift'],
        key: '1'
      })
    ).toBe(true)
  })

  it('is case-insensitive about the produced letter', () => {
    expect(
      matchesShortcut(event({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }), {
        modifiers: ['ctrl', 'shift'],
        key: 'c'
      })
    ).toBe(true)
  })

  it('matches punctuation by code, which is where layouts differ most', () => {
    expect(
      matchesShortcut(event({ key: ':', code: 'Semicolon', ctrlKey: true, shiftKey: true }), {
        modifiers: ['ctrl', 'shift'],
        key: ';'
      })
    ).toBe(true)
  })
})
