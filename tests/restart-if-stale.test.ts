import { describe, expect, it } from 'vitest'
import { restartIfStale, type RestartDeps } from '../src/cli/client'
import type { Response, Verb } from '../src/shared/protocol'

/**
 * The decision a hotkey press makes when the daemon that answered is older
 * than the CLI: quit it, bring it back through its unit where one is active,
 * otherwise start it the ordinary way. Everything that would touch a real
 * daemon is a fake here.
 */
function fakes(options: {
  unit: boolean
  unitRestartWorks?: boolean
  comesBack?: boolean
  locked?: boolean
  neverDies?: boolean
  timeoutMs?: number
}) {
  const calls: string[] = []
  const handed: (number | undefined)[] = []
  let releases = 0
  let alive = true
  const deps: RestartDeps = {
    ownVersion: () => '2.0.0',
    request: async (_socket: string, verb: Verb): Promise<Response | null> => {
      calls.push(verb.kind)
      if (verb.kind === 'quit') {
        if (!options.neverDies) alive = false
        return { id: 1, ok: true }
      }
      return alive ? { id: 1, ok: true, version: '1.0.0' } : null
    },
    unitActive: () => {
      calls.push('is-active')
      return options.unit
    },
    restartUnit: () => {
      calls.push('restart-unit')
      if (options.unitRestartWorks ?? true) alive = options.comesBack ?? true
      return options.unitRestartWorks ?? true
    },
    startDaemon: async (_socket: string, timeoutMs?: number) => {
      calls.push('start-daemon')
      handed.push(timeoutMs)
      alive = options.comesBack ?? true
      return alive
    },
    lock: () => {
      if (options.locked) return null
      return () => {
        releases += 1
      }
    },
    retryMs: 1,
    timeoutMs: options.timeoutMs ?? 50
  }
  return { deps, calls, handed, released: () => releases }
}

const stale: Response = { id: 1, ok: true, version: '1.0.0' }

describe('restartIfStale', () => {
  it('leaves a daemon of the same version alone', async () => {
    const { deps, calls } = fakes({ unit: true })
    expect(await restartIfStale('/s', { id: 1, ok: true, version: '2.0.0' }, deps)).toBe(false)
    expect(calls).toEqual([])
  })

  it('leaves a daemon that reports no version alone', async () => {
    const { deps, calls } = fakes({ unit: true })
    expect(await restartIfStale('/s', { id: 1, ok: true }, deps)).toBe(false)
    expect(calls).toEqual([])
  })

  it('quits a stale daemon and restarts it through its unit when one is active', async () => {
    const { deps, calls } = fakes({ unit: true })
    expect(await restartIfStale('/s', stale, deps)).toBe(true)
    expect(calls[0]).toBe('quit')
    expect(calls).toContain('is-active')
    expect(calls).toContain('restart-unit')
    expect(calls).not.toContain('start-daemon')
  })

  it('starts it the ordinary way when no unit is active', async () => {
    const { deps, calls } = fakes({ unit: false })
    expect(await restartIfStale('/s', stale, deps)).toBe(true)
    expect(calls[0]).toBe('quit')
    expect(calls).not.toContain('restart-unit')
    expect(calls).toContain('start-daemon')
  })

  it('falls back to a plain start when the unit restart fails', async () => {
    const { deps, calls } = fakes({ unit: true, unitRestartWorks: false })
    expect(await restartIfStale('/s', stale, deps)).toBe(true)
    expect(calls).toContain('restart-unit')
    expect(calls).toContain('start-daemon')
  })

  it('reports honestly when nothing comes back', async () => {
    const { deps } = fakes({ unit: false, comesBack: false })
    expect(await restartIfStale('/s', stale, deps)).toBe(false)
  })

  it('does not restart while another CLI holds the lock', async () => {
    // A held key: the second press must not quit the daemon the first just started.
    const { deps, calls } = fakes({ unit: true, locked: true })
    expect(await restartIfStale('/s', stale, deps)).toBe(false)
    expect(calls).toEqual([])
  })

  it('releases the lock even when nothing comes back', async () => {
    const { deps, released } = fakes({ unit: false, comesBack: false })
    await restartIfStale('/s', stale, deps)
    expect(released()).toBe(1)
  })

  it('bounds the plain start by its own budget, not the cold-start one', async () => {
    const { deps, handed } = fakes({ unit: false, timeoutMs: 20 })
    await restartIfStale('/s', stale, deps)
    expect(handed).toEqual([20])
  })

  it('does not hold the press for ever when the daemon never dies', async () => {
    const { deps } = fakes({ unit: false, neverDies: true, timeoutMs: 20 })
    const started = Date.now()
    await restartIfStale('/s', stale, deps)
    expect(Date.now() - started).toBeLessThan(500)
  })
})
