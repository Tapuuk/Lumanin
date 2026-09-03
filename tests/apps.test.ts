import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  localeKeys,
  parseDesktopEntry,
  parseExec,
  parseList,
  unescapeValue
} from '../src/platform/apps/desktop-entry'
import { applicationDirectories, buildAppIndex } from '../src/platform/apps/index'
import { launchEntry, openPath } from '../src/platform/apps/launch'
import { PROBED_BINARIES, type BinaryMap } from '../src/platform/probe/binaries'
import { SearchService, directoryMtimes, sameMtimes } from '../src/main/search'
import { loadConfig } from '../src/shared/config'

/**
 * The root-search dependencies these tests do not exercise. Composition and
 * dispatch have their own suite (`tests/root-search.test.ts`); here the service
 * is only ever asked about applications.
 */
function apps(service: SearchService, query: string): readonly { title: string }[] {
  // The root list is more than applications now — an unmatched query falls back
  // to web searches — and these tests are about the index, so they ask about the
  // index rather than about the list.
  return service.search(query).filter((row) => row.kind === 'app')
}

const APP_ONLY = {
  config: () => loadConfig({ fileContents: '', env: {} }),
  commands: () => [],
  actions: {
    copy: () => undefined,
    openUrl: () => undefined,
    runCommand: () => ({ ok: false, detail: 'no commands in this fixture' }),
    runExtension: () => ({ ok: false, detail: 'no extensions in this fixture' }),
    runExtensionAction: () => ({ ok: false, detail: 'no extensions in this fixture' })
  }
} as const
import { FrecencyStore } from '../src/node/frecency-store'
import type { Logger } from '../src/node/logger'

/**
 * `.desktop` handling. This is where a launcher is quietly wrong: a mis-parsed
 * Exec launches something else, a missed NoDisplay shows twelve entries for one
 * browser, and a mishandled OnlyShowIn lists GNOME's settings panels on Hyprland.
 * All of those read as taste and are actually spec compliance.
 */

const context = {
  desktops: ['hyprland'],
  resolveBinary: (name: string) => (name === 'installed' ? `/usr/bin/${name}` : null)
}

const entry = (body: string): ReturnType<typeof parseDesktopEntry> =>
  parseDesktopEntry(body, 'test.desktop', '/apps/test.desktop', context)

const MINIMAL = '[Desktop Entry]\nType=Application\nName=Thing\nExec=thing\n'

describe('desktop entry values', () => {
  it('unescapes the format\'s own escapes, which are not the shell\'s', () => {
    // `\s` for a space is the one nobody remembers.
    expect(unescapeValue('a\\sb\\nc\\\\d')).toBe('a b\nc\\d')
  })

  it('splits semicolon lists and honours an escaped semicolon', () => {
    expect(parseList('A;B;C;')).toEqual(['A', 'B', 'C'])
    expect(parseList('Two\\;InOne;Other;')).toEqual(['Two;InOne', 'Other'])
  })

  it('orders locale keys most specific first', () => {
    expect(localeKeys('de_DE.UTF-8@euro')).toEqual(['de_DE@euro', 'de_DE', 'de@euro', 'de'])
    expect(localeKeys('C')).toEqual([])
  })

  it('prefers the most specific available translation', () => {
    const result = parseDesktopEntry(
      '[Desktop Entry]\nType=Application\nName=Files\nName[de]=Dateien\nExec=nautilus\n',
      'a.desktop',
      '/a.desktop',
      { ...context, locale: 'de_DE.UTF-8' }
    )
    expect(result.ok && result.entry.name).toBe('Dateien')
  })
})

describe('which entries are shown', () => {
  it('skips Hidden, which means deleted rather than invisible', () => {
    const result = entry(`${MINIMAL}Hidden=true\n`)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe('hidden')
  })

  it('skips NoDisplay — a real app that should not be offered as one', () => {
    expect(!entry(`${MINIMAL}NoDisplay=true\n`).ok).toBe(true)
  })

  it('honours OnlyShowIn and NotShowIn against the running desktop', () => {
    // This is why GNOME's control-centre panels must not appear on Hyprland.
    expect(!entry(`${MINIMAL}OnlyShowIn=GNOME;\n`).ok).toBe(true)
    expect(entry(`${MINIMAL}OnlyShowIn=Hyprland;GNOME;\n`).ok).toBe(true)
    expect(!entry(`${MINIMAL}NotShowIn=Hyprland;\n`).ok).toBe(true)
  })

  it('skips an entry whose TryExec binary is not installed', () => {
    // Typically a package removed without its desktop file.
    expect(!entry(`${MINIMAL}TryExec=missing\n`).ok).toBe(true)
    expect(entry(`${MINIMAL}TryExec=installed\n`).ok).toBe(true)
  })

  it('ignores anything that is not an Application', () => {
    expect(!entry('[Desktop Entry]\nType=Directory\nName=x\n').ok).toBe(true)
  })

  it('reads actions as sub-commands', () => {
    const result = entry(
      `${MINIMAL}Actions=NewWindow;\n[Desktop Action NewWindow]\nName=New Window\nExec=thing --new\n`
    )
    expect(result.ok && result.entry.actions).toEqual([
      { id: 'NewWindow', name: 'New Window', exec: 'thing --new' }
    ])
  })

  it('drops an action whose group is missing rather than inventing one', () => {
    const result = entry(`${MINIMAL}Actions=Ghost;\n`)
    expect(result.ok && result.entry.actions).toEqual([])
  })
})

describe('parseExec', () => {
  it('drops the file and URL field codes', () => {
    expect(parseExec('firefox %u')).toEqual(['firefox'])
    expect(parseExec('gimp %U')).toEqual(['gimp'])
  })

  it('resolves quoting before stripping field codes, not after', () => {
    // Doing it the other way lets a quoted argument containing %f mangle argv.
    expect(parseExec('app "a b" %f')).toEqual(['app', 'a b'])
    expect(parseExec('app "literal %f here"')).toEqual(['app', 'literal  here'])
  })

  it('unescapes only what the spec allows inside quotes', () => {
    expect(parseExec('app "a\\"b"')).toEqual(['app', 'a"b'])
    expect(parseExec('app "cost \\$5"')).toEqual(['app', 'cost $5'])
  })

  it('keeps %% as a literal percent', () => {
    expect(parseExec('app 50%%')).toEqual(['app', '50%'])
  })

  it('keeps flags and arguments that are not field codes', () => {
    expect(parseExec('env GDK_BACKEND=wayland code --unity-launch %F')).toEqual([
      'env',
      'GDK_BACKEND=wayland',
      'code',
      '--unity-launch'
    ])
  })
})

describe('the index', () => {
  function tree(): string {
    const root = mkdtempSync(join(tmpdir(), 'lumanin-apps-'))
    for (const dir of ['home/applications', 'system/applications', 'system/applications/kde']) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    return root
  }

  // Only the temp tree: the real defaults include absolute Flatpak and Snap
  // paths, which would index this machine's actual applications.
  const dirs = (root: string): string[] => [
    join(root, 'home/applications'),
    join(root, 'system/applications')
  ]
  const index = (root: string) =>
    buildAppIndex({ env: {}, home: root, desktops: [], directories: dirs(root) })

  it('lets a user override shadow the system entry instead of listing both', () => {
    // Anyone who has ever customised a launcher entry otherwise sees every app
    // twice. Precedence is by desktop-file ID, not by file path.
    const root = tree()
    writeFileSync(
      join(root, 'system/applications/firefox.desktop'),
      '[Desktop Entry]\nType=Application\nName=Firefox\nExec=firefox\n'
    )
    writeFileSync(
      join(root, 'home/applications/firefox.desktop'),
      '[Desktop Entry]\nType=Application\nName=Firefox Nightly\nExec=firefox-nightly\n'
    )

    const { entries, stats } = index(root)

    expect(entries.map((e) => e.name)).toEqual(['Firefox Nightly'])
    expect(stats.shadowed).toBe(1)
  })

  it('lets a user Hidden=true override remove a system entry', () => {
    // The spec's own uninstall mechanism, and it only works if the user's file
    // is the one that decides.
    const root = tree()
    writeFileSync(
      join(root, 'system/applications/thing.desktop'),
      '[Desktop Entry]\nType=Application\nName=Thing\nExec=thing\n'
    )
    writeFileSync(
      join(root, 'home/applications/thing.desktop'),
      '[Desktop Entry]\nType=Application\nName=Thing\nExec=thing\nHidden=true\n'
    )

    expect(index(root).entries).toEqual([])
  })

  it('builds ids from subdirectories with a dash, per the spec', () => {
    const root = tree()
    writeFileSync(
      join(root, 'system/applications/kde/konsole.desktop'),
      '[Desktop Entry]\nType=Application\nName=Konsole\nExec=konsole\n'
    )

    const { entries } = index(root)
    expect(entries[0]?.id).toBe('kde-konsole.desktop')
  })

  it('looks in the Flatpak and Snap directories, which are outside XDG_DATA_DIRS', () => {
    const dirs = applicationDirectories({ XDG_DATA_DIRS: '/usr/share' }, '/home/u')

    expect(dirs).toContain('/home/u/.local/share/flatpak/exports/share/applications')
    expect(dirs).toContain('/var/lib/flatpak/exports/share/applications')
    expect(dirs).toContain('/var/lib/snapd/desktop/applications')
  })

  it('keeps the first occurrence when a directory is listed twice', () => {
    // XDG_DATA_DIRS repeating $XDG_DATA_HOME is common and must not change
    // precedence.
    const dirs = applicationDirectories(
      { XDG_DATA_HOME: '/home/u/.local/share', XDG_DATA_DIRS: '/home/u/.local/share:/usr/share' },
      '/home/u'
    )
    expect(dirs.filter((d) => d === '/home/u/.local/share/applications')).toHaveLength(1)
    expect(dirs[0]).toBe('/home/u/.local/share/applications')
  })
})

describe('launching', () => {
  function binaries(present: readonly string[]): BinaryMap {
    const map = {} as Record<string, string | null>
    for (const name of PROBED_BINARIES) map[name] = present.includes(name) ? `/usr/bin/${name}` : null
    return map as BinaryMap
  }

  const app = {
    id: 'thing.desktop',
    path: '/apps/thing.desktop',
    name: 'Thing',
    exec: 'thing --flag %U',
    terminal: false,
    categories: [],
    keywords: [],
    actions: []
  }

  function recorder(): { calls: { command: string; args: readonly string[] }[]; spawn: (c: string, a: readonly string[]) => boolean } {
    const calls: { command: string; args: readonly string[] }[] = []
    return { calls, spawn: (command, args) => (calls.push({ command, args }), true) }
  }

  it('prefers gio, so the app is not started as our child', () => {
    // A child inherits our environment, our cgroup and our death: quitting
    // Lumanin would take the user's editor with it.
    const { calls, spawn } = recorder()
    const result = launchEntry(app, {
      binaries: binaries(['gio', 'gtk-launch']),
      env: {},
      resolveBinary: () => null,
      spawnDetached: spawn
    })

    expect(result.method).toBe('gio')
    expect(calls[0]).toEqual({ command: 'gio', args: ['launch', '/apps/thing.desktop'] })
  })

  it('falls back to gtk-launch with the id, not the path', () => {
    const { calls, spawn } = recorder()
    launchEntry(app, {
      binaries: binaries(['gtk-launch']),
      env: {},
      resolveBinary: () => null,
      spawnDetached: spawn
    })

    expect(calls[0]).toEqual({ command: 'gtk-launch', args: ['thing'] })
  })

  it('parses Exec itself when neither helper exists', () => {
    const { calls, spawn } = recorder()
    launchEntry(app, {
      binaries: binaries([]),
      env: {},
      resolveBinary: (name) => (name === 'thing' ? '/usr/bin/thing' : null),
      spawnDetached: spawn
    })

    expect(calls[0]).toEqual({ command: 'thing', args: ['--flag'] })
  })

  it('refuses a .desktop entry whose program has been uninstalled', () => {
    // Not an edge case: uninstalling an application routinely leaves its entry
    // behind. A detached spawn cannot report ENOENT — it arrives a tick later,
    // after we have already said the app started — and an unhandled `error`
    // event took the whole daemon down with it.
    const { calls, spawn } = recorder()
    const result = launchEntry(app, {
      binaries: binaries([]),
      env: {},
      resolveBinary: () => null,
      spawnDetached: spawn
    })

    expect(result.ok).toBe(false)
    expect(result.detail).toContain('stale')
    expect(calls).toEqual([])
  })

  it('wraps a Terminal=true entry in a terminal, with that terminal\'s exec flag', () => {
    // gnome-terminal wants `--` where everything else wants `-e`; the wrong flag
    // silently opens an empty terminal instead of running anything.
    const { calls, spawn } = recorder()
    launchEntry(
      { ...app, exec: 'htop', terminal: true },
      {
        binaries: binaries([]),
        env: {},
        resolveBinary: (name) => (name === 'gnome-terminal' ? '/usr/bin/gnome-terminal' : null),
        spawnDetached: spawn
      }
    )

    expect(calls[0]).toEqual({ command: 'gnome-terminal', args: ['--', 'htop'] })
  })

  it('honours $TERMINAL over the built-in list', () => {
    const { calls, spawn } = recorder()
    launchEntry(
      { ...app, exec: 'htop', terminal: true },
      {
        binaries: binaries([]),
        env: { TERMINAL: '/usr/bin/alacritty' },
        resolveBinary: () => '/usr/bin/xterm',
        spawnDetached: spawn
      }
    )

    expect(calls[0]?.command).toBe('/usr/bin/alacritty')
  })

  it('says so rather than failing silently when no terminal exists', () => {
    const result = launchEntry(
      { ...app, terminal: true },
      { binaries: binaries([]), env: {}, resolveBinary: () => null, spawnDetached: () => true }
    )

    expect(result.ok).toBe(false)
    expect(result.detail).toContain('TERMINAL')
  })
})

describe('keeping the index fresh', () => {
  // Installing an app must not require restarting the daemon — the index is
  // watched, and without that the launcher quietly serves a snapshot
  // taken at login.
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    error: () => undefined
  } as unknown as Logger

  const service = (root: string): SearchService =>
    new SearchService({
      ...APP_ONLY,
      env: {},
      home: root,
      desktops: [],
      binaries: binariesFor([]),
      frecency: new FrecencyStore(root),
      logger,
      directories: [join(root, 'applications')]
    })

  function binariesFor(present: readonly string[]): BinaryMap {
    const map = {} as Record<string, string | null>
    for (const name of PROBED_BINARIES) map[name] = present.includes(name) ? `/usr/bin/${name}` : null
    return map as BinaryMap
  }

  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('picks up an application installed while it is running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lumanin-watch-'))
    mkdirSync(join(root, 'applications'), { recursive: true })

    const search = service(root)
    search.reindex()
    search.watch()
    expect(apps(search, 'zzyzx')).toHaveLength(0)

    writeFileSync(
      join(root, 'applications', 'zzyzx.desktop'),
      '[Desktop Entry]\nType=Application\nName=Zzyzx\nExec=zzyzx\n'
    )

    // The debounce is 750 ms; anything under that would be testing the timer.
    await settle(1400)
    expect(apps(search, 'zzyzx').map((r) => r.title)).toEqual(['Zzyzx'])

    search.dispose()
  })

  it('drops an application that was uninstalled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lumanin-watch-'))
    mkdirSync(join(root, 'applications'), { recursive: true })
    const path = join(root, 'applications', 'gone.desktop')
    writeFileSync(path, '[Desktop Entry]\nType=Application\nName=Gone\nExec=gone\n')

    const search = service(root)
    search.reindex()
    search.watch()
    expect(apps(search, 'gone')).toHaveLength(1)

    rmSync(path)
    await settle(1400)
    expect(apps(search, 'gone')).toHaveLength(0)

    search.dispose()
  })

  it('collapses a burst of writes into one rebuild', async () => {
    // A package transaction writes, renames and chmods many files. Rebuilding
    // per event would mean hundreds of rebuilds for one `pacman -S`.
    const root = mkdtempSync(join(tmpdir(), 'lumanin-watch-'))
    mkdirSync(join(root, 'applications'), { recursive: true })

    let builds = 0
    const counting = {
      info: (msg: string) => {
        if (msg === 'application index built') builds += 1
      },
      warn: () => undefined,
      debug: () => undefined,
      error: () => undefined
    } as unknown as Logger

    const search = new SearchService({
      ...APP_ONLY,
      env: {},
      home: root,
      desktops: [],
      binaries: binariesFor([]),
      frecency: new FrecencyStore(root),
      logger: counting,
      directories: [join(root, 'applications')]
    })
    search.reindex()
    search.watch()
    builds = 0

    for (let i = 0; i < 25; i += 1) {
      writeFileSync(
        join(root, 'applications', `burst-${String(i)}.desktop`),
        `[Desktop Entry]\nType=Application\nName=Burst ${String(i)}\nExec=burst\n`
      )
    }

    await settle(1400)
    expect(builds).toBe(1)
    expect(apps(search, 'burst')).toHaveLength(25)

    search.dispose()
  })

  /**
   * The check that runs when the panel is shown.
   *
   * Fake timers throughout, so a case can wait out the deferral or age the
   * index by a minute without the suite taking a minute. Nothing here calls
   * `watch()`: with no watcher on an existing directory the age fallback is
   * armed, which is what one case needs and the others stay well inside.
   */
  describe('the show-path check', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    /** Counts rebuilds: one that finds the same apps only logs at debug. */
    function countingLogger(): { logger: Logger; builds: () => number } {
      let builds = 0
      const count = (msg: string): void => {
        if (msg === 'application index built' || msg === 'application index rebuilt, unchanged') builds += 1
      }
      const logger = {
        info: count,
        debug: count,
        warn: () => undefined,
        error: () => undefined
      } as unknown as Logger
      return { logger, builds: () => builds }
    }

    function counted(root: string): { search: SearchService; builds: () => number } {
      const { logger: counting, builds } = countingLogger()
      const search = new SearchService({
        ...APP_ONLY,
        env: {},
        home: root,
        desktops: [],
        binaries: binariesFor([]),
        frecency: new FrecencyStore(root),
        logger: counting,
        directories: [join(root, 'applications')]
      })
      return { search, builds }
    }

    it('does no work when nothing under the application directories moved', () => {
      const root = mkdtempSync(join(tmpdir(), 'lumanin-show-'))
      mkdirSync(join(root, 'applications'), { recursive: true })

      const { search, builds } = counted(root)
      search.reindex()
      const after = builds()

      search.refreshIfStale()
      vi.advanceTimersByTime(200)
      search.refreshIfStale()
      vi.advanceTimersByTime(200)

      expect(builds()).toBe(after)
      search.dispose()
    })

    it('builds an index that has never been built', () => {
      const root = mkdtempSync(join(tmpdir(), 'lumanin-show-'))
      mkdirSync(join(root, 'applications'), { recursive: true })

      const { search, builds } = counted(root)
      expect(builds()).toBe(0)

      search.refreshIfStale()
      vi.advanceTimersByTime(200)

      expect(builds()).toBe(1)
      search.dispose()
    })

    it('picks up an application written while no watcher was running', () => {
      const root = mkdtempSync(join(tmpdir(), 'lumanin-show-'))
      mkdirSync(join(root, 'applications'), { recursive: true })

      const { search } = counted(root)
      search.reindex()
      expect(apps(search, 'zzyzx')).toHaveLength(0)

      writeFileSync(
        join(root, 'applications', 'zzyzx.desktop'),
        '[Desktop Entry]\nType=Application\nName=Zzyzx\nExec=zzyzx\n'
      )

      search.refreshIfStale()
      vi.advanceTimersByTime(200)

      expect(apps(search, 'zzyzx').map((r) => r.title)).toEqual(['Zzyzx'])
      search.dispose()
    })

    it('picks up a directory that did not exist when the index was built', () => {
      const root = mkdtempSync(join(tmpdir(), 'lumanin-show-'))

      const { search } = counted(root)
      search.reindex()
      expect(search.indexStats?.directories).toEqual([])

      mkdirSync(join(root, 'applications'), { recursive: true })
      writeFileSync(
        join(root, 'applications', 'later.desktop'),
        '[Desktop Entry]\nType=Application\nName=Later\nExec=later\n'
      )

      search.refreshIfStale()
      vi.advanceTimersByTime(200)

      expect(apps(search, 'later').map((r) => r.title)).toEqual(['Later'])
      search.dispose()
    })

    it('rebuilds an unwatched index on age alone, once it is old enough', () => {
      const root = mkdtempSync(join(tmpdir(), 'lumanin-show-'))
      mkdirSync(join(root, 'applications'), { recursive: true })

      const { search, builds } = counted(root)
      search.reindex()
      const after = builds()

      vi.advanceTimersByTime(30_000)
      search.refreshIfStale()
      vi.advanceTimersByTime(200)
      expect(builds()).toBe(after)

      vi.advanceTimersByTime(31_000)
      search.refreshIfStale()
      vi.advanceTimersByTime(200)
      expect(builds()).toBe(after + 1)

      search.dispose()
    })

    it('never rebuilds on age alone while every directory is watched', () => {
      const root = mkdtempSync(join(tmpdir(), 'lumanin-show-'))
      mkdirSync(join(root, 'applications'), { recursive: true })

      const { search, builds } = counted(root)
      search.reindex()
      search.watch()
      const after = builds()

      vi.advanceTimersByTime(61_000)
      search.refreshIfStale()
      vi.advanceTimersByTime(200)

      expect(builds()).toBe(after)
      search.dispose()
    })

    it('reads a directory that is not there as absent', () => {
      const root = mkdtempSync(join(tmpdir(), 'lumanin-show-'))
      mkdirSync(join(root, 'applications'), { recursive: true })

      const mtimes = directoryMtimes([join(root, 'applications'), join(root, 'nowhere')])

      expect([...mtimes.keys()]).toEqual([join(root, 'applications')])
    })

    it('reads a directory it is not allowed to stat as absent', () => {
      const root = mkdtempSync(join(tmpdir(), 'lumanin-show-'))
      const parent = join(root, 'locked')
      const directory = join(parent, 'applications')
      mkdirSync(directory, { recursive: true })

      // Root can stat through any mode, so there is nothing to observe there.
      if (process.getuid?.() === 0) return

      chmodSync(parent, 0o000)
      try {
        expect([...directoryMtimes([directory]).keys()]).toEqual([])
      } finally {
        chmodSync(parent, 0o700)
      }
    })

    it('calls two directory snapshots different when a key or a time differs', () => {
      const base = new Map([
        ['/a', 1],
        ['/b', 2]
      ])

      expect(sameMtimes(base, new Map(base))).toBe(true)
      expect(sameMtimes(base, new Map([...base, ['/c', 3]]))).toBe(false)
      expect(sameMtimes(base, new Map([['/a', 1]]))).toBe(false)
      expect(
        sameMtimes(
          base,
          new Map([
            ['/a', 1],
            ['/b', 9]
          ])
        )
      ).toBe(false)
    })
  })
})

/**
 * Opening a file, as opposed to launching an application.
 *
 * The bug this exists for: `xdg-open` — which is what Electron's
 * `shell.openPath` runs — decides a file's type on a wlroots desktop by asking
 * `file(1)`, i.e. by sniffing the contents and ignoring the name. A modern
 * `.blend` is zstd-compressed, so it came back `application/zstd`, whose handler
 * is the file manager: pressing Open on a Blender scene opened Nautilus.
 * Reproduced exactly on the reporting machine.
 */
describe('opening a file', () => {
  function binaries(present: readonly string[]): BinaryMap {
    const map: Record<string, string | null> = {}
    for (const name of PROBED_BINARIES) map[name] = present.includes(name) ? `/usr/bin/${name}` : null
    return map as BinaryMap
  }

  it('hands the path to gio, which weighs the filename as a file manager does', async () => {
    const calls: { gio: string; args: readonly string[] }[] = []
    const taken = await openPath('/home/me/scene.blend', {
      binaries: binaries(['gio']),
      runGio: (gio, args) => {
        calls.push({ gio, args })
        return Promise.resolve(true)
      }
    })

    expect(taken).toBe(true)
    // argv array, never a shell string. A path is
    // arbitrary text and this one comes from a plugin's row.
    expect(calls).toEqual([{ gio: '/usr/bin/gio', args: ['open', '/home/me/scene.blend'] }])
  })

  it('declines when gio is not installed, so the caller falls back', async () => {
    expect(await openPath('/home/me/scene.blend', { binaries: binaries([]) })).toBe(false)
  })

  it('declines when gio has no handler for it, so the caller falls back', async () => {
    // `gio open` exits non-zero when nothing claims the type. That is the case
    // `shell.openPath` still exists for.
    const taken = await openPath('/home/me/thing.unknown', {
      binaries: binaries(['gio']),
      runGio: () => Promise.resolve(false)
    })
    expect(taken).toBe(false)
  })
})
