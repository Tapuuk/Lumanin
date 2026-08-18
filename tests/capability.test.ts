import { describe, expect, it } from 'vitest'
import { BACKENDS } from '../src/platform/backends'
import { CAPABILITIES, selectBackend, type Backend } from '../src/platform/capability'
import { detectPlatform, type PlatformProfile } from '../src/platform/detect'
import { PROBED_BINARIES, type BinaryMap } from '../src/platform/probe/binaries'
import type { DbusProbe } from '../src/platform/probe/dbus'
import type { AppearanceSources } from '../src/platform/probe/appearance'
import type { WaylandProtocols } from '../src/platform/probe/wayland'

/**
 * The dev machine is Arch + Hyprland, so every other desktop exists here only as
 * a synthesised profile. That is exactly why probes are
 * injectable: without it, the KDE/GNOME/X11 branches would have no coverage at
 * all until someone booted a VM.
 */

function binaries(present: readonly string[] = []): BinaryMap {
  const map = {} as Record<string, string | null>
  for (const name of PROBED_BINARIES) map[name] = present.includes(name) ? `/usr/bin/${name}` : null
  return map as BinaryMap
}

const NO_DBUS: DbusProbe = {
  available: 'UNKNOWN',
  names: new Set(),
  portalInterfaces: new Set(),
  hasPortal: 'UNKNOWN',
  hasGlobalShortcuts: 'UNKNOWN',
  hasSettings: 'UNKNOWN',
  hasKWin: 'UNKNOWN',
  hasStatusNotifierWatcher: 'UNKNOWN',
  via: 'none'
}

const NO_PROTOCOLS: WaylandProtocols = {
  hasLayerShell: 'UNKNOWN',
  hasDataControl: 'UNKNOWN',
  hasForeignToplevel: 'UNKNOWN',
  hasVirtualKeyboard: 'UNKNOWN',
  probed: false,
  detail: 'not probed'
}

const NO_APPEARANCE: AppearanceSources = {
  configHome: '/config',
  stateHome: '/state',
  omarchy: { present: false, currentDir: null, themeDir: null, themeName: null },
  kdeglobals: null,
  cosmicMode: null,
  gtkCss: [],
  niriConfig: null
}

function profile(
  env: Readonly<Record<string, string>>,
  overrides: Partial<PlatformProfile> = {}
): PlatformProfile {
  return {
    ...detectPlatform(env),
    binaries: binaries(),
    dbus: NO_DBUS,
    protocols: NO_PROTOCOLS,
    appearance: NO_APPEARANCE,
    ...overrides
  }
}

const HYPRLAND = { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'Hyprland' }
const GNOME = { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' }
const XFCE = { XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'XFCE' }

describe('selectBackend', () => {
  const usable = (id: string, verifiedOn: string[] = []): Backend => ({
    id,
    summary: id,
    verifiedOn,
    probe: () => ({ usable: true, detail: 'fine' })
  })
  const unusable = (id: string): Backend => ({
    id,
    summary: id,
    verifiedOn: [],
    probe: () => ({ usable: false, detail: 'nope' })
  })

  it('picks the first usable backend in priority order', () => {
    const report = selectBackend('paste', [unusable('a'), usable('b'), usable('c')], profile(HYPRLAND))

    expect(report.chosen).toBe('b')
    // Every candidate is still reported: "why not the other one" is the question
    // doctor exists to answer.
    expect(report.candidates.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('reports UNVERIFIED when the backend has not been confirmed on this desktop', () => {
    const report = selectBackend('paste', [usable('x', ['kde/wayland'])], profile(HYPRLAND))
    expect(report.status).toBe('UNVERIFIED')
  })

  it('reports OK only when the current platform is in verifiedOn', () => {
    const report = selectBackend('paste', [usable('x', ['hyprland/wayland'])], profile(HYPRLAND))
    expect(report.status).toBe('OK')
  })

  it('reports DEGRADED for a verified but partial backend', () => {
    const degraded: Backend = {
      id: 'd',
      summary: 'd',
      verifiedOn: ['hyprland/wayland'],
      probe: () => ({ usable: true, degraded: true, detail: 'partial' })
    }
    expect(selectBackend('paste', [degraded], profile(HYPRLAND)).status).toBe('DEGRADED')
  })

  it('skips a backend that probes fine but has no implementation', () => {
    // A chosen id the runtime cannot construct would fail at call time, which is
    // exactly what "works or reports why at probe time" forbids.
    const planned: Backend = { ...usable('portal'), implemented: false }
    const report = selectBackend('paste', [planned, usable('fallback')], profile(HYPRLAND))

    expect(report.chosen).toBe('fallback')
    expect(report.candidates[0]?.status).toBe('PLANNED')
  })

  it('reports PLANNED, not UNSUPPORTED, when only unwritten backends could run', () => {
    // "Your machine cannot do this" and "we have not built it" are different
    // answers, and blaming the machine for our backlog is the dishonest one.
    const planned: Backend = { ...usable('portal'), implemented: false }
    const report = selectBackend('hotkey', [planned, unusable('other')], profile(HYPRLAND))

    expect(report.chosen).toBeNull()
    expect(report.status).toBe('PLANNED')
    expect(report.detail).toContain('portal')
  })

  it('is UNSUPPORTED with reasons when nothing is usable', () => {
    const report = selectBackend('paste', [unusable('a'), unusable('b')], profile(HYPRLAND))

    expect(report.chosen).toBeNull()
    expect(report.status).toBe('UNSUPPORTED')
    // The reason has to name the candidates, or the user learns nothing.
    expect(report.detail).toContain('a')
    expect(report.detail).toContain('b')
  })
})

describe('real backend chains across simulated desktops', () => {
  it('always resolves a paste backend, because falling back to a prompt is one', () => {
    // Never fail silently. With no helper installed the user
    // still gets their text on the clipboard and a "press Ctrl+V" toast.
    for (const env of [HYPRLAND, GNOME, XFCE]) {
      const report = selectBackend('paste', BACKENDS.paste, profile(env))
      expect(report.chosen, JSON.stringify(env)).toBe('copy-and-prompt')
      expect(report.status).not.toBe('UNSUPPORTED')
    }
  })

  it('prefers a real injector once one is installed', () => {
    const withYdotool = profile(GNOME, { binaries: binaries(['ydotool', 'ydotoold']) })
    expect(selectBackend('paste', BACKENDS.paste, withYdotool).chosen).toBe('ydotool')
  })

  it('flags ydotool as degraded when its daemon is missing', () => {
    const noDaemon = profile(GNOME, { binaries: binaries(['ydotool']) })
    const report = selectBackend('paste', BACKENDS.paste, noDaemon)

    expect(report.chosen).toBe('ydotool')
    expect(report.detail).toContain('ydotoold')
  })

  it('never leaves the window without a placement backend', () => {
    for (const env of [HYPRLAND, GNOME, XFCE]) {
      const report = selectBackend('windowPlacement', BACKENDS.windowPlacement, profile(env))
      expect(report.chosen, JSON.stringify(env)).not.toBeNull()
    }
    expect(selectBackend('windowPlacement', BACKENDS.windowPlacement, profile(GNOME)).chosen).toBe(
      'default-placement'
    )
    expect(selectBackend('windowPlacement', BACKENDS.windowPlacement, profile(XFCE)).chosen).toBe(
      'self-center'
    )
  })

  it('falls back to Electron clipboard when wl-clipboard is absent', () => {
    expect(selectBackend('clipboard', BACKENDS.clipboard, profile(HYPRLAND)).chosen).toBe(
      'electron-clipboard'
    )
    const withWlCopy = profile(HYPRLAND, { binaries: binaries(['wl-copy', 'wl-paste']) })
    expect(selectBackend('clipboard', BACKENDS.clipboard, withWlCopy).chosen).toBe('wl-clipboard')
  })

  it('does not select the evdev hotkey backend automatically', () => {
    // It sees every keystroke system-wide and is opt-in only.
    for (const env of [HYPRLAND, GNOME, XFCE]) {
      const report = selectBackend('hotkey', BACKENDS.hotkey, profile(env))
      expect(report.chosen, JSON.stringify(env)).not.toBe('evdev')
    }
  })

  // These two are about the probe verdict rather than the winner: a capability
  // whose first backend needs a Wayland protocol has to tell "we could not ask"
  // apart from "the compositor said no". Asked of `clipboard` since the clipboard
  // *history* capability that used to carry them was cut with its feature.
  const firstUsable = (capability: 'clipboard', p: PlatformProfile): string | undefined =>
    selectBackend(capability, BACKENDS[capability], p).candidates.find((c) => c.usable)?.id

  it('treats an unrunnable probe as "might work", never as absent', () => {
    // UNKNOWN and false are different states. With protocols
    // unprobed, wl-clipboard must still be offered.
    const unprobed = profile(HYPRLAND, { binaries: binaries(['wl-copy', 'wl-paste']) })
    expect(firstUsable('clipboard', unprobed)).toBe('wl-clipboard')
  })

  it('excludes data-control when the compositor genuinely lacks it', () => {
    const noDataControl = profile(HYPRLAND, {
      binaries: binaries(['wl-copy', 'wl-paste']),
      protocols: { ...NO_PROTOCOLS, hasDataControl: false, probed: true }
    })
    expect(firstUsable('clipboard', noDataControl)).toBe('electron-clipboard')
  })

  it('defines a backend chain for every declared capability', () => {
    // The capability list is the contract with src/platform/; a capability with
    // no chain would silently report UNSUPPORTED forever.
    for (const capability of CAPABILITIES) {
      expect(BACKENDS[capability].length, capability).toBeGreaterThan(0)
    }
  })
})
