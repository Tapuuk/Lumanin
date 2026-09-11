import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ReactNode } from 'react'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Cache, flushCaches } from '../src/api-shim/system'
import { WORKER_METHODS } from '../src/shared/ext-protocol'

/**
 * Closing a command is the last chance a deferred cache write gets: nothing runs
 * in the isolate after the destroy reply, so a write still waiting on its delay
 * is a write that never happens. Two things are pinned here: that the teardown
 * writes at all, and that it writes *after* the tree is unmounted, since a
 * component's cleanup is allowed to cache something on its way out.
 *
 * The worker entry expects a thread it does not have, so the two pieces it reads
 * at load are faked: an emitter for the port, and a file that hands back the
 * plugin module. That module is this test's own object, holding the real cache
 * flush. Everything under test is the genuine article, only its surroundings
 * are not.
 */

const root = mkdtempSync(join(tmpdir(), 'lumanin-worker-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const cacheDirectory = join(root, 'cache')
const cacheFile = join(cacheDirectory, 'teardown.json')
const cache = new Cache({ directory: cacheDirectory, namespace: 'teardown' })

const globals = globalThis as Record<string, unknown>

/** What the unmounting component reaches for. A plain write, at the default delay. */
globals['__lumaninTeardownWrite'] = (): void => {
  cache.set('written while unmounting', 'yes')
}

const shimModule = {
  __lumaninInstallRuntime: (): void => {},
  __lumaninInternals: {
    CommandRoot: ({ children }: { children?: ReactNode }): ReactNode => children ?? null,
    popNavigation: (): void => {},
    legacyRoot: (): ReactNode => null,
    flushCaches
  }
}
globals['__lumaninTeardownShim'] = shimModule

const modulePath = join(root, 'lumanin.cjs')
writeFileSync(modulePath, 'module.exports = globalThis.__lumaninTeardownShim\n')

const entryPath = join(root, 'command.cjs')
writeFileSync(
  entryPath,
  [
    "const { createElement, useEffect } = require('react')",
    'module.exports = {',
    '  default: function Command() {',
    '    useEffect(() => () => globalThis.__lumaninTeardownWrite(), [])',
    "    return createElement('List', {",
    '      isLoading: false,',
    '      onSlow: () => globalThis.__lumaninTeardownSlow(),',
    '      onNever: () => globalThis.__lumaninTeardownNever()',
    '    })',
    '  }',
    '}',
    ''
  ].join('\n')
)

const port = new EventEmitter() as EventEmitter & { postMessage: (message: unknown) => void }
/** Everything the worker sends back, so a test can find a handler id or a log line. */
const sent: unknown[] = []
port.postMessage = (message: unknown): void => {
  sent.push(message)
}

vi.mock('node:worker_threads', () => ({
  parentPort: (globalThis as Record<string, unknown>)['__lumaninTeardownPort'],
  workerData: (globalThis as Record<string, unknown>)['__lumaninTeardownBoot']
}))

globals['__lumaninTeardownPort'] = port
globals['__lumaninTeardownBoot'] = { modulePath }

const session = {
  sessionId: 'teardown-test',
  extensionName: 'fixture',
  extensionTitle: 'Fixture',
  extensionDir: root,
  commandName: 'run',
  commandTitle: 'Run',
  commandMode: 'view',
  entryPath,
  launchContext: {},
  preferences: {},
  launchArguments: {},
  environment: {
    assetsPath: join(root, 'assets'),
    supportPath: root,
    appearance: 'dark',
    textSize: 'medium',
    isDevelopment: false,
    launchType: 'userInitiated',
    apiVersion: '1.104.24'
  }
}

const send = (id: number, method: string, params?: unknown): void => {
  port.emit('message', { jsonrpc: '2.0', id, method, params })
}

/** The two action handlers: one that finishes after a beat, one that never does. */
let slowDone = false
globals['__lumaninTeardownSlow'] = (): Promise<void> =>
  new Promise((resolve) =>
    setTimeout(() => {
      slowDone = true
      resolve()
    }, 300)
  )
globals['__lumaninTeardownNever'] = (): Promise<void> => new Promise(() => {})

/** The handler id the last render assigned to the function prop of that name. */
function handlerIdOf(prop: string): string {
  const text = JSON.stringify(sent)
  const match = new RegExp(`"${prop}":\\{"__handler":"([^"]+)"`).exec(text)
  if (match === null) throw new Error(`no handler for ${prop} in ${text.slice(0, 400)}`)
  return match[1] as string
}

const replyTo = (id: number): unknown => sent.find((m) => (m as { id?: number }).id === id)

describe('the worker on its way out', () => {
  it('writes a cache entry an unmounting component made', async () => {
    await import('../src/host/worker')

    send(1, WORKER_METHODS.CREATE, session)
    expect(existsSync(cacheFile)).toBe(false)

    send(2, WORKER_METHODS.DESTROY)

    expect(existsSync(cacheFile)).toBe(true)
    const written = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
      entries: Record<string, string>
    }
    expect(written.entries['written while unmounting']).toBe('yes')
  })

  /**
   * A started action finishes: DESTROY is answered only once the handler's
   * promise has settled, so a hide or a headless dispatch does not cut off
   * work the user asked for.
   */
  it('answers DESTROY after an in-flight action has finished, not before', async () => {
    sent.length = 0
    send(3, WORKER_METHODS.CREATE, { ...session, sessionId: 'drain-test' })
    await new Promise((r) => setTimeout(r, 50))
    const handlerId = handlerIdOf('onSlow')

    send(4, WORKER_METHODS.EVENT, { sessionId: 'drain-test', handlerId, payload: null })
    send(5, WORKER_METHODS.DESTROY, { sessionId: 'drain-test' })
    expect(replyTo(5)).toBeUndefined()
    expect(slowDone).toBe(false)

    await new Promise((r) => setTimeout(r, 500))
    expect(slowDone).toBe(true)
    expect(replyTo(5)).toBeDefined()
  })

  it('still answers at the ceiling for a handler that never settles, and says so', async () => {
    vi.useFakeTimers()
    try {
      sent.length = 0
      send(6, WORKER_METHODS.CREATE, { ...session, sessionId: 'never-test' })
      await vi.advanceTimersByTimeAsync(50)
      const handlerId = handlerIdOf('onNever')

      send(7, WORKER_METHODS.EVENT, { sessionId: 'never-test', handlerId, payload: null })
      send(8, WORKER_METHODS.DESTROY, { sessionId: 'never-test' })
      await vi.advanceTimersByTimeAsync(89_000)
      expect(replyTo(8)).toBeUndefined()

      await vi.advanceTimersByTimeAsync(2_000)
      expect(replyTo(8)).toBeDefined()
      const warned = sent.some((m) => {
        const message = m as { method?: string; params?: { level?: string; message?: string } }
        return message.params?.level === 'warn' && /1 of 1 actions still running/.test(message.params.message ?? '')
      })
      expect(warned).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
