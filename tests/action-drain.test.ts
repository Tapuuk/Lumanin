import { describe, expect, it } from 'vitest'
import { DESTROY_GRACE_MS, MAX_DRAINING, destroyDeadlineMs } from '../src/host/drain'
import { waitForRelease } from '../src/main/extensions/action-drain'
import { ACTION_DRAIN_CEILING_MS } from '../src/shared/ext-protocol'

/**
 * A started action finishes. Two pure policies, one per process: which bound
 * a worker's destroy waits on, and how long a headless dispatch keeps its
 * session. Neither needs a thread or a window to be asserted.
 */
describe('destroyDeadlineMs', () => {
  it('gives an idle worker the idle bound', () => {
    expect(destroyDeadlineMs({ busy: false, draining: 0 })).toBe(DESTROY_GRACE_MS)
    expect(destroyDeadlineMs({ busy: false, draining: 0 })).toBe(1500)
  })

  it('gives a busy worker the action ceiling', () => {
    expect(destroyDeadlineMs({ busy: true, draining: 0 })).toBe(ACTION_DRAIN_CEILING_MS)
    expect(destroyDeadlineMs({ busy: true, draining: 0 })).toBe(90_000)
  })

  it('falls back to the idle bound once too many are draining', () => {
    expect(destroyDeadlineMs({ busy: true, draining: MAX_DRAINING })).toBe(DESTROY_GRACE_MS)
  })
})

/** An injected clock: `sleep` advances it, so a test never waits for real. */
function clock() {
  let now = 0
  return {
    now: () => now,
    sleep: (ms: number): Promise<void> => {
      now += ms
      return Promise.resolve()
    }
  }
}

describe('waitForRelease', () => {
  it('returns as soon as the session is gone and nothing is running', async () => {
    const c = clock()
    let gone = false
    const outcome = await waitForRelease(
      { gone: () => gone, busy: () => false, ...c },
      { floorMs: 5000, ceilingMs: 90_000 }
    )
    void gone
    expect(outcome).toBe('floor')

    gone = true
    expect(
      await waitForRelease({ gone: () => gone, busy: () => false, ...c }, { floorMs: 5000, ceilingMs: 90_000 })
    ).toBe('released')
  })

  it('waits past the floor while the handler is still busy', async () => {
    const c = clock()
    let busy = true
    const outcome = await waitForRelease(
      {
        gone: () => false,
        busy: () => {
          if (c.now() >= 20_000) busy = false
          return busy
        },
        ...c
      },
      { floorMs: 5000, ceilingMs: 90_000 }
    )
    expect(outcome).toBe('floor')
    expect(c.now()).toBeGreaterThanOrEqual(20_000)
  })

  it('gives up at the ceiling and says so', async () => {
    const c = clock()
    const outcome = await waitForRelease(
      { gone: () => false, busy: () => true, ...c },
      { floorMs: 5000, ceilingMs: 90_000 }
    )
    expect(outcome).toBe('ceiling')
    expect(c.now()).toBeGreaterThanOrEqual(90_000)
  })
})
