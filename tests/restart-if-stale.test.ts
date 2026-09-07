import { describe, expect, it } from 'vitest'
import { restartIfStale, type RestartDeps } from '../src/cli/client'
import type { Response, Verb } from '../src/shared/protocol'

/**
 * The decision a hotkey press makes when the daemon that answered is older
 * than the CLI: quit it, bring it back through its unit where one is active,
 * otherwise start it the ordinary way. Everything that would touch a real
 * daemon is a fake here.
 */
function fakes(options: { unit: boolean; unitRestartWorks?: boolean; comesBack?: boolean }) {
  const calls: string[] = []
  let alive = true
  const deps: RestartDeps = {
    ownVersion: () => '2.0.0',
    request: async (_socket: string, verb: Verb): Promise<Response | null> => {
      calls.push(verb.kind)
      if (verb.kind === 'quit') {
        alive = false
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
    startDaemon: async () => {
      calls.push('start-daemon')
      alive = options.comesBack ?? true
      return alive
    },
    retryMs: 1,
    timeoutMs: 50
  }
  return { deps, calls }
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
})
