import { describe, expect, it } from 'vitest'
import { escapeAction } from '../src/shared/escape'
import { clampSelection, moveSelection } from '../src/shared/selection'

/**
 * The pure half of the panel's interaction model. These are extracted from the
 * view precisely so the rules can be asserted without a DOM — each case here is
 * a bug that shipped.
 */

describe('escapeAction', () => {
  it('applies esc_at_root only at the root', () => {
    // The setting's whole name is "at root". Applied everywhere, the default
    // threw away a half-typed query on the first Esc.
    expect(escapeAction('hide', true)).toBe('hide')
    expect(escapeAction('hide', false)).toBe('clear')
  })

  it('backs out one step away from the root whatever the setting says', () => {
    for (const setting of ['hide', 'clear', 'none'] as const) {
      expect(escapeAction(setting, false), setting).toBe('clear')
    }
  })

  it('honours a root setting that keeps the panel open', () => {
    expect(escapeAction('none', true)).toBe('none')
    expect(escapeAction('clear', true)).toBe('clear')
  })
})

describe('moveSelection', () => {
  it('walks the list without leaving it', () => {
    expect(moveSelection(0, 1, 3)).toBe(1)
    expect(moveSelection(2, 1, 3)).toBe(2)
    expect(moveSelection(0, -1, 3)).toBe(0)
  })

  it('never returns -1 for an empty list', () => {
    // Clamping only against `count - 1` yielded -1 and it stuck, so the next
    // results arrived with no row selected and Enter would have done nothing.
    expect(moveSelection(0, 1, 0)).toBe(0)
    expect(moveSelection(0, -1, 0)).toBe(0)
  })

  it('pulls a stale index back inside a list that shrank', () => {
    expect(clampSelection(9, 3)).toBe(2)
    expect(clampSelection(9, 0)).toBe(0)
    expect(clampSelection(-1, 5)).toBe(0)
  })
})
