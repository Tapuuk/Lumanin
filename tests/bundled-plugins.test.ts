import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeIndexes, scanAllExtensions, scanExtensions } from '../src/main/extensions/registry'
import { bundledPluginsDir } from '../src/node/paths'

/**
 * Plugins that ship inside the application.
 *
 * Some of the launcher's own features are plugins — file search first — because
 * a search over something the machine already knows is exactly what the plugin
 * API is for, and writing them any other way would mean a second, worse way to
 * build a searchable view.
 *
 * What has to be true of one: it is found without being installed, it can be
 * turned off, it cannot be deleted, its scratch space is somewhere writable, and
 * a plugin of the same name that the user installed **wins**.
 */

function tree(): string {
  return mkdtempSync(join(tmpdir(), 'lumanin-bundled-'))
}

function plugin(
  directory: string,
  name: string,
  options: { readonly title?: string; readonly commands?: readonly string[] } = {}
): void {
  const commands = options.commands ?? ['search']
  const home = join(directory, name)
  mkdirSync(join(home, 'commands'), { recursive: true })
  writeFileSync(
    join(home, 'package.json'),
    JSON.stringify({
      name,
      title: options.title ?? name,
      description: 'x',
      commands: commands.map((command) => ({ name: command, title: command, mode: 'view' }))
    })
  )
  for (const command of commands) writeFileSync(join(home, 'commands', `${command}.js`), '')
}

describe('scanning a bundled directory', () => {
  it('marks what it finds as shipped rather than installed', () => {
    const root = tree()
    plugin(root, 'files')

    expect(scanExtensions(root).extensions[0]?.bundled).toBe(false)
    expect(scanExtensions(root, undefined, { bundled: true }).extensions[0]?.bundled).toBe(true)
  })

  it('puts the scratch space somewhere writable', () => {
    // `environment.supportPath` inside the application directory works on the
    // machine of everyone who builds from a checkout and fails on every install
    // that came from a package, where that directory belongs to the package
    // manager. So a bundled plugin's is redirected under the data dir.
    const root = tree()
    const data = tree()
    plugin(root, 'files')

    const scanned = scanExtensions(root, undefined, { bundled: true, supportRoot: data })
    expect(scanned.extensions[0]?.supportPath).toBe(join(data, 'files'))

    // An installed one keeps its own, which is inside a directory it owns.
    expect(scanExtensions(root).extensions[0]?.supportPath).toBe(join(root, 'files', 'support'))
  })
})

describe('mergeIndexes', () => {
  it('offers both when the names do not collide', () => {
    const installed = tree()
    const bundled = tree()
    plugin(installed, 'godot')
    plugin(bundled, 'files')

    const merged = mergeIndexes(scanExtensions(installed), scanExtensions(bundled, undefined, { bundled: true }))
    expect(merged.extensions.map((extension) => extension.manifest.name)).toEqual(['godot', 'files'])
    expect(merged.commands.map((command) => command.id)).toEqual(['godot/search', 'files/search'])
  })

  it('lets an installed plugin replace the one we ship', () => {
    // What makes a bundled plugin a *default* rather than a fixture: somebody
    // who wants file search to work differently writes their own `files`,
    // installs it, and ours steps aside — no flag to find, no setting to know.
    const installed = tree()
    const bundled = tree()
    plugin(installed, 'files', { title: 'My Files', commands: ['mine', 'other'] })
    plugin(bundled, 'files', { title: 'Files' })

    const merged = mergeIndexes(scanExtensions(installed), scanExtensions(bundled, undefined, { bundled: true }))
    expect(merged.extensions).toHaveLength(1)
    expect(merged.extensions[0]?.manifest.title).toBe('My Files')
    expect(merged.extensions[0]?.bundled).toBe(false)

    // In full, rather than command-by-command: a half-and-half index would run
    // two authors' code under one name, and the user would be looking at a
    // plugin that exists nowhere on disk.
    expect(merged.commands.map((command) => command.id)).toEqual(['files/mine', 'files/other'])
  })

  it('drops the shipped one’s problems along with it', () => {
    const installed = tree()
    const bundled = tree()
    plugin(installed, 'files')
    // A manifest that does not parse: a problem, not an extension.
    mkdirSync(join(bundled, 'files'), { recursive: true })
    writeFileSync(join(bundled, 'files', 'package.json'), '{ not json')

    const merged = mergeIndexes(scanExtensions(installed), scanExtensions(bundled, undefined, { bundled: true }))
    expect(merged.problems).toEqual([])
  })
})

describe('scanAllExtensions', () => {
  it('is the one answer to "which plugins are there"', () => {
    // Four call sites used to each scan one directory. The moment a plugin could
    // also arrive inside the application, that meant file search running at the
    // root and absent from every screen that manages plugins.
    const data = tree()
    const extensionsDir = join(data, 'extensions')
    const bundledDir = tree()
    plugin(extensionsDir, 'godot')
    plugin(bundledDir, 'files')

    const index = scanAllExtensions({ extensionsDir, bundledDir, dataDir: data })
    expect(index.commands.map((command) => command.id).sort()).toEqual([
      'files/search',
      'godot/search'
    ])
    expect(index.extensions.find((extension) => extension.manifest.name === 'files')?.supportPath).toBe(
      join(data, 'plugin-support', 'files')
    )
  })

  it('is an empty index when neither directory exists', () => {
    const index = scanAllExtensions({
      extensionsDir: '/nonexistent/a',
      bundledDir: '/nonexistent/b',
      dataDir: '/nonexistent'
    })
    expect(index.extensions).toEqual([])
    expect(index.problems).toEqual([])
  })
})

describe('finding the bundled directory', () => {
  it('looks upward rather than exactly one level', () => {
    // The defect: `join(moduleDir, '..', 'plugins')` is right for
    // `out/main/index.js` and wrong for the CLI, whose code rollup splits into
    // `out/main/chunks/` — so the daemon found the bundled plugins and every
    // CLI screen did not. What is true is that `plugins/` sits beside the built
    // bundles; how deep the caller is is a fact about the bundler.
    const root = tree()
    mkdirSync(join(root, 'out', 'plugins'), { recursive: true })
    mkdirSync(join(root, 'out', 'main', 'chunks'), { recursive: true })

    expect(bundledPluginsDir(join(root, 'out', 'main'))).toBe(join(root, 'out', 'plugins'))
    expect(bundledPluginsDir(join(root, 'out', 'main', 'chunks'))).toBe(join(root, 'out', 'plugins'))
  })

  it('prefers a packaged resources directory when there is one', () => {
    const root = tree()
    mkdirSync(join(root, 'resources', 'plugins'), { recursive: true })
    mkdirSync(join(root, 'out', 'plugins'), { recursive: true })

    expect(bundledPluginsDir(join(root, 'out', 'main'), join(root, 'resources'))).toBe(
      join(root, 'resources', 'plugins')
    )
  })

  it('still answers with a real path when this build ships none', () => {
    const root = tree()
    mkdirSync(join(root, 'out', 'main'), { recursive: true })
    // Not an error and not a throw: a scan of a directory that is not there is
    // already "no extensions", which is the correct answer.
    expect(bundledPluginsDir(join(root, 'out', 'main'))).toBe(join(root, 'out', 'plugins'))
  })

  it('does not walk far enough to find the repository’s source plugins', () => {
    // A checkout has `plugins/` at its root holding *source* — `src/` and no
    // built `commands/`. Reaching it would turn "this build has no bundled
    // plugins" into one "reinstall the extension" problem per command.
    const root = tree()
    mkdirSync(join(root, 'plugins', 'files', 'src'), { recursive: true })
    mkdirSync(join(root, 'out', 'main', 'chunks'), { recursive: true })

    expect(bundledPluginsDir(join(root, 'out', 'main', 'chunks'))).toBe(
      join(root, 'out', 'main', 'plugins')
    )
  })
})
