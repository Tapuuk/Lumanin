import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement, type ReactNode } from 'react'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installRuntime, type ShimRuntime } from '../src/api-shim/runtime'
import {
  defaultParseOutput,
  killAfterGrace,
  runCommand,
  splitCommand,
  type ExecOutcome
} from '../src/api-shim/exec'
import { flushCaches } from '../src/api-shim/system'
import { useExec, usePromise } from '../src/api-shim/utils'
import { createRenderer } from '../src/host/reconciler'
import { serializeTree, type SerializeSink } from '../src/host/tree'
import type { RenderNode } from '../src/shared/render-tree'

/**
 * `useExec` and the machinery under it.
 *
 * This is the hook a Linux plugin reaches for most — a launcher plugin is
 * usually a face for a CLI — so the rules it applies to a command line are worth
 * pinning down exactly rather than discovering one plugin at a time.
 */

const never = new AbortController().signal

describe('splitting a command line', () => {
  it('splits on whitespace', () => {
    expect(splitCommand('git status --short')).toEqual({
      file: 'git',
      args: ['status', '--short']
    })
  })

  /** The spec's rule, and the only escape it defines. */
  it('treats a backslash-escaped space as part of an argument', () => {
    expect(splitCommand('cat /home/me/My\\ Notes.txt')).toEqual({
      file: 'cat',
      args: ['/home/me/My Notes.txt']
    })
  })

  /**
   * Deliberately not a shell parser. The spec says "except for spaces, no
   * escaping/quoting is needed", so a quote is an ordinary character — and a
   * plugin that writes `grep "foo"` gets the quotes in its argument here exactly
   * as it would from the real API, rather than silently different behaviour.
   */
  it('does not treat quotes as grouping', () => {
    expect(splitCommand('grep "foo bar" file')).toEqual({
      file: 'grep',
      args: ['"foo', 'bar"', 'file']
    })
  })

  it('keeps a backslash that is not escaping a space', () => {
    expect(splitCommand('grep \\d+ file')).toEqual({ file: 'grep', args: ['\\d+', 'file'] })
  })

  it('collapses runs of whitespace and survives an empty line', () => {
    expect(splitCommand('  ls   -la  ')).toEqual({ file: 'ls', args: ['-la'] })
    expect(splitCommand('')).toEqual({ file: '', args: [] })
  })
})

describe('running a command', () => {
  it('captures stdout and strips the final newline by default', async () => {
    const outcome = await runCommand('/bin/echo', ['hello'], {}, never)
    expect(outcome.stdout).toBe('hello')
    expect(outcome.exitCode).toBe(0)
  })

  it('keeps the final newline when asked', async () => {
    const outcome = await runCommand('/bin/echo', ['hello'], { stripFinalNewline: false }, never)
    expect(outcome.stdout).toBe('hello\n')
  })

  it('captures stderr and the exit code separately', async () => {
    const outcome = await runCommand(
      '/bin/sh',
      ['-c', 'echo problem >&2; exit 3'],
      {},
      never
    )
    expect(outcome.stderr).toBe('problem')
    expect(outcome.stdout).toBe('')
    expect(outcome.exitCode).toBe(3)
  })

  it('writes input to stdin', async () => {
    const outcome = await runCommand('/bin/cat', [], { input: 'from stdin' }, never)
    expect(outcome.stdout).toBe('from stdin')
  })

  /**
   * A command that reads stdin must not hang waiting for input nobody is going
   * to send. Left open, this times out after ten seconds and reads to the plugin
   * author as "the command is slow".
   */
  it('closes stdin when there is no input', async () => {
    const outcome = await runCommand('/bin/cat', [], {}, never)
    expect(outcome.stdout).toBe('')
    expect(outcome.timedOut).toBe(false)
  })

  it('leaves output as a Buffer when asked', async () => {
    const outcome = await runCommand('/bin/echo', ['hi'], { encoding: 'buffer' }, never)
    expect(Buffer.isBuffer(outcome.stdout)).toBe(true)
    expect((outcome.stdout as Buffer).toString('utf8')).toBe('hi\n')
  })

  it('runs in the requested directory', async () => {
    const outcome = await runCommand('/bin/pwd', [], { cwd: '/tmp' }, never)
    expect(outcome.stdout).toBe('/tmp')
  })

  it('passes the given environment', async () => {
    const outcome = await runCommand(
      '/bin/sh',
      ['-c', 'echo "$LUMANIN_TEST"'],
      { env: { ...process.env, LUMANIN_TEST: 'set' } },
      never
    )
    expect(outcome.stdout).toBe('set')
  })

  it('extends process.env rather than replacing it', async () => {
    const outcome = await runCommand(
      '/bin/sh',
      ['-c', 'echo "${PATH:-MISSING}:${LUMANIN_TEST:-MISSING}"'],
      { env: { LUMANIN_TEST: 'set' } },
      never
    )
    expect(outcome.stdout).not.toContain('MISSING')
    expect(String(outcome.stdout).endsWith(':set')).toBe(true)
  })

  it('lets a caller override an inherited variable', async () => {
    process.env.LUMANIN_TEST = 'inherited'
    try {
      const outcome = await runCommand(
        '/bin/sh',
        ['-c', 'echo "$LUMANIN_TEST"'],
        { env: { LUMANIN_TEST: 'override' } },
        never
      )
      expect(outcome.stdout).toBe('override')
    } finally {
      delete process.env.LUMANIN_TEST
    }
  })

  /** `shell` opts into shell syntax; without it `&&` would be an argument. */
  it('runs through a shell only when asked', async () => {
    const withShell = await runCommand('echo a && echo b', [], { shell: true }, never)
    expect(withShell.stdout).toBe('a\nb')

    const without = await runCommand('/bin/echo', ['a', '&&', 'echo', 'b'], {}, never)
    expect(without.stdout).toBe('a && echo b')
  })

  it('reports a timeout rather than hanging', async () => {
    const outcome = await runCommand('/bin/sleep', ['5'], { timeout: 80 }, never)
    expect(outcome.timedOut).toBe(true)
    expect(outcome.signal).toBe('SIGTERM')
  })

  it('reports a command that does not exist as an error, not a crash', async () => {
    const outcome = await runCommand('/definitely/not/here', [], {}, never)
    expect(outcome.error).toBeInstanceOf(Error)
    expect(outcome.exitCode).toBeNull()
  })

  /**
   * A shell that traps SIGTERM is the case the escalation exists for: without
   * it the loop below outlives the launcher. The body sleeps in short bursts on
   * purpose — a single long sleep would survive the shell as an orphan.
   */
  it('escalates to SIGKILL when a child ignores SIGTERM', async () => {
    const child = spawn('/bin/sh', [
      '-c',
      'trap "" TERM; echo trapped; while :; do sleep 0.2; done'
    ])
    const ended = new Promise<NodeJS.Signals | null>((resolve) => {
      child.on('close', (_code: number | null, signal: NodeJS.Signals | null) => resolve(signal))
    })
    // Signalling before the shell has read its own trap would kill it by the
    // default disposition and prove nothing.
    await new Promise((resolve) => child.stdout?.once('data', resolve))

    child.kill('SIGTERM')
    killAfterGrace(child, 200)
    await expect(ended).resolves.toBe('SIGKILL')
  })

  it('does not leave a timed-out command running when it ignores SIGTERM', async () => {
    const started = Date.now()
    const outcome = await runCommand(
      'trap "" TERM; while :; do sleep 0.2; done',
      [],
      { shell: true, timeout: 200 },
      never
    )
    expect(Date.now() - started).toBeLessThan(2500)
    expect(outcome.timedOut).toBe(true)
    expect(outcome.signal).toBe('SIGKILL')
  })

  it('stops a command when its signal is aborted', async () => {
    const controller = new AbortController()
    const running = runCommand('/bin/sleep', ['5'], {}, controller.signal)
    controller.abort()
    const outcome = await running
    expect(outcome.exitCode === null || outcome.signal !== null).toBe(true)
  })
})

describe('what a failure turns into', () => {
  const outcome = (over: Partial<ExecOutcome<string>>): ExecOutcome<string> => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    command: 'thing',
    ...over
  })

  it('returns stdout when the command succeeded', () => {
    expect(defaultParseOutput(outcome({ stdout: 'output' }))).toBe('output')
  })

  /**
   * A failed command has almost always already said why. Replacing that with
   * "exited with code 1" throws away the only useful sentence in the exchange.
   */
  it('throws what the command said on stderr', () => {
    expect(() => defaultParseOutput(outcome({ exitCode: 1, stderr: 'no such branch' }))).toThrow(
      'no such branch'
    )
  })

  it('falls back to naming the command and the code when stderr is empty', () => {
    expect(() => defaultParseOutput(outcome({ exitCode: 2 }))).toThrow(/thing exited with code 2/)
  })

  it('reports a signal as a signal', () => {
    expect(() => defaultParseOutput(outcome({ exitCode: null, signal: 'SIGKILL' }))).toThrow(
      /killed with SIGKILL/
    )
  })

  it('rethrows a spawn failure untouched', () => {
    const error = new Error('ENOENT')
    expect(() => defaultParseOutput(outcome({ error, exitCode: null }))).toThrow(error)
  })
})

// --- the hook, rendered for real ---------------------------------------------

/**
 * `useExec` caches through `useCachedPromise`, which opens a `Cache` — so the
 * hook needs a runtime and a support directory even though nothing here talks to
 * the desktop. A throwaway one per run keeps the cache from carrying results
 * between tests, which is exactly the confusion the cache exists to create.
 */
const supportPath = mkdtempSync(join(tmpdir(), 'lumanin-exec-'))
afterAll(() => rmSync(supportPath, { recursive: true, force: true }))

const fakeRuntime = (support: string): ShimRuntime => ({
  spec: {
    sessionId: 'exec-test',
    extensionName: 'fixture',
    extensionTitle: 'Fixture',
    extensionDir: '/tmp/fixture',
    commandName: 'run',
    commandTitle: 'Run',
    commandMode: 'view',
    entryPath: '/tmp/fixture/commands/run.js',
    launchContext: {},
    preferences: {},
    launchArguments: {},
    environment: {
      assetsPath: '/tmp/fixture/assets',
      supportPath: support,
      appearance: 'dark',
      textSize: 'medium',
      isDevelopment: false,
      launchType: 'userInitiated',
      apiVersion: '1.104.24'
    }
  },
  call: async () => undefined as never,
  notify: () => {},
  setHandler: (id) => id,
  nextHandlerId: () => 'h',
  scheduleRender: () => {}
})

installRuntime(fakeRuntime(supportPath))

interface Harness {
  render(element: ReactNode): RenderNode
  readonly errors: unknown[]
}

function harness(): Harness {
  const errors: unknown[] = []
  const sink: SerializeSink = { handler: () => {}, reject: () => {} }
  const renderer = createRenderer({
    onCommit: () => {},
    onError: (error) => errors.push(error)
  })
  return {
    errors,
    render(element) {
      renderer.render(element)
      renderer.flush()
      return serializeTree(renderer.root, sink).node
    }
  }
}

/** Re-render until the command has finished, or give up loudly. */
async function settle(h: Harness, element: ReactNode): Promise<RenderNode> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const tree = h.render(element)
    const list = tree.children[0] as RenderNode | undefined
    if (list !== undefined && list.props['isLoading'] === false) return tree
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('useExec never finished loading')
}

describe('useExec, rendered', () => {
  it('renders what the command printed', async () => {
    const h = harness()
    const Command = (): ReactNode => {
      const { isLoading, data } = useExec('/bin/echo', ['from the command'])
      return createElement(
        'List',
        { isLoading },
        createElement('List.Item', { key: 'out', title: data ?? '' })
      )
    }

    const tree = await settle(h, createElement(Command))
    const item = (tree.children[0] as RenderNode).children[0] as RenderNode
    expect(item.props['title']).toBe('from the command')
    expect(h.errors).toEqual([])
  })

  /**
   * A failing command must reach `error`, not take the worker down. `usePromise`
   * rethrows so `revalidate()` callers see it, and the hook's own effect swallows
   * that — an unhandled rejection in a worker is a crashed command.
   */
  it('reports a failing command as an error instead of crashing', async () => {
    const h = harness()
    const Command = (): ReactNode => {
      const { isLoading, error } = useExec('/bin/sh', ['-c', 'echo nope >&2; exit 1'], {
        // Without this the failure would try to raise a toast, which needs a
        // session the reconciler alone does not have.
        onError: () => {}
      })
      return createElement(
        'List',
        { isLoading },
        createElement('List.Item', { key: 'out', title: error?.message ?? 'no error' })
      )
    }

    const tree = await settle(h, createElement(Command))
    const item = (tree.children[0] as RenderNode).children[0] as RenderNode
    expect(item.props['title']).toBe('nope')
    expect(h.errors).toEqual([])
  })

  /**
   * `useExec` caches through `useCachedPromise`, whose cache is JSON — and
   * `JSON.stringify` does not refuse a Buffer, it writes `{"type":"Buffer"…}`.
   * Cached, that would come back as a plain object, so a plugin would get a real
   * Buffer on a cold run and an object whenever the cache happened to be warm.
   */
  it('never hands back a Buffer that went through the JSON cache', async () => {
    const h = harness()
    const seen: unknown[] = []
    const Command = (): ReactNode => {
      const { isLoading, data } = useExec<Buffer>('/bin/echo', ['bytes'], {
        encoding: 'buffer'
      })
      if (data !== undefined) seen.push(data)
      return createElement('List', { isLoading })
    }

    // Twice: the first run fills the cache, the second reads it back as
    // `initialData` before the command has finished. That second mount is where
    // a resurrected `{type:'Buffer',data:[…]}` would show up.
    await settle(h, createElement(Command))
    await settle(harness(), createElement(Command))

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((value) => Buffer.isBuffer(value))).toBe(true)
  })

  /**
   * Two hooks in one command address one cache file. Each holding its own parsed
   * copy would mean the second write persists a snapshot taken before the first
   * one, so whichever finished last would be the only entry left on disk.
   */
  it('keeps both hooks of a command in the written cache', async () => {
    const h = harness()
    const Command = (): ReactNode => {
      const first = useExec('/bin/echo', ['first hook'])
      const second = useExec('/bin/echo', ['second hook'])
      return createElement('List', { isLoading: first.isLoading || second.isLoading })
    }

    await settle(h, createElement(Command))
    flushCaches()

    const written = readFileSync(join(supportPath, 'cache', 'raycast-utils.json'), 'utf8')
    expect(written).toContain('first hook')
    expect(written).toContain('second hook')
    expect(h.errors).toEqual([])
  })
})

/**
 * `cacheWriteDebounce` travels from a plugin's options through the hook into
 * `Cache.set`, and every step of that is a value being passed on rather than
 * used, so an argument dropped anywhere along it still typechecks and still
 * renders, and every plugin silently gets the default delay instead of the one
 * it asked for. What the option changes is when the file appears, so that is
 * what these two read.
 */
describe('cacheWriteDebounce, through the hook', () => {
  const cacheFile = (support: string): string => join(support, 'cache', 'raycast-utils.json')

  /** A support directory of its own, so an earlier case's file cannot answer for this one. */
  function freshSupport(): string {
    const support = mkdtempSync(join(tmpdir(), 'lumanin-debounce-'))
    afterAll(() => rmSync(support, { recursive: true, force: true }))
    installRuntime(fakeRuntime(support))
    return support
  }

  it('writes the cache as the run finishes when asked for no delay', async () => {
    const support = freshSupport()
    const Command = (): ReactNode => {
      const { isLoading } = useExec('/bin/echo', ['no delay'], { cacheWriteDebounce: 0 })
      return createElement('List', { isLoading })
    }

    await settle(harness(), createElement(Command))

    expect(existsSync(cacheFile(support))).toBe(true)
  })

  it('holds the write back when the option is left out', async () => {
    const support = freshSupport()
    const Command = (): ReactNode => {
      const { isLoading } = useExec('/bin/echo', ['default delay'])
      return createElement('List', { isLoading })
    }

    await settle(harness(), createElement(Command))

    expect(existsSync(cacheFile(support))).toBe(false)
    // Nothing is left armed over a directory this file is about to remove.
    flushCaches()
    expect(existsSync(cacheFile(support))).toBe(true)
  })
})

/**
 * What happens to a run the user has already moved on from — by clearing the
 * box, or by typing the next character. Both leave a command running and a
 * promise that is about to answer a question nobody is asking any more.
 */
describe('a run the user has moved on from', () => {
  const supports: string[] = []
  let support = ''

  beforeEach(() => {
    support = mkdtempSync(join(tmpdir(), 'lumanin-supersede-'))
    supports.push(support)
    installRuntime(fakeRuntime(support))
  })

  afterAll(() => {
    for (const dir of supports) rmSync(dir, { recursive: true, force: true })
  })

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * These components never reach `isLoading: false` on the path being tested —
   * that is the point of them — so they are driven for a fixed window instead of
   * being settled.
   */
  async function pump(h: Harness, element: ReactNode, ms: number): Promise<RenderNode> {
    let tree = h.render(element)
    const until = Date.now() + ms
    while (Date.now() < until) {
      await sleep(10)
      tree = h.render(element)
    }
    return tree
  }

  it('kills the command and discards its answer when execute goes false', async () => {
    const marker = join(support, 'late.txt')
    let execute = true
    let seen: string | undefined
    const Command = (): ReactNode => {
      const { isLoading, data } = useExec('/bin/sh', ['-c', `sleep 2; echo late > ${marker}`], {
        execute,
        onError: () => {}
      })
      seen = data
      return createElement('List', { isLoading })
    }

    const h = harness()
    await pump(h, createElement(Command), 100)
    execute = false
    await pump(h, createElement(Command), 2500)

    expect(existsSync(marker)).toBe(false)
    expect(seen).toBeUndefined()
  }, 15000)

  /**
   * Re-render until the hook has produced a given answer.
   *
   * `settle` cannot be used across a change of arguments: the render that
   * carries the new ones is still holding the finished state of the old run, so
   * it reads as already settled and returns last time's answer.
   */
  async function settleTo(h: Harness, element: ReactNode, title: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const tree = h.render(element)
      const list = tree.children[0] as RenderNode | undefined
      const item = list?.children[0] as RenderNode | undefined
      if (item?.props['title'] === title) return
      await sleep(10)
    }
    throw new Error(`the command never produced ${title}`)
  }

  it('re-runs when the input on stdin changes', async () => {
    let input = 'one'
    const Command = (): ReactNode => {
      const { isLoading, data } = useExec('/bin/cat', [], { input })
      return createElement(
        'List',
        { isLoading },
        createElement('List.Item', { key: 'out', title: data ?? '' })
      )
    }

    const h = harness()
    await settleTo(h, createElement(Command), 'one')
    input = 'two'
    await settleTo(h, createElement(Command), 'two')
  })

  it('re-runs when the environment changes', async () => {
    let mark = 'one'
    const Command = (): ReactNode => {
      const { isLoading, data } = useExec('/bin/sh', ['-c', 'echo "$MARK"'], {
        env: { ...process.env, MARK: mark }
      })
      return createElement(
        'List',
        { isLoading },
        createElement('List.Item', { key: 'out', title: data ?? '' })
      )
    }

    const h = harness()
    await settleTo(h, createElement(Command), 'one')
    mark = 'two'
    await settleTo(h, createElement(Command), 'two')
  })

  /**
   * A plain promise, not a command: an aborted child rejects with an
   * `AbortError`, which was already filtered, so this gap only shows on a hook
   * with no controller to abort. The failure belongs to a query the user has
   * left, and reporting it puts a toast over the answer to the one they are on.
   */
  it('reports nothing when a superseded promise rejects', async () => {
    let which = 'first'
    let loading: boolean | undefined
    const onError = vi.fn()
    const Command = (): ReactNode => {
      const { isLoading } = usePromise(
        async (asked: string) => {
          if (asked === 'first') {
            await sleep(200)
            throw new Error('the answer nobody waited for')
          }
          await sleep(10)
          return asked
        },
        [which],
        { onError }
      )
      loading = isLoading
      return createElement('List', { isLoading })
    }

    const h = harness()
    await pump(h, createElement(Command), 50)
    which = 'second'
    await pump(h, createElement(Command), 500)

    expect(onError).not.toHaveBeenCalled()
    expect(loading).toBe(false)
  })

  /**
   * The other half of the abort rule: an abort the *plugin* raised on the
   * current run is a failure, not the hook doing its job. Before this, the
   * name alone was enough to skip state, and the spinner never stopped.
   */
  it('reports an abort the plugin raised itself, and stops loading', async () => {
    const onError = vi.fn()
    let last: { isLoading: boolean; error: Error | undefined } | undefined
    const Command = (): ReactNode => {
      const { isLoading, error } = usePromise(
        async () => {
          await sleep(10)
          const aborted = new Error('aborted')
          aborted.name = 'AbortError'
          throw aborted
        },
        [],
        { onError }
      )
      last = { isLoading, error }
      return createElement('List', { isLoading })
    }

    const h = harness()
    await pump(h, createElement(Command), 300)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(last?.isLoading).toBe(false)
    expect(last?.error?.name).toBe('AbortError')
  })
})
