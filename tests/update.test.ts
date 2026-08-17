import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyUpdate, checkForUpdates, detectInstall, pathWithNodeManagers } from '../src/node/update'
import { runCommand } from '../src/store/git'
import type { Run, RunResult } from '../src/store/git'

const ok = (output = ''): RunResult => ({ ok: true, output })
const no = (output = ''): RunResult => ({ ok: false, output })

/** A scripted `Run`: answers by the argv joined, records what was asked. */
function scripted(answers: Record<string, RunResult>): { run: Run; calls: string[] } {
  const calls: string[] = []
  const run: Run = async (command, args) => {
    const key = [command, ...args].join(' ')
    calls.push(key)
    const hit = Object.entries(answers).find(([prefix]) => key.startsWith(prefix))
    return hit?.[1] ?? no(`unscripted: ${key}`)
  }
  return { run, calls }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function realCheckout(): Promise<{ upstream: string; clone: string }> {
  const base = mkdtempSync(join(tmpdir(), 'lumanin-update-'))
  dirs.push(base)
  const upstream = join(base, 'upstream')
  const clone = join(base, 'clone')
  const git = async (args: string[], cwd: string): Promise<void> => {
    const result = await runCommand('git', args, cwd)
    if (!result.ok) throw new Error(result.output)
  }
  await git(['init', '-q', '-b', 'main', upstream], base)
  await git(['-C', upstream, 'config', 'user.email', 't@example.com'], base)
  await git(['-C', upstream, 'config', 'user.name', 't'], base)
  await git(['-C', upstream, 'commit', '-q', '--allow-empty', '-m', 'one'], base)
  await git(['clone', '-q', upstream, clone], base)
  return { upstream, clone }
}

describe('detectInstall', () => {
  it('a directory with .git is a git checkout on its current branch', async () => {
    const { clone } = await realCheckout()
    const install = await detectInstall(clone)
    expect(install).toEqual({ kind: 'git', root: clone, branch: 'main' })
  })

  it('a tree owned by pacman is a package', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumanin-update-'))
    dirs.push(dir)
    const { run } = scripted({ 'pacman -Qqo': ok('lumanin\n') })
    expect(await detectInstall(dir, run)).toEqual({ kind: 'package', root: dir, manager: 'pacman', name: 'lumanin' })
  })

  it('anything else is unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumanin-update-'))
    dirs.push(dir)
    const { run } = scripted({})
    expect(await detectInstall(dir, run)).toEqual({ kind: 'unknown', root: dir })
  })
})

describe('checkForUpdates on a real checkout', () => {
  it('reports up to date, then the commits behind once upstream moves, then applies them', async () => {
    const { upstream, clone } = await realCheckout()
    const install = await detectInstall(clone)
    const before = await checkForUpdates(install, '1.0.0')
    expect(before.available).toBe(false)
    expect(before.problem).toBeNull()
    expect(before.current).toMatch(/^1\.0\.0 \([0-9a-f]{7,}\)$/)

    await runCommand('git', ['commit', '-q', '--allow-empty', '-m', 'two: a fix'], upstream)
    await runCommand('git', ['commit', '-q', '--allow-empty', '-m', 'three'], upstream)
    const after = await checkForUpdates(install, '1.0.0')
    expect(after.available).toBe(true)
    expect(after.changes).toHaveLength(2)
    expect(after.changes[0]).toContain('three')
    expect(after.dirty).toBe(false)

    // Applying: the pull happens; the install script is absent in this fixture,
    // and that is reported rather than pretended.
    const lines: string[] = []
    const outcome = await applyUpdate(install, (line) => lines.push(line))
    expect(outcome.ok).toBe(false)
    expect(outcome.log).toContain('install.sh is missing')
    const head = await runCommand('git', ['log', '--oneline', '-1'], clone)
    expect(head.output).toContain('three')
  })

  it('a checkout with no reachable remote says so instead of "up to date"', async () => {
    const { clone } = await realCheckout()
    await runCommand('git', ['remote', 'set-url', 'origin', '/nonexistent/repo.git'], clone)
    const check = await checkForUpdates(await detectInstall(clone), '1.0.0')
    expect(check.available).toBe(false)
    expect(check.problem).toContain('could not reach')
  })
})

describe('checkForUpdates for a package', () => {
  it('names the package manager and never fetches', async () => {
    const { run, calls } = scripted({ 'pacman -Q lumanin': ok('lumanin 1.0.0-1\n') })
    const check = await checkForUpdates({ kind: 'package', root: '/usr/lib/lumanin', manager: 'pacman', name: 'lumanin' }, '1.0.0', run)
    expect(check.current).toBe('1.0.0-1')
    expect(check.problem).toContain('package manager')
    expect(calls.some((c) => c.startsWith('git'))).toBe(false)
    const outcome = await applyUpdate({ kind: 'package', root: '/usr/lib/lumanin', manager: 'pacman', name: 'lumanin' }, () => undefined, run)
    expect(outcome.ok).toBe(false)
    expect(outcome.log).toContain('yay -Syu lumanin')
  })
})

describe('pathWithNodeManagers', () => {
  it('appends only directories that exist and are not already on PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'lumanin-update-home-'))
    dirs.push(home)
    expect(pathWithNodeManagers('/usr/bin', home)).toBe('/usr/bin')
    const shims = join(home, '.local', 'share', 'mise', 'shims')
    require('node:fs').mkdirSync(shims, { recursive: true })
    expect(pathWithNodeManagers('/usr/bin', home)).toBe(`/usr/bin:${shims}`)
    expect(pathWithNodeManagers(`/usr/bin:${shims}`, home)).toBe(`/usr/bin:${shims}`)
  })
})
