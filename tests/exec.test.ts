import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement, type ReactNode } from 'react'
import { afterAll, describe, expect, it } from 'vitest'
import { installRuntime } from '../src/api-shim/runtime'
import {
  defaultParseOutput,
  runCommand,
  splitCommand,
  type ExecOutcome
} from '../src/api-shim/exec'
import { useExec } from '../src/api-shim/utils'
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

installRuntime({
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
      supportPath,
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
})
