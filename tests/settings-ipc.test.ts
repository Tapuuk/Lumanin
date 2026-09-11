import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { SettingsIpc } from '../src/main/settings-ipc'
import { loadConfig } from '../src/shared/config'
import { resolvePaths } from '../src/node/paths'
import type { ThemeService } from '../src/main/theme'
import { Logger } from '../src/node/logger'
import { detectPlatform, type PlatformProfile } from '../src/platform/detect'
import { PROBED_BINARIES, type BinaryMap } from '../src/platform/probe/binaries'
import type { DbusProbe } from '../src/platform/probe/dbus'
import type { WaylandProtocols } from '../src/platform/probe/wayland'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

/**
 * The settings app's write path: a successful save tells the app to push the
 * new state itself, without waiting for the file watcher; a refused one
 * (the file does not parse) tells it nothing.
 */

type Handler = (event: { sender: { id: number } }, method: string, params: unknown) => Promise<unknown>

function fakeProfile(): PlatformProfile {
  const binaries = {} as Record<string, string | null>
  for (const name of PROBED_BINARIES) binaries[name] = null
  return {
    ...detectPlatform({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'Hyprland' }),
    binaries: binaries as BinaryMap,
    dbus: {
      available: 'UNKNOWN',
      names: new Set(),
      portalInterfaces: new Set(),
      hasPortal: 'UNKNOWN',
      hasGlobalShortcuts: 'UNKNOWN',
      hasSettings: 'UNKNOWN',
      hasKWin: 'UNKNOWN',
      hasStatusNotifierWatcher: 'UNKNOWN',
      via: 'none'
    } satisfies DbusProbe,
    protocols: {
      hasLayerShell: 'UNKNOWN',
      hasDataControl: 'UNKNOWN',
      hasForeignToplevel: 'UNKNOWN',
      hasVirtualKeyboard: 'UNKNOWN',
      probed: true,
      detail: 'probed'
    } satisfies WaylandProtocols,
    appearance: {
      configHome: '/config',
      stateHome: '/state',
      omarchy: { present: false, currentDir: null, themeDir: null, themeName: null },
      kdeglobals: null,
      cosmicMode: null,
      gtkCss: [],
      niriConfig: null
    }
  }
}

/** A minimal plugin directory, the shape `scanAllExtensions` reads. */
function bundledPlugin(directory: string, name: string): void {
  const home = join(directory, name)
  mkdirSync(join(home, 'commands'), { recursive: true })
  writeFileSync(
    join(home, 'package.json'),
    JSON.stringify({
      name,
      title: name,
      description: 'x',
      commands: [{ name: 'search', title: 'search', mode: 'view' }]
    })
  )
  writeFileSync(join(home, 'commands', 'search.js'), '')
}

function setUp(options: { readonly profile?: PlatformProfile; readonly bundled?: readonly string[] } = {}): {
  handler: Handler
  onWritten: ReturnType<typeof vi.fn>
  configFile: string
  read: () => string
} {
  const root = mkdtempSync(join(tmpdir(), 'lumanin-settings-ipc-'))
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'run')
  }
  const paths = resolvePaths(env)
  mkdirSync(paths.config, { recursive: true })
  mkdirSync(paths.state, { recursive: true })
  mkdirSync(paths.data, { recursive: true })

  const logger = new Logger('error', [])
  const readFile = (): string | null => {
    try {
      return readFileSync(paths.configFile, 'utf8')
    } catch {
      return null
    }
  }
  const bundledDir = join(root, 'bundled')
  for (const name of options.bundled ?? []) bundledPlugin(bundledDir, name)
  const profile = options.profile
  const onWritten = vi.fn()
  const ipc = new SettingsIpc({
    logger,
    paths,
    bundledDir,
    theme: {} as ThemeService,
    profile: () => (profile === undefined ? Promise.reject(new Error('no profile in this test')) : Promise.resolve(profile)),
    senderId: () => 1,
    send: () => {},
    close: () => {},
    currentConfig: () => loadConfig({ fileContents: readFile(), env: {} }),
    onWritten
  })
  const handle = vi.mocked(ipcMain.handle)
  handle.mockClear()
  ipc.register()
  const registered = handle.mock.calls[0]?.[1] as Handler | undefined
  if (registered === undefined) throw new Error('register() did not install a handler')
  return { handler: registered, onWritten, configFile: paths.configFile, read: () => readFile() ?? '' }
}

const sender = { sender: { id: 1 } }

describe('settings.set', () => {
  it('reports the write once per successful save, changed or not', async () => {
    const { handler, onWritten, configFile } = setUp()

    const first = await handler(sender, 'settings.set', { path: ['general', 'hide_on_blur'], value: false })
    expect(first).toEqual({ ok: true })
    expect(onWritten).toHaveBeenCalledTimes(1)
    expect(readFileSync(configFile, 'utf8')).toContain('hide_on_blur = false')

    // The same value again: nothing changes on disk, the app is still told.
    const again = await handler(sender, 'settings.set', { path: ['general', 'hide_on_blur'], value: false })
    expect(again).toEqual({ ok: true })
    expect(onWritten).toHaveBeenCalledTimes(2)
  })

  it('reports nothing when the file does not parse', async () => {
    const { handler, onWritten, configFile } = setUp()
    writeFileSync(configFile, '[general\n')

    const result = (await handler(sender, 'settings.set', {
      path: ['general', 'hide_on_blur'],
      value: false
    })) as { ok: boolean; detail?: string }
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('does not parse')
    expect(onWritten).not.toHaveBeenCalled()
    expect(readFileSync(configFile, 'utf8')).toBe('[general\n')
  })

  it('reports nothing for a path outside the allow-list', async () => {
    const { handler, onWritten } = setUp()
    const result = await handler(sender, 'settings.set', { path: ['general', 'nope'], value: 1 })
    expect(result).toEqual({ ok: false, detail: 'that setting cannot be written' })
    expect(onWritten).not.toHaveBeenCalled()
  })

  it('writes a boolean, and the default deletes the key', async () => {
    const { handler, read } = setUp()
    await handler(sender, 'settings.set', { path: ['general', 'hide_on_blur'], value: false })
    expect(read()).toContain('hide_on_blur = false')
    await handler(sender, 'settings.set', { path: ['general', 'hide_on_blur'], value: true })
    expect(read()).not.toContain('hide_on_blur')
  })

  it('writes an enum, and the default or null deletes the key', async () => {
    const { handler, read } = setUp()
    await handler(sender, 'settings.set', { path: ['general', 'esc_at_root'], value: 'clear' })
    expect(read()).toContain('esc_at_root = "clear"')
    await handler(sender, 'settings.set', { path: ['general', 'esc_at_root'], value: 'hide' })
    expect(read()).not.toContain('esc_at_root')
    await handler(sender, 'settings.set', { path: ['general', 'esc_at_root'], value: 'clear' })
    await handler(sender, 'settings.set', { path: ['general', 'esc_at_root'], value: null })
    expect(read()).not.toContain('esc_at_root')
  })

  it('writes a number, and the default deletes the key', async () => {
    const { handler, read } = setUp()
    await handler(sender, 'settings.set', { path: ['general', 'width'], value: 620 })
    expect(read()).toContain('width = 620')
    await handler(sender, 'settings.set', { path: ['general', 'width'], value: 760 })
    expect(read()).not.toContain('width')
  })

  it('refuses garbage as the global hotkey and writes a chord', async () => {
    const { handler, onWritten, read } = setUp()
    const refused = (await handler(sender, 'settings.set', { path: ['general', 'hotkey'], value: 'not a key' })) as {
      ok: boolean
      detail?: string
    }
    expect(refused.ok).toBe(false)
    expect(refused.detail).toContain('is not a hotkey')
    expect(onWritten).not.toHaveBeenCalled()

    expect(await handler(sender, 'settings.set', { path: ['general', 'hotkey'], value: 'Super+Space' })).toEqual({
      ok: true
    })
    expect(read()).toContain('hotkey = "Super+Space"')
  })

  it('refuses a pin list holding an invalid key', async () => {
    const { handler, onWritten } = setUp()
    const result = (await handler(sender, 'settings.set', {
      path: ['search', 'pins'],
      value: ['app:firefox', 'nonsense key']
    })) as { ok: boolean; detail?: string }
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('is not a valid pin key')
    expect(onWritten).not.toHaveBeenCalled()
  })
})

describe('settings.setAlias', () => {
  it('refuses a web search: it takes a term, which an alias cannot carry', async () => {
    const { handler, configFile } = setUp()
    const result = (await handler(sender, 'settings.setAlias', {
      alias: 'gg',
      key: 'web:google',
      title: null
    })) as { ok: boolean; detail?: string }
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('Pin it instead')
    expect(existsSync(configFile) ? readFileSync(configFile, 'utf8') : '').not.toContain('[aliases]')
  })

  it('stores an application or command as its bare id', async () => {
    const { handler, read } = setUp()
    await handler(sender, 'settings.setAlias', { alias: 'ff', key: 'app:firefox.desktop', title: null })
    expect(read()).toContain('ff = "firefox.desktop"')
    await handler(sender, 'settings.setAlias', { alias: 'st', key: 'command:settings', title: null })
    expect(read()).toContain('st = "settings"')
  })

  it('keeps the whole key for shell targets and anything inside a plugin', async () => {
    const { handler, read } = setUp()
    await handler(sender, 'settings.setAlias', { alias: 'ls', key: 'shell:ls -la', title: null })
    expect(read()).toContain('ls = "shell:ls -la"')
    await handler(sender, 'settings.setAlias', { alias: 'un', key: 'extension:a/b#cat', title: null })
    expect(read()).toContain('un = "extension:a/b#cat"')
  })

  it('writes an { id, title } table when the target carries a title', async () => {
    const { handler, read } = setUp()
    await handler(sender, 'settings.setAlias', { alias: 'it', key: 'extension:a/b#cat:item', title: 'Item' })
    const written = read()
    expect(written).toContain('[aliases.it]')
    expect(written).toContain('id = "extension:a/b#cat:item"')
    expect(written).toContain('title = "Item"')
  })

  it('deletes the entry for a null key', async () => {
    const { handler, read } = setUp()
    await handler(sender, 'settings.setAlias', { alias: 'ff', key: 'app:firefox.desktop', title: null })
    expect(read()).toContain('ff = ')
    expect(await handler(sender, 'settings.setAlias', { alias: 'ff', key: null, title: null })).toEqual({ ok: true })
    expect(read()).not.toContain('ff = ')
  })

  it('refuses an alias with whitespace in it', async () => {
    const { handler, onWritten } = setUp()
    const result = (await handler(sender, 'settings.setAlias', {
      alias: 'two words',
      key: 'app:firefox.desktop',
      title: null
    })) as { ok: boolean; detail?: string }
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('one short word')
    expect(onWritten).not.toHaveBeenCalled()
  })
})

describe('settings.setPins', () => {
  it('writes a repeated key once, keeping the first position', async () => {
    const { handler, configFile } = setUp()
    const result = await handler(sender, 'settings.setPins', {
      entries: [
        { key: 'command:settings', title: null },
        { key: 'app:firefox', title: null },
        { key: 'command:settings', title: null }
      ]
    })
    expect(result).toEqual({ ok: true })
    const written = readFileSync(configFile, 'utf8')
    expect(written.match(/command:settings/g)?.length).toBe(1)
    expect(written.indexOf('command:settings')).toBeLessThan(written.indexOf('app:firefox'))
  })

  it('preserves the order given', async () => {
    const { handler, read } = setUp()
    await handler(sender, 'settings.setPins', {
      entries: [
        { key: 'app:c.desktop', title: null },
        { key: 'app:a.desktop', title: null },
        { key: 'app:b.desktop', title: null }
      ]
    })
    const written = read()
    const at = (key: string): number => written.indexOf(key)
    expect(at('app:c.desktop')).toBeLessThan(at('app:a.desktop'))
    expect(at('app:a.desktop')).toBeLessThan(at('app:b.desktop'))
  })

  it('answers a malformed request with a refusal, not a rejection', async () => {
    const { handler, onWritten } = setUp()
    await expect(handler(sender, 'settings.setPins', { entries: 'x' })).resolves.toEqual({
      ok: false,
      detail: 'The request was malformed.'
    })
    await expect(handler(sender, 'settings.setPluginEnabled', undefined)).resolves.toEqual({
      ok: false,
      detail: 'The request was malformed.'
    })
    expect(onWritten).not.toHaveBeenCalled()
  })
})

describe('settings.setHotkeys', () => {
  it('refuses two entries on one chord', async () => {
    const { handler, onWritten } = setUp()
    const result = (await handler(sender, 'settings.setHotkeys', {
      entries: [
        { hotkey: 'Super+G', target: 'extension:one/search' },
        { hotkey: 'super g', target: 'extension:two/search' }
      ]
    })) as { ok: boolean; detail?: string }
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/already bound/)
    expect(result.detail).toContain('extension:one/search')
    expect(onWritten).not.toHaveBeenCalled()
  })
})

describe('settings.plugins', () => {
  it('lists a bundled plugin, disables it without deleting, and re-enables by deleting the key', async () => {
    const { handler, read } = setUp({ bundled: ['files'] })
    type Plugin = { name: string; bundled: boolean; enabled: boolean }
    const listed = (await handler(sender, 'settings.plugins', undefined)) as readonly Plugin[]
    expect(listed.map((plugin) => [plugin.name, plugin.bundled, plugin.enabled])).toEqual([['files', true, true]])

    expect(await handler(sender, 'settings.setPluginEnabled', { name: 'files', enabled: false })).toEqual({ ok: true })
    expect(read()).toMatch(/\[extensions\][\s\S]*disabled = \[ ?"files" ?\]/)
    const disabled = (await handler(sender, 'settings.plugins', undefined)) as readonly Plugin[]
    expect(disabled[0]?.enabled).toBe(false)

    expect(await handler(sender, 'settings.setPluginEnabled', { name: 'files', enabled: true })).toEqual({ ok: true })
    expect(read()).not.toContain('disabled')
    const enabled = (await handler(sender, 'settings.plugins', undefined)) as readonly Plugin[]
    expect(enabled[0]?.enabled).toBe(true)
  })
})

describe('settings.planBind', () => {
  it('plans no change to a hand-edited bind when the hotkey is at its default', async () => {
    // The settings path used to assert `explicit` and stamp a hand edit back to
    // Super+R on every plan; it now reads the config layer like the CLI does.
    const { handler, configFile } = setUp({ profile: fakeProfile() })
    const hyprDir = join(dirname(configFile), '..', 'hypr')
    mkdirSync(hyprDir, { recursive: true })
    const conf = join(hyprDir, 'hyprland.conf')
    writeFileSync(conf, 'monitor=,preferred,auto,1\n')
    await handler(sender, 'settings.applyBind', undefined)
    const written = readFileSync(conf, 'utf8')
    const edited = written.replace(/^(bindd = )SUPER, R,/m, '$1SUPER ALT, R,')
    expect(edited).not.toBe(written)
    writeFileSync(conf, edited)

    const plan = (await handler(sender, 'settings.planBind', undefined)) as {
      pending: boolean
      edits: { path: string; state: string }[]
    }
    expect(plan.edits.find((edit) => edit.path.endsWith('hypr/hyprland.conf'))?.state).toBe('up-to-date')
    expect(plan.pending).toBe(false)
  })
})

describe('settings.state', () => {
  it('reports the first run until the wizard finishes', async () => {
    const { handler } = setUp({ profile: fakeProfile() })
    type State = { firstRun: boolean; parseError: string | null }
    expect(((await handler(sender, 'settings.state', undefined)) as State).firstRun).toBe(true)
    await handler(sender, 'settings.finishFirstRun', undefined)
    expect(((await handler(sender, 'settings.state', undefined)) as State).firstRun).toBe(false)
  })

  it('carries the parse error of a broken file', async () => {
    const { handler, configFile } = setUp({ profile: fakeProfile() })
    writeFileSync(configFile, '[general\n')
    const state = (await handler(sender, 'settings.state', undefined)) as { parseError: string | null }
    expect(state.parseError).not.toBeNull()
  })
})
