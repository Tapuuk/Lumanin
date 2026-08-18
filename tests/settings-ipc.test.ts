import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { SettingsIpc } from '../src/main/settings-ipc'
import { loadConfig } from '../src/shared/config'
import { resolvePaths } from '../src/node/paths'
import type { ThemeService } from '../src/main/theme'
import { Logger } from '../src/node/logger'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

/**
 * The settings app's write path: a successful save tells the app to push the
 * new state itself, without waiting for the file watcher; a refused one
 * (the file does not parse) tells it nothing.
 */

type Handler = (event: { sender: { id: number } }, method: string, params: unknown) => Promise<unknown>

function setUp(): { handler: Handler; onWritten: ReturnType<typeof vi.fn>; configFile: string } {
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

  const logger = new Logger('error', [])
  const readFile = (): string | null => {
    try {
      return readFileSync(paths.configFile, 'utf8')
    } catch {
      return null
    }
  }
  const onWritten = vi.fn()
  const ipc = new SettingsIpc({
    logger,
    paths,
    bundledDir: join(root, 'bundled'),
    theme: {} as ThemeService,
    profile: () => Promise.reject(new Error('no profile in this test')),
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
  return { handler: registered, onWritten, configFile: paths.configFile }
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
