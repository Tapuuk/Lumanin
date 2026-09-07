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
    "    return createElement('List', { isLoading: false })",
    '  }',
    '}',
    ''
  ].join('\n')
)

const port = new EventEmitter() as EventEmitter & { postMessage: (message: unknown) => void }
port.postMessage = (): void => {}

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
})
