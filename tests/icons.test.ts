import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createIconResolver, type IconResolver } from '../src/platform/apps/icons'

/**
 * Icon theme resolution, driven against a temp tree.
 *
 * The injected `exists` does two jobs: it records every filesystem question the
 * resolver asks, which is how the probe count is asserted, and it answers `false`
 * for anything outside the tree, so a developer machine's own icon themes cannot
 * make a test pass that would fail in a clean checkout.
 */

const trees: string[] = []

afterEach(() => {
  while (trees.length > 0) {
    const root = trees.pop()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  }
})

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'lumanin-icons-'))
  trees.push(root)
  return root
}

function put(root: string, relative: string): string {
  const file = join(root, relative)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'icon')
  return file
}

interface Probed {
  readonly resolver: IconResolver
  readonly probed: string[]
}

function resolverFor(root: string, gnomeTheme: () => Promise<string | null> = async () => null): Probed {
  const probed: string[] = []
  const resolver = createIconResolver({
    env: { XDG_DATA_DIRS: join(root, 'share'), XDG_CONFIG_HOME: join(root, 'config') },
    home: root,
    exists: (path) => {
      probed.push(path)
      return path.startsWith(root) && existsSync(path)
    },
    gnomeTheme
  })
  return { resolver, probed }
}

/** The questions that were about a file rather than about a directory. */
const fileProbes = (probed: readonly string[]): readonly string[] =>
  probed.filter((path) => /\.(svg|png|xpm)$/.test(path))

describe('icon theme resolution', () => {
  it('finds a name in the size-then-category layout', () => {
    const root = tree()
    const file = put(root, 'share/icons/hicolor/48x48/apps/editor.svg')

    const { resolver } = resolverFor(root)
    expect(resolver.resolve('editor')).toBe(file)
  })

  it('finds a name in the category-then-size layout', () => {
    const root = tree()
    const file = put(root, 'share/icons/Papirus/apps/48x48/editor.png')

    const { resolver } = resolverFor(root)
    expect(resolver.resolve('editor')).toBe(file)
  })

  it('remembers a name it could not find', () => {
    const root = tree()
    put(root, 'share/icons/hicolor/48x48/apps/editor.svg')

    const { resolver, probed } = resolverFor(root)
    expect(resolver.resolve('nothing-like-this')).toBeNull()

    probed.length = 0
    expect(resolver.resolve('nothing-like-this')).toBeNull()
    expect(probed).toEqual([])
  })

  it('never asks for a file under a directory that does not exist', () => {
    const root = tree()
    put(root, 'share/icons/hicolor/48x48/apps/editor.svg')

    const { resolver, probed } = resolverFor(root)
    resolver.resolve('nothing-like-this')

    const outside = fileProbes(probed).filter((path) => !existsSync(dirname(path)))
    expect(outside).toEqual([])
  })

  it('prefers a better extension over a better category', () => {
    const root = tree()
    const apps = put(root, 'share/icons/hicolor/48x48/apps/x.svg')
    put(root, 'share/icons/hicolor/48x48/mimetypes/x.png')

    const { resolver } = resolverFor(root)
    expect(resolver.resolve('x', ['mimetypes', 'apps'])).toBe(apps)
  })

  it('costs a bounded number of candidates when a name is missing', () => {
    const root = tree()
    put(root, 'share/icons/hicolor/48x48/apps/editor.svg')
    put(root, 'share/icons/Papirus/apps/48x48/editor.png')

    const { resolver, probed } = resolverFor(root)
    resolver.resolve('nothing-like-this')

    // Two leaf directories exist, and each is asked for three extensions.
    expect(fileProbes(probed)).toHaveLength(6)
  })

  it('works before the desktop answers, and uses the answer once it arrives', async () => {
    const root = tree()
    const known = put(root, 'share/icons/hicolor/48x48/apps/editor.svg')
    const themed = put(root, 'share/icons/Bespoke/48x48/apps/dialer.svg')

    let answer: (theme: string | null) => void = () => {}
    const pending = new Promise<string | null>((resolve) => {
      answer = resolve
    })

    const { resolver } = resolverFor(root, () => pending)
    expect(resolver.resolve('editor')).toBe(known)
    expect(resolver.resolve('dialer')).toBeNull()

    answer('Bespoke')
    await pending
    await Promise.resolve()

    expect(resolver.resolve('dialer')).toBe(themed)
    expect(resolver.resolve('editor')).toBe(known)
  })

  it('picks up a theme installed after the last rebuild', () => {
    const root = tree()
    put(root, 'share/icons/hicolor/48x48/apps/editor.svg')

    const { resolver } = resolverFor(root)
    resolver.refresh()
    expect(resolver.resolve('dialer')).toBeNull()

    const added = put(root, 'share/icons/Adwaita/48x48/apps/dialer.svg')
    resolver.refresh()
    expect(resolver.resolve('dialer')).toBe(added)
  })

  it('keeps what it found when nothing on disk moved', () => {
    const root = tree()
    const file = put(root, 'share/icons/hicolor/48x48/apps/editor.svg')

    const { resolver, probed } = resolverFor(root)
    resolver.refresh()
    expect(resolver.resolve('editor')).toBe(file)

    probed.length = 0
    resolver.refresh()
    expect(resolver.resolve('editor')).toBe(file)
    expect(fileProbes(probed)).toEqual([])
  })
})
