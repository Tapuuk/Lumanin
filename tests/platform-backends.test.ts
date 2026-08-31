import { describe, expect, it } from 'vitest'
import { BACKENDS } from '../src/platform/backends'
import { CAPABILITIES, selectBackend } from '../src/platform/capability'
import { createClipboard, CLIPBOARD_BACKEND_IDS } from '../src/platform/clipboard/index'
import type { Exec, RunOptions, RunResult } from '../src/platform/exec'
import { createPaste, PASTE_BACKEND_IDS } from '../src/platform/paste/index'
import { createSelection, PlatformNotSupportedError } from '../src/platform/selection/index'
import { createWindows, WINDOWS_BACKEND_IDS } from '../src/platform/windows/index'
import { parseClients } from '../src/platform/windows/backends/hyprctl'
import { parseWmctrl } from '../src/platform/windows/backends/ewmh'
import { parseTree } from '../src/platform/windows/backends/swaymsg'
import { PROBED_BINARIES, type BinaryMap } from '../src/platform/probe/binaries'
import type { PlatformProfile } from '../src/platform/detect'
import { detectPlatform } from '../src/platform/detect'
import type { DbusProbe } from '../src/platform/probe/dbus'
import type { WaylandProtocols } from '../src/platform/probe/wayland'

/**
 * The backend *implementations*. None of ydotool, wtype, xdotool, wmctrl, xclip
 * or a sway session exists on the dev machine, so the only honest way to test
 * these paths is to assert the exact argv each one builds and to parse captured
 * output. `Exec` is an interface for precisely this reason.
 */

interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly options?: RunOptions
}

function recorder(responses: Record<string, Partial<RunResult>> = {}): {
  exec: Exec
  calls: Call[]
} {
  const calls: Call[] = []
  const exec: Exec = {
    run(command, args, options) {
      calls.push({ command, args, ...(options === undefined ? {} : { options }) })
      const canned = responses[command] ?? {}
      return Promise.resolve({ ok: true, stdout: '', stderr: '', ...canned })
    }
  }
  return { exec, calls }
}

const noopClipboard = { readText: () => '', writeText: () => undefined }

function binaries(present: readonly string[] = []): BinaryMap {
  const map = {} as Record<string, string | null>
  for (const name of PROBED_BINARIES) map[name] = present.includes(name) ? `/usr/bin/${name}` : null
  return map as BinaryMap
}

function profile(env: Readonly<Record<string, string>>, present: readonly string[] = []): PlatformProfile {
  return {
    ...detectPlatform(env),
    binaries: binaries(present),
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
      probed: false,
      detail: 'not probed'
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

describe('every selectable backend has an implementation', () => {
  it('constructs whatever selectBackend can choose', () => {
    // The `implemented` flag is only honest if this holds: anything selection can
    // return must be something the runtime can build.
    const { exec } = recorder()
    const build: Record<string, (id: string) => unknown> = {
      clipboard: (id) => createClipboard(id, { exec, systemClipboard: noopClipboard }),
      paste: (id) =>
        createPaste(id, {
          exec,
          clipboard: createClipboard('electron-clipboard', { exec, systemClipboard: noopClipboard })
        }),
      selection: (id) => createSelection(id, { exec, binaries: binaries(['xclip']) }),
      windows: (id) => createWindows(id, exec)
    }

    for (const capability of CAPABILITIES) {
      const builder = build[capability]
      if (builder === undefined) continue
      for (const backend of BACKENDS[capability]) {
        if (backend.implemented === false) continue
        expect(() => builder(backend.id), `${capability}/${backend.id}`).not.toThrow()
      }
    }
  })

  it('lists the same ids the probe chain does', () => {
    const declared = {
      clipboard: CLIPBOARD_BACKEND_IDS,
      paste: PASTE_BACKEND_IDS,
      windows: WINDOWS_BACKEND_IDS
    } as const

    for (const [capability, ids] of Object.entries(declared)) {
      const implemented = BACKENDS[capability as 'paste']
        .filter((b) => b.implemented !== false)
        .map((b) => b.id)
      expect([...ids].sort(), capability).toEqual(implemented.sort())
    }
  })
})

describe('clipboard', () => {
  it('pipes the text to wl-copy instead of putting it in argv', async () => {
    // /proc/<pid>/cmdline is world-readable, and a launcher copies passwords.
    const { exec, calls } = recorder()
    await createClipboard('wl-clipboard', { exec, systemClipboard: noopClipboard }).writeText('hunter2')

    expect(calls[0]?.command).toBe('wl-copy')
    expect(calls[0]?.args.join(' ')).not.toContain('hunter2')
    expect(calls[0]?.options?.stdin).toBe('hunter2')
  })

  it('marks a sensitive copy with --sensitive, secret still on stdin', async () => {
    // wl-clipboard ≥ 2.2: --sensitive adds x-kde-passwordManagerHint to the
    // offer, which is what tells cliphist/Klipper/CopyQ not to record it.
    const { exec, calls } = recorder()
    await createClipboard('wl-clipboard', { exec, systemClipboard: noopClipboard }).writeText(
      'hunter2',
      { sensitive: true }
    )

    expect(calls[0]?.args).toContain('--sensitive')
    expect(calls[0]?.args.join(' ')).not.toContain('hunter2')
    expect(calls[0]?.options?.stdin).toBe('hunter2')
  })

  it('offers a plain copy without the sensitive flag', async () => {
    const { exec, calls } = recorder()
    await createClipboard('wl-clipboard', { exec, systemClipboard: noopClipboard }).writeText('x')

    expect(calls[0]?.args).not.toContain('--sensitive')
  })

  it('reads without the newline wl-paste would otherwise append', async () => {
    const { exec, calls } = recorder({ 'wl-paste': { stdout: 'copied text' } })
    const text = await createClipboard('wl-clipboard', { exec, systemClipboard: noopClipboard }).readText()

    expect(calls[0]?.args).toContain('--no-newline')
    expect(text).toBe('copied text')
  })

  it('treats an empty clipboard as empty, not as an error', async () => {
    // wl-paste exits non-zero with "Nothing is copied" when nothing is.
    const { exec } = recorder({ 'wl-paste': { ok: false, stderr: 'Nothing is copied' } })
    await expect(
      createClipboard('wl-clipboard', { exec, systemClipboard: noopClipboard }).readText()
    ).resolves.toBe('')
  })

  it('reports a failed copy rather than swallowing it', async () => {
    const { exec } = recorder({ 'wl-copy': { ok: false, stderr: 'no seat' } })
    await expect(
      createClipboard('wl-clipboard', { exec, systemClipboard: noopClipboard }).writeText('x')
    ).rejects.toThrow(/no seat/)
  })
})

describe('paste', () => {
  const withClipboard = (responses: Record<string, Partial<RunResult>> = {}) => {
    const { exec, calls } = recorder(responses)
    const clipboard = createClipboard('electron-clipboard', {
      exec,
      systemClipboard: { readText: () => '', writeText: () => undefined }
    })
    return { exec, calls, clipboard }
  }

  it('builds the ydotool keycode sequence with the modifier released last', async () => {
    const { exec, calls, clipboard } = withClipboard()
    const outcome = await createPaste('ydotool', { exec, clipboard }).paste('snippet')

    // 29 = KEY_LEFTCTRL, 47 = KEY_V; releasing ctrl first yields a bare "v".
    expect(calls[0]?.args).toEqual(['key', '29:1', '47:1', '47:0', '29:0'])
    expect(outcome.injected).toBe(true)
  })

  it('clears held modifiers for xdotool', async () => {
    // The user got here by holding a hotkey; XTEST composes with real key state.
    const { exec, calls, clipboard } = withClipboard()
    await createPaste('xdotool', { exec, clipboard }).paste('snippet')

    expect(calls[0]?.args).toEqual(['key', '--clearmodifiers', 'ctrl+v'])
  })

  it('presses and releases the modifier around the key for wtype', async () => {
    const { exec, calls, clipboard } = withClipboard()
    await createPaste('wtype', { exec, clipboard }).paste('snippet')

    expect(calls[0]?.args).toEqual(['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'])
  })

  it('falls back to the prompt when the injector fails, keeping the text', async () => {
    // Never fail silently. The clipboard write already
    // happened, so a dead ydotoold costs the user one Ctrl+V, not their snippet.
    const { exec, clipboard } = withClipboard({ ydotool: { ok: false, stderr: 'no daemon' } })
    const written: string[] = []
    const recording = createClipboard('electron-clipboard', {
      exec,
      systemClipboard: { readText: () => '', writeText: (t) => written.push(t) }
    })

    const outcome = await createPaste('ydotool', { exec, clipboard: recording }).paste('snippet')

    expect(outcome.injected).toBe(false)
    expect(outcome.detail).toContain('Ctrl+V')
    expect(written).toEqual(['snippet'])
    expect(clipboard.id).toBe('electron-clipboard')
  })

  it('always leaves the text on the clipboard, injector or not', async () => {
    const { exec } = recorder()
    const written: string[] = []
    const clipboard = createClipboard('electron-clipboard', {
      exec,
      systemClipboard: { readText: () => '', writeText: (t) => written.push(t) }
    })

    const outcome = await createPaste('copy-and-prompt', { exec, clipboard }).paste('snippet')

    expect(written).toEqual(['snippet'])
    expect(outcome.injected).toBe(false)
  })
})

describe('selection', () => {
  it('reads PRIMARY, not the clipboard', async () => {
    const { exec, calls } = recorder({ 'wl-paste': { stdout: 'highlighted' } })
    const text = await createSelection('wl-primary', { exec, binaries: binaries() }).readText()

    expect(calls[0]?.args).toContain('--primary')
    expect(text).toBe('highlighted')
  })

  it('uses whichever X11 helper is installed', async () => {
    const { exec: withXclip, calls: xclipCalls } = recorder()
    await createSelection('x11-primary', { exec: withXclip, binaries: binaries(['xclip']) }).readText()
    expect(xclipCalls[0]?.command).toBe('xclip')

    const { exec: withXsel, calls: xselCalls } = recorder()
    await createSelection('x11-primary', { exec: withXsel, binaries: binaries(['xsel']) }).readText()
    expect(xselCalls[0]?.command).toBe('xsel')
  })

  it('strips only the trailing newline the X11 helpers add', async () => {
    const { exec } = recorder({ xclip: { stdout: 'first\n\nsecond\n' } })
    await expect(
      createSelection('x11-primary', { exec, binaries: binaries(['xclip']) }).readText()
    ).resolves.toBe('first\n\nsecond')
  })

  it('rejects rather than returning a plausible empty string when unsupported', async () => {
    // An extension can handle a rejection; it cannot detect a fake empty string.
    const { exec } = recorder()
    await expect(createSelection(null, { exec, binaries: binaries() }).readText()).rejects.toBeInstanceOf(
      PlatformNotSupportedError
    )
  })
})

describe('window listing', () => {
  it('reads Hyprland clients, dropping unmapped ones', () => {
    // Captured from `hyprctl -j clients` on the dev machine.
    const windows = parseClients(
      JSON.stringify([
        {
          address: '0x562dd0b99680',
          class: 'firefox',
          title: 'a video — Mozilla Firefox',
          workspace: { id: 5, name: '5' },
          focusHistoryID: 3,
          mapped: true,
          hidden: false
        },
        {
          address: '0x562dd0b2b760',
          class: 'Alacritty',
          title: 'a terminal',
          workspace: { id: 1, name: '1' },
          focusHistoryID: 0,
          mapped: true,
          hidden: false
        },
        { address: '0xdead', class: 'ghost', title: '', mapped: false, hidden: false }
      ])
    )

    expect(windows.map((w) => w.appId)).toEqual(['firefox', 'Alacritty'])
    // focusHistoryID 0 is the focused window, not "no history".
    expect(windows.find((w) => w.focused)?.appId).toBe('Alacritty')
    expect(windows[0]?.workspace).toBe('5')
  })

  it('survives output that is not the JSON it expected', () => {
    expect(parseClients('not json')).toEqual([])
    expect(parseClients('{"clients": []}')).toEqual([])
  })

  it('addresses Hyprland windows by address, never by title', async () => {
    const { exec, calls } = recorder()
    await createWindows('hyprctl', exec).focus('0x562dd0b99680')

    expect(calls[0]?.args).toEqual(['dispatch', 'focuswindow', 'address:0x562dd0b99680'])
  })

  it('walks the sway tree including floating windows', () => {
    const tree = {
      type: 'root',
      nodes: [
        {
          type: 'workspace',
          name: '2',
          nodes: [{ type: 'con', id: 7, name: 'vim', app_id: 'foot', focused: true }],
          floating_nodes: [
            {
              type: 'floating_con',
              id: 9,
              name: 'Calculator',
              window_properties: { class: 'Gnome-calculator' },
              focused: false
            }
          ]
        }
      ]
    }

    const windows = parseTree(JSON.stringify(tree))

    // A floating calculator is exactly what a switcher is used to find.
    expect(windows.map((w) => w.id)).toEqual(['7', '9'])
    expect(windows[1]?.appId).toBe('Gnome-calculator')
    expect(windows.every((w) => w.workspace === '2')).toBe(true)
  })

  it('parses wmctrl output whose titles contain spaces', () => {
    const stdout = [
      '0x02000007  0 Alacritty.Alacritty   archbox Some window title with spaces',
      '0x03000004 -1 conky.Conky           archbox desktop widget',
      ''
    ].join('\n')

    const windows = parseWmctrl(stdout, String(Number.parseInt('0x02000007', 16)))

    expect(windows[0]?.title).toBe('Some window title with spaces')
    expect(windows[0]?.appId).toBe('Alacritty')
    // wmctrl prints hex, xdotool prints decimal; without normalising, focus is
    // silently always false.
    expect(windows[0]?.focused).toBe(true)
    // Desktop -1 means "on every workspace", not workspace number -1.
    expect(windows[1]?.workspace).toBe('all')
  })

  it('answers with an empty list where the compositor hides its windows', async () => {
    const gnome = profile({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' })
    const chosen = selectBackend('windows', BACKENDS.windows, gnome).chosen

    expect(chosen).toBeNull()
    const { exec } = recorder()
    await expect(createWindows(chosen, exec).list()).resolves.toEqual([])
  })
})
