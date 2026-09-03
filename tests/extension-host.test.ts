import { describe, expect, it } from 'vitest'
import {
  HEALTHY_UPTIME_MS,
  RESTART_DELAYS_MS,
  canFork,
  isNewIncident,
  restartDelay,
  waitSeconds
} from '../src/main/extensions/backoff'

describe('restartDelay', () => {
  it('walks the table for the first deaths', () => {
    expect(restartDelay(0)).toBe(200)
    expect(restartDelay(1)).toBe(1000)
    expect(restartDelay(2)).toBe(5000)
  })

  it('clamps past the end of the table instead of reading undefined', () => {
    // An unclamped read here is `undefined`, which becomes `NaN` the moment it
    // is added to a timestamp, and a comparison against `NaN` refuses every
    // later fork for good.
    expect(restartDelay(3)).toBe(5000)
    expect(restartDelay(99)).toBe(5000)
    expect(restartDelay(3)).toBe(RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1])
  })

  it('clamps a nonsensical count at the near end too', () => {
    expect(restartDelay(-1)).toBe(200)
  })
})

describe('canFork', () => {
  it('allows the first fork, which has no deadline behind it', () => {
    expect(canFork(Date.now(), 0)).toBe(true)
  })

  it('refuses one millisecond early and allows exactly on the boundary', () => {
    expect(canFork(999, 1000)).toBe(false)
    expect(canFork(1000, 1000)).toBe(true)
    expect(canFork(1001, 1000)).toBe(true)
  })
})

describe('isNewIncident', () => {
  it('treats a death after a long life as a fresh incident', () => {
    expect(isNewIncident(HEALTHY_UPTIME_MS)).toBe(true)
    expect(isNewIncident(HEALTHY_UPTIME_MS * 4)).toBe(true)
  })

  it('escalates a death that followed a moment of life', () => {
    expect(isNewIncident(0)).toBe(false)
    expect(isNewIncident(HEALTHY_UPTIME_MS - 1)).toBe(false)
  })
})

describe('waitSeconds', () => {
  it('rounds up so a wait still in the future never reads as zero', () => {
    expect(waitSeconds(0, 200)).toBe(1)
    expect(waitSeconds(0, 1000)).toBe(1)
    expect(waitSeconds(0, 1001)).toBe(2)
    expect(waitSeconds(0, 5000)).toBe(5)
  })
})
