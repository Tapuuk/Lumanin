import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SEARCH_THROTTLE_MS, createSearchDispatch } from '../src/shared/search-throttle'

/**
 * When a typed search text reaches the extension that asked for it.
 *
 * Extracted from the view so the rule can be asserted on fake timers rather than
 * by typing at a real window and hoping the machine was fast enough.
 */
describe('forwarding a search text to an extension', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('delivers a burst once, with the last text typed', () => {
    const deliver = vi.fn()
    const dispatch = createSearchDispatch(deliver)

    for (const text of ['r', 're', 'rep', 'repo', 'repor']) {
      dispatch.send('h1', text, true)
      vi.advanceTimersByTime(20)
    }
    expect(deliver).not.toHaveBeenCalled()

    vi.advanceTimersByTime(SEARCH_THROTTLE_MS)
    expect(deliver.mock.calls).toEqual([['h1', 'repor']])
  })

  it('delivers every text as it is typed when the list does not ask to throttle', () => {
    const deliver = vi.fn()
    const dispatch = createSearchDispatch(deliver)

    dispatch.send('h1', 'a', false)
    dispatch.send('h1', 'ab', false)

    expect(deliver.mock.calls).toEqual([
      ['h1', 'a'],
      ['h1', 'ab']
    ])
  })

  /** Clearing the box stops the search, and stopping is never worth waiting for. */
  it('delivers an emptied box at once and drops what was pending', () => {
    const deliver = vi.fn()
    const dispatch = createSearchDispatch(deliver)

    dispatch.send('h1', 'repo', true)
    dispatch.send('h1', '', true)
    expect(deliver.mock.calls).toEqual([['h1', '']])

    vi.advanceTimersByTime(SEARCH_THROTTLE_MS * 4)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('drops a pending text when it is cancelled', () => {
    const deliver = vi.fn()
    const dispatch = createSearchDispatch(deliver)

    dispatch.send('h1', 'repo', true)
    dispatch.cancel()
    vi.advanceTimersByTime(SEARCH_THROTTLE_MS * 4)

    expect(deliver).not.toHaveBeenCalled()
  })

  it('leaves nothing armed once a text has been delivered', () => {
    const deliver = vi.fn()
    const dispatch = createSearchDispatch(deliver)

    dispatch.send('h1', 'repo', true)
    vi.advanceTimersByTime(SEARCH_THROTTLE_MS)
    dispatch.cancel()
    vi.advanceTimersByTime(SEARCH_THROTTLE_MS * 4)

    expect(deliver).toHaveBeenCalledTimes(1)
  })

  /**
   * The number the panel actually waits on. Above a fast typist's gap between
   * keys, below a pause for thought.
   */
  it('waits 150 ms', () => {
    expect(SEARCH_THROTTLE_MS).toBe(150)
  })
})
