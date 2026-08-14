import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkoutName,
  parsePluginSource,
  PluginSourceError
} from '../src/store/plugin-source'
import {
  fetchPlugin,
  findPluginDirectories,
  PluginChoiceError,
  readProvenance,
  writeProvenance
} from '../src/store/plugin'
import { runPluginInstall } from '../src/cli/plugin'
import { FOREIGN_PLUGIN_MESSAGE, buildExtension } from '../src/main/extensions/build'
import { exportPlugin, resolveDownloadsDir } from '../src/cli/plugin-export'
import type { RunResult } from '../src/store/git'

/**
 * `lumanin plugin-install` — what it will and will not fetch.
 *
 * The parser is the boundary. A URL goes in and code that runs as the user comes
 * out, so the interesting tests are the refusals: everything this accepts is
 * something someone can get executed on your machine by sending you a link.
 */

describe('parsePluginSource', () => {
  it('takes the owner/name shorthand as GitHub', () => {
    expect(parsePluginSource('tapuuk/my-plugin')).toEqual({
      remote: 'https://github.com/tapuuk/my-plugin.git',
      label: 'github.com/tapuuk/my-plugin',
      ref: null,
      subdirectory: null
    })
  })

  it('takes a plain repository URL, with or without .git', () => {
    const bare = parsePluginSource('https://github.com/tapuuk/my-plugin')
    const dotted = parsePluginSource('https://github.com/tapuuk/my-plugin.git')
    expect(bare).toEqual(dotted)
    expect(bare.remote).toBe('https://github.com/tapuuk/my-plugin.git')
  })

  it('reads a ref and a subdirectory out of a GitHub browse URL', () => {
    // The URL in the address bar while looking at the directory, which is what
    // someone will paste.
    expect(parsePluginSource('https://github.com/o/r/tree/main/plugins/thing')).toMatchObject({
      ref: 'main',
      subdirectory: 'plugins/thing'
    })
    expect(parsePluginSource('https://github.com/o/r/tree/v1.2.0')).toMatchObject({
      ref: 'v1.2.0',
      subdirectory: null
    })
  })

  it('reads GitLab and Codeberg browse URLs too', () => {
    expect(parsePluginSource('https://gitlab.com/o/r/-/tree/main/sub')).toMatchObject({
      ref: 'main',
      subdirectory: 'sub'
    })
    expect(parsePluginSource('https://codeberg.org/o/r/src/branch/main/sub')).toMatchObject({
      ref: 'main',
      subdirectory: 'sub'
    })
  })

  it('keeps a self-hosted forge as a plain clone URL', () => {
    const source = parsePluginSource('https://git.example.org/team/thing')
    expect(source.remote).toBe('https://git.example.org/team/thing.git')
    expect(source.ref).toBeNull()
  })

  it('refuses anything that is not https', () => {
    for (const url of [
      'http://github.com/o/r',
      'git://github.com/o/r',
      'ssh://git@github.com/o/r',
      'file:///etc/passwd',
      'javascript:alert(1)//x/y'
    ]) {
      expect(() => parsePluginSource(url), url).toThrow(PluginSourceError)
    }
  })

  it('says why http and ssh in particular are refused', () => {
    // The message is the feature: "unsupported scheme" teaches nobody anything.
    expect(() => parsePluginSource('http://github.com/o/r')).toThrow(/rewritten by anyone/)
    expect(() => parsePluginSource('ssh://git@github.com/o/r')).toThrow(/your keys/)
  })

  it('refuses a path it cannot account for, rather than ignoring it', () => {
    // Silently installing the repository root while the user is looking at a URL
    // that names a subdirectory is the worst of the available answers.
    expect(() => parsePluginSource('https://github.com/o/r/releases/tag/v1')).toThrow(
      /path this does not understand/
    )
  })

  it('refuses a subdirectory that climbs out of the repository', () => {
    // Refused, but not by the `..` guard — `new URL()` normalises the path
    // first, so this arrives as `/o/r/etc` and is caught as a path with no
    // `tree/` marker. Worth pinning down which check actually fires, because the
    // `..` guard reads like the one doing the work and cannot be reached from a
    // URL at all. It stays as the second of three, for a caller that is not one.
    expect(() => parsePluginSource('https://github.com/o/r/tree/main/../../etc')).toThrow(
      PluginSourceError
    )
  })

  it('refuses an empty argument and a URL with no repository', () => {
    expect(() => parsePluginSource('   ')).toThrow(PluginSourceError)
    expect(() => parsePluginSource('https://github.com/onlyowner')).toThrow(/does not name a repository/)
  })

  it('does not mistake a hostname for the shorthand', () => {
    // `example.com/thing` is someone typing a URL without the scheme, not an
    // owner called `example.com`. Guessing GitHub there would clone the wrong
    // thing from the wrong place.
    expect(() => parsePluginSource('example.com/thing')).toThrow(PluginSourceError)
  })

  it('gives every repository a distinct cache directory', () => {
    const a = checkoutName(parsePluginSource('https://github.com/o/r'))
    const b = checkoutName(parsePluginSource('https://gitlab.com/o/r'))
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9._-]+$/)
  })
})

describe('fetchPlugin', () => {
  const ok = (output = ''): RunResult => ({ ok: true, output })

  it('says so plainly when git is missing, rather than failing at clone', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'lumanin-plugin-'))
    return expect(
      fetchPlugin({
        source: parsePluginSource('o/r'),
        cacheDir,
        run: () => Promise.resolve({ ok: false, output: 'command not found' })
      })
    ).rejects.toThrow(/git is not installed/)
  })

  it('fetches over https with an argv array, never a shell string', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'lumanin-plugin-'))
    const calls: { command: string; args: readonly string[] }[] = []

    await expect(
      fetchPlugin({
        source: parsePluginSource('https://github.com/o/r/tree/main/sub'),
        cacheDir,
        run: (command, args) => {
          calls.push({ command, args })
          return Promise.resolve(ok(command === 'git' && args[0] === 'rev-parse' ? 'abc123\n' : ''))
        }
      })
      // No package.json is written by the fake, so it stops after the fetch,
      // which is the part under test.
    ).rejects.toThrow(/no package.json/)

    expect(calls.every((call) => call.command === 'git')).toBe(true)

    const remote = calls.find((call) => call.args[0] === 'remote')
    expect(remote?.args).toContain('https://github.com/o/r.git')

    const fetch = calls.find((call) => call.args[0] === 'fetch')
    expect(fetch?.args).toEqual([
      'fetch',
      '--quiet',
      '--depth',
      '1',
      // A subdirectory was named, so this must not drag the whole repository
      // down: blobless, and the sparse patterns take one directory.
      '--filter=blob:none',
      'origin',
      'main'
    ])
  })

  it('fetches a root-level plugin whole, with no blob filter', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'lumanin-plugin-'))
    const calls: readonly string[][] = []
    const seen: string[][] = []

    await expect(
      fetchPlugin({
        source: parsePluginSource('o/r'),
        cacheDir,
        run: (_command, args) => {
          seen.push([...args])
          return Promise.resolve(ok())
        }
      })
    ).rejects.toThrow(/no package.json/)
    void calls

    const fetch = seen.find((args) => args[0] === 'fetch')
    expect(fetch).not.toContain('--filter=blob:none')
    // No ref was given, so the repository's own default branch.
    expect(fetch?.at(-1)).toBe('HEAD')
  })
})

describe('provenance', () => {
  it('round-trips, and reads as absent for a local install', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumanin-prov-'))
    expect(readProvenance(directory)).toBeNull()

    writeProvenance(directory, {
      label: 'github.com/o/r',
      remote: 'https://github.com/o/r.git',
      ref: 'main',
      subdirectory: null,
      commit: 'abc123def456',
      installedAt: '2026-08-09T00:00:00.000Z'
    })
    expect(readProvenance(directory)?.label).toBe('github.com/o/r')
    expect(readProvenance(directory)?.commit).toBe('abc123def456')
  })

  it('survives a file someone edited into nonsense', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumanin-prov-'))
    writeFileSync(join(directory, '.lumanin-source.json'), '{ not json')
    expect(readProvenance(directory)).toBeNull()
  })
})

describe('one install command', () => {
  /**
   * A directory that exists beats the `owner/name` shorthand.
   *
   * There is only one install command now, and it has to tell a repository from
   * a directory without being told which was meant. The rule is the least
   * surprising one available: if the argument names a directory on this machine,
   * that is what the person standing in it meant.
   */
  it('installs a local directory, and records no provenance for it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lumanin-local-'))
    const source = join(root, 'my-plugin')
    mkdirSync(join(source, 'src'), { recursive: true })
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'localdemo',
        title: 'Local Demo',
        description: 'From a directory',
        author: 'me',
        license: 'MIT',
        categories: ['Other'],
        commands: [{ name: 'go', title: 'Go', description: 'x', mode: 'view' }]
      })
    )
    writeFileSync(join(source, 'src', 'go.tsx'), 'export default function C() { return null }\n')

    const data = join(root, 'data')
    const previous = { ...process.env }
    process.env['XDG_DATA_HOME'] = data
    process.env['XDG_CACHE_HOME'] = join(root, 'cache')
    process.env['XDG_CONFIG_HOME'] = join(root, 'config')
    process.env['XDG_STATE_HOME'] = join(root, 'state')
    process.env['XDG_RUNTIME_DIR'] = join(root, 'run')

    try {
      expect(await runPluginInstall([source], new Set(['--yes']))).toBe(0)
      const installed = join(data, 'lumanin', 'extensions', 'localdemo')
      expect(readProvenance(installed)).toBeNull()
    } finally {
      process.env = previous
    }
  }, 30_000)
})

describe('the plugin API is the lumanin module', () => {
  const scaffold = (manifest: object, source: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'lumanin-api-'))
    const directory = join(root, 'plugin')
    mkdirSync(join(directory, 'src'), { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(directory, 'src', 'go.tsx'), source)
    return directory
  }

  const manifest = {
    name: 'apidemo',
    title: 'Api Demo',
    description: 'x',
    author: 'me',
    license: 'MIT',
    categories: ['Other'],
    commands: [{ name: 'go', title: 'Go', description: 'x', mode: 'view' }]
  }

  it('builds a plugin that imports from `lumanin` without any node_modules', async () => {
    const directory = scaffold(
      manifest,
      'import { List } from "lumanin"\nexport default function C() { return <List /> }\n'
    )
    const result = await buildExtension({ source: directory, destination: join(directory, 'out') })
    expect(result.built).toEqual(['go'])
    expect(result.failures).toEqual([])
  })

  /**
   * The refusal is name-free on purpose: the person who pasted the URL never
   * typed the old ecosystem's module names, so the error must not either.
   */
  it('refuses a plugin declaring the old ecosystem, in one honest sentence', async () => {
    const directory = scaffold(
      { ...manifest, dependencies: { '@raycast/api': '^1.0.0' } },
      'export default function C() { return null }\n'
    )
    await expect(
      buildExtension({ source: directory, destination: join(directory, 'out') })
    ).rejects.toThrow(/different launcher/)
    expect(FOREIGN_PLUGIN_MESSAGE).not.toMatch(/raycast/i)
  })

  it('turns an undeclared old-ecosystem import into the same sentence', async () => {
    const directory = scaffold(
      manifest,
      'import { List } from "@raycast/api"\nexport default function C() { return <List /> }\n'
    )
    const result = await buildExtension({ source: directory, destination: join(directory, 'out') })
    expect(result.built).toEqual([])
    expect(result.failures[0]?.reason).toMatch(/different launcher/)
    expect(result.failures[0]?.reason).not.toMatch(/raycast/i)
  })
})

describe('findPluginDirectories', () => {
  const plant = (root: string, relative: string, manifest: object): void => {
    const directory = join(root, ...relative.split('/'))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
  }
  const plugin = (name: string): object => ({ name, commands: [{ name: 'go' }] })

  it('finds a plugin one and two levels down, sorted, and stops there', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumanin-discover-'))
    plant(root, 'zeta', plugin('zeta'))
    plant(root, 'packages/alpha', plugin('alpha'))
    plant(root, 'packages/deep/three/down', plugin('too-deep'))

    expect(findPluginDirectories(root)).toEqual([
      { subdirectory: 'packages/alpha', name: 'alpha' },
      { subdirectory: 'zeta', name: 'zeta' }
    ])
  })

  it('ignores manifests that declare no commands, dot-dirs and node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumanin-discover-'))
    plant(root, 'library', { name: 'library' })
    plant(root, '.hidden/thing', plugin('hidden'))
    plant(root, 'node_modules/dep', plugin('dep'))

    expect(findPluginDirectories(root)).toEqual([])
  })

  it('does not descend into a plugin looking for more plugins', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumanin-discover-'))
    plant(root, 'outer', plugin('outer'))
    plant(root, 'outer/example', plugin('inner'))

    expect(findPluginDirectories(root)).toEqual([{ subdirectory: 'outer', name: 'outer' }])
  })

  it('lists every candidate in the choice error, with a way forward', () => {
    const error = new PluginChoiceError('github.com/o/r', [
      { subdirectory: 'a', name: 'alpha' },
      { subdirectory: 'b', name: 'beta' }
    ])
    expect(error.message).toContain('2 plugins')
    expect(error.message).toContain('a  (alpha)')
    expect(error.message).toContain('b  (beta)')
    expect(error.message).toContain('/tree/')
  })
})

describe('plugin-export', () => {
  const manifest = {
    name: 'expo',
    title: 'Expo',
    description: 'x',
    author: 'me',
    license: 'MIT',
    categories: ['Other'],
    commands: [{ name: 'go', title: 'Go', description: 'x', mode: 'view' }]
  }

  /** Scaffold a source plugin, install it the real way, return the dirs. */
  const installed = async (): Promise<{ extensionsDir: string; downloads: string }> => {
    const root = mkdtempSync(join(tmpdir(), 'lumanin-export-'))
    const source = join(root, 'source')
    mkdirSync(join(source, 'src'), { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify(manifest))
    writeFileSync(
      join(source, 'src', 'go.tsx'),
      'import { List } from "lumanin"\nexport default function C() { return <List /> }\n'
    )
    const extensionsDir = join(root, 'extensions')
    await buildExtension({ source, destination: join(extensionsDir, 'expo') })
    const downloads = join(root, 'Downloads')
    mkdirSync(downloads)
    return { extensionsDir, downloads }
  }

  it('hands back exactly what plugin-install accepts, and nothing of ours', async () => {
    const { extensionsDir, downloads } = await installed()

    const result = exportPlugin(extensionsDir, 'expo', downloads)
    expect(result.directory).toBe(join(downloads, 'expo'))
    expect(result.publishedAt).toBeNull()

    // The publishable half is there…
    expect(existsSync(join(result.directory, 'package.json'))).toBe(true)
    expect(existsSync(join(result.directory, 'src', 'go.tsx'))).toBe(true)
    // …and the machine output and our metadata are not.
    expect(existsSync(join(result.directory, 'commands'))).toBe(false)
    expect(existsSync(join(result.directory, 'support'))).toBe(false)
    expect(existsSync(join(result.directory, '.lumanin-source.json'))).toBe(false)

    // The circle actually closes: the export re-installs.
    const again = await buildExtension({
      source: result.directory,
      destination: join(downloads, 'reinstalled')
    })
    expect(again.built).toEqual(['go'])
  })

  it('scaffolds what a repository needs: README, .gitignore, and MIT on request', async () => {
    const { extensionsDir, downloads } = await installed()

    const bare = exportPlugin(extensionsDir, 'expo', downloads).directory
    expect(readFileSync(join(bare, 'README.md'), 'utf8')).toContain('plugin-install')
    expect(readFileSync(join(bare, 'README.md'), 'utf8')).toContain('Expo')
    expect(readFileSync(join(bare, '.gitignore'), 'utf8')).toContain('node_modules/')
    expect(existsSync(join(bare, 'LICENSE'))).toBe(false)

    rmSync(bare, { recursive: true })
    const licensed = exportPlugin(extensionsDir, 'expo', downloads, { license: 'mit' }).directory
    const license = readFileSync(join(licensed, 'LICENSE'), 'utf8')
    expect(license).toContain('MIT License')
    expect(license).toContain('me')
  })

  it('refuses to overwrite an earlier export', async () => {
    const { extensionsDir, downloads } = await installed()
    exportPlugin(extensionsDir, 'expo', downloads)
    expect(() => exportPlugin(extensionsDir, 'expo', downloads)).toThrow(/already exists/)
  })

  it('refuses a name that is not installed, or is not a name at all', async () => {
    const { extensionsDir, downloads } = await installed()
    expect(() => exportPlugin(extensionsDir, 'nope', downloads)).toThrow(/no plugin called/)
    expect(() => exportPlugin(extensionsDir, '../expo', downloads)).toThrow(/no plugin called/)
  })

  it('says so when an old install kept no source, instead of exporting bundles', async () => {
    const { extensionsDir, downloads } = await installed()
    rmSync(join(extensionsDir, 'expo', 'src'), { recursive: true })
    expect(() => exportPlugin(extensionsDir, 'expo', downloads)).toThrow(/before Lumanin kept/)
  })

  it('names the original remote so a re-publish is a choice, not an accident', async () => {
    const { extensionsDir, downloads } = await installed()
    writeProvenance(join(extensionsDir, 'expo'), {
      label: 'github.com/o/r',
      remote: 'https://github.com/o/r.git',
      ref: null,
      subdirectory: null,
      commit: 'abc',
      installedAt: 'now'
    })
    expect(exportPlugin(extensionsDir, 'expo', downloads).publishedAt).toBe(
      'https://github.com/o/r.git'
    )
  })
})

describe('resolveDownloadsDir', () => {
  it('reads the XDG downloads dir, expanding $HOME', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'lumanin-xdg-'))
    writeFileSync(
      join(configHome, 'user-dirs.dirs'),
      '# comment\nXDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOWNLOAD_DIR="$HOME/Stuff"\n'
    )
    expect(resolveDownloadsDir(configHome, '/home/u')).toBe('/home/u/Stuff')
  })

  it('falls back to ~/Downloads without the file, or with a relative value', () => {
    const empty = mkdtempSync(join(tmpdir(), 'lumanin-xdg-'))
    expect(resolveDownloadsDir(empty, '/home/u')).toBe('/home/u/Downloads')
    writeFileSync(join(empty, 'user-dirs.dirs'), 'XDG_DOWNLOAD_DIR="relative/nope"\n')
    expect(resolveDownloadsDir(empty, '/home/u')).toBe('/home/u/Downloads')
  })
})
