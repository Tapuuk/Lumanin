import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '../src/node/logger'
import { Degradations, degradedProfile, runStep, runStepAsync } from '../src/main/startup'
import { createRuntime } from '../src/platform/runtime'
import { PROBED_BINARIES } from '../src/platform/probe/binaries'

/**
 * Startup that survives a throw. Each step here is one that used to sit in an
 * un-caught promise chain, where a single failure left a launcher that opened
 * and answered nothing.
 */

function fakeLogger(): { logger: Logger; error: ReturnType<typeof vi.fn> } {
  const error = vi.fn()
  const logger = { info: () => undefined, warn: () => undefined, debug: () => undefined, error } as unknown as Logger
  return { logger, error }
}

describe('runStep', () => {
  it('returns the value and records nothing when the step succeeds', () => {
    const { logger, error } = fakeLogger()
    const degradations = new Degradations(logger)
    expect(runStep('x failed', 'y is off', () => 42, () => 0, degradations)).toBe(42)
    expect(degradations.list()).toEqual([])
    expect(error).not.toHaveBeenCalled()
  })

  it('returns the fallback, logs once and names the step when it throws', () => {
    const { logger, error } = fakeLogger()
    const degradations = new Degradations(logger)
    const value = runStep(
      'the extension database could not be opened',
      'plugins are off this session',
      () => {
        throw new Error('SQLITE_CANTOPEN')
      },
      () => 'fallback',
      degradations
    )
    expect(value).toBe('fallback')
    expect(error).toHaveBeenCalledTimes(1)
    expect(degradations.list()).toHaveLength(1)
    expect(degradations.list()[0]).toContain('the extension database could not be opened')
    expect(degradations.list()[0]).toContain('SQLITE_CANTOPEN')
    expect(degradations.list()[0]).toContain('plugins are off this session')
  })

  it('does the same for a rejected promise', async () => {
    const { logger, error } = fakeLogger()
    const degradations = new Degradations(logger)
    const value = await runStepAsync(
      'the probes failed',
      'backends were guessed',
      () => Promise.reject(new Error('boom')),
      () => 'fallback',
      degradations
    )
    expect(value).toBe('fallback')
    expect(error).toHaveBeenCalledTimes(1)
    expect(degradations.list()[0]).toContain('the probes failed')
  })
})

describe('degradedProfile', () => {
  it('still knows the desktop and answers UNKNOWN for what it could not check', () => {
    const profile = degradedProfile({ XDG_CURRENT_DESKTOP: 'Hyprland', XDG_SESSION_TYPE: 'wayland' })
    expect(profile.isHyprland).toBe(true)
    expect(profile.sessionType).toBe('wayland')
    for (const name of PROBED_BINARIES) expect(name in profile.binaries).toBe(true)
    expect(profile.dbus.via).toBe('none')
    expect(profile.protocols.probed).toBe(false)
  })

  it('is enough for createRuntime to select a clipboard and a paste backend', () => {
    const runtime = createRuntime({
      profile: degradedProfile({}),
      systemClipboard: { readText: () => '', writeText: () => undefined },
      home: '/tmp',
      dataHome: '/tmp'
    })
    expect(runtime.clipboard).not.toBeNull()
    expect(runtime.paste).not.toBeNull()
  })
})
