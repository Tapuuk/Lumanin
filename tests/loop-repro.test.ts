import { createElement, useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installRuntime, type ShimRuntime } from '../src/api-shim/runtime'
import { createRenderer } from '../src/host/reconciler'

const support = mkdtempSync(join(tmpdir(), 'loop-repro-'))

const SPEC = {
  extensionName: 'fixture',
  extensionTitle: 'Fixture',
  commandName: 'run',
  commandTitle: 'Run',
  commandMode: 'view',
  entryPath: '/tmp/fixture/commands/run.js',
  launchContext: {},
  preferences: {},
  launchArguments: {},
  environment: {
    assetsPath: join(support, 'assets'),
    supportPath: support,
    appearance: 'dark',
    textSize: 'medium',
    isDevelopment: false,
    launchType: 'userInitiated',
    apiVersion: '1.104.24'
  }
}

let counter = 0
const handlers = new Map<string, (payload?: unknown) => void>()

const runtime: ShimRuntime = {
  spec: SPEC as never,
  call: async () => null as never,
  notify: () => {},
  setHandler: (id, handler) => {
    if (handler === null) handlers.delete(id)
    else handlers.set(id, handler as never)
    return id
  },
  nextHandlerId: () => `h${++counter}`,
  scheduleRender: () => {}
}

installRuntime(runtime)

afterEach(() => {
  rmSync(support, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const ARGS: Record<string, string[]> = {
  prs: ['-c', 'echo prs-answer'],
  issues: ['-c', 'echo issues-answer'],
  repos: ['-c', 'echo repos-answer']
}

const FAILING: Record<string, string[]> = {
  prs: ['-c', 'echo not-signed-in >&2; exit 4'],
  issues: ['-c', 'echo not-signed-in >&2; exit 4'],
  repos: ['-c', 'echo not-signed-in >&2; exit 4']
}

async function mountOnce(
  renders: { count: number },
  errors: Error[],
  args: Record<string, string[]>,
  drive?: (setCategory: (value: string) => void) => Promise<void>
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useExec } = await import('../src/api-shim/utils')

  let setCategoryOutside: (value: string) => void = () => {}

  function GithubLike(): ReactNode {
    const [category, setCategory] = useState('prs')
    setCategoryOutside = setCategory
    const { isLoading, data } = useExec('bash', args[category] ?? args.prs, { timeout: 30000 })
    renders.count++
    return createElement(
      'List',
      { isLoading },
      createElement('List.Dropdown', { value: category, onChange: setCategory }),
      createElement('List.Item', { title: String(data ?? '') })
    )
  }

  const renderer = createRenderer({
    onCommit: () => {},
    onError: (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
  })
  renderer.render(createElement(GithubLike))
  if (drive !== undefined) await drive((value) => setCategoryOutside(value))
  await sleep(400)
  renderer.render(null)
  await sleep(50)
}

describe('useExec under a controlled dropdown', () => {
  it('does not re-render forever, on a cold or a cached mount', async () => {
    const errors: Error[] = []

    const first = { count: 0 }
    await mountOnce(first, errors, ARGS)

    // The second mount finds the first one's value in the worker's copy of the
    // cache - the state the real window is in every time a command is reopened.
    const second = { count: 0 }
    await mountOnce(second, errors, ARGS)

    expect(errors.map((error) => error.message)).toEqual([])
    expect(first.count).toBeLessThan(20)
    expect(second.count).toBeLessThan(20)
  }, 15000)

  it('does not re-render forever when the command fails and the category flips fast', async () => {
    const errors: Error[] = []
    const renders = { count: 0 }
    await mountOnce(renders, errors, FAILING, async (setCategory) => {
      await sleep(30)
      setCategory('issues')
      setCategory('repos')
      await sleep(30)
      setCategory('prs')
    })

    expect(errors.map((error) => error.message)).toEqual([])
    expect(renders.count).toBeLessThan(40)
  }, 15000)
})
