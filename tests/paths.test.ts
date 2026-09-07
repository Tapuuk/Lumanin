import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePaths, resolveRuntimeDir } from '../src/node/paths'

const UID = 1000
const HOME = '/home/tester'

describe('resolvePaths', () => {
  it('uses XDG defaults when no XDG variables are set', () => {
    const paths = resolvePaths({ HOME }, UID)

    expect(paths.config).toBe('/home/tester/.config/lumanin')
    expect(paths.data).toBe('/home/tester/.local/share/lumanin')
    expect(paths.cache).toBe('/home/tester/.cache/lumanin')
    expect(paths.state).toBe('/home/tester/.local/state/lumanin')
  })

  it('honours XDG overrides', () => {
    const paths = resolvePaths(
      { HOME, XDG_CONFIG_HOME: '/etc/xdg-test', XDG_DATA_HOME: '/srv/data' },
      UID
    )

    expect(paths.config).toBe('/etc/xdg-test/lumanin')
    expect(paths.data).toBe('/srv/data/lumanin')
    // Unset variables still fall back independently.
    expect(paths.cache).toBe('/home/tester/.cache/lumanin')
  })

  it('ignores relative XDG values, as the spec requires', () => {
    // A stray `XDG_DATA_HOME=.` must not scatter databases into whatever
    // directory the daemon happened to be started from.
    const paths = resolvePaths({ HOME, XDG_DATA_HOME: '.', XDG_CACHE_HOME: 'relative/path' }, UID)

    expect(paths.data).toBe('/home/tester/.local/share/lumanin')
    expect(paths.cache).toBe('/home/tester/.cache/lumanin')
  })

  it('ignores empty XDG values', () => {
    const paths = resolvePaths({ HOME, XDG_STATE_HOME: '' }, UID)
    expect(paths.state).toBe('/home/tester/.local/state/lumanin')
  })

  it('derives the documented sub-paths', () => {
    const paths = resolvePaths({ HOME, XDG_RUNTIME_DIR: '/run/user/1000' }, UID)

    expect(paths.configFile).toBe('/home/tester/.config/lumanin/config.toml')
    expect(paths.socket).toBe('/run/user/1000/lumanin.sock')
    expect(paths.logDir).toBe('/home/tester/.local/state/lumanin/logs')
    expect(paths.extensionsDir).toBe('/home/tester/.local/share/lumanin/extensions')
  })
})

describe('resolveRuntimeDir', () => {
  it('uses XDG_RUNTIME_DIR when it is absolute', () => {
    expect(resolveRuntimeDir({ XDG_RUNTIME_DIR: '/run/user/1000' }, UID)).toBe('/run/user/1000')
  })

  it('falls back to a uid-scoped temp dir when unset', () => {
    // Absent in bare ssh sessions and some containers. The fallback must be
    // uid-scoped, not a shared /tmp path.
    expect(resolveRuntimeDir({}, UID)).toBe(join(tmpdir(), 'lumanin-1000'))
  })

  it('rejects a relative XDG_RUNTIME_DIR', () => {
    expect(resolveRuntimeDir({ XDG_RUNTIME_DIR: 'run' }, UID)).toBe(join(tmpdir(), 'lumanin-1000'))
  })
})
