import { describe, expect, it } from 'vitest'
import { describePlatform, detectPlatform, placementMode } from '../src/platform/detect'

/**
 * The dev machine is Arch + Hyprland, so every other desktop is exercised by
 * injecting its environment. CLAUDE.md requires probes to be mockable for exactly
 * this reason — these profiles are the only way KDE/GNOME paths get tested until
 * a human runs the VM checklist in TESTING.md.
 */
const PROFILES = {
  hyprland: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'Hyprland' },
  sway: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'sway' },
  kdeWayland: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' },
  gnomeWayland: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' },
  xfceX11: { XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'XFCE' },
  kdeX11: { XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'KDE' },
  bare: {}
} as const

describe('detectPlatform', () => {
  it('reads session type and normalises the desktop list', () => {
    const profile = detectPlatform(PROFILES.gnomeWayland)

    expect(profile.sessionType).toBe('wayland')
    expect(profile.desktops).toEqual(['ubuntu', 'gnome'])
    expect(profile.isGnome).toBe(true)
  })

  it('reports unknown for an unset or unrecognised session type', () => {
    expect(detectPlatform(PROFILES.bare).sessionType).toBe('unknown')
    expect(detectPlatform({ XDG_SESSION_TYPE: 'tty' }).sessionType).toBe('unknown')
  })

  it('uses env hints when XDG_CURRENT_DESKTOP is missing', () => {
    // A Hyprland session started outside a display manager often has no
    // XDG_CURRENT_DESKTOP but always exports its instance signature.
    const profile = detectPlatform({
      XDG_SESSION_TYPE: 'wayland',
      HYPRLAND_INSTANCE_SIGNATURE: 'abc123'
    })

    expect(profile.isHyprland).toBe(true)
    expect(profile.hasCompositorRuleSupport).toBe(true)
  })

  it('detects sway via SWAYSOCK and KDE via KDE_FULL_SESSION', () => {
    expect(detectPlatform({ SWAYSOCK: '/run/sway.sock' }).isSway).toBe(true)
    expect(detectPlatform({ KDE_FULL_SESSION: 'true' }).isKde).toBe(true)
  })
})

describe('placementMode', () => {
  it('lets the compositor place the window where rules exist', () => {
    for (const env of [PROFILES.hyprland, PROFILES.sway, PROFILES.kdeWayland]) {
      expect(placementMode(detectPlatform(env))).toBe('COMPOSITOR_RULE')
    }
  })

  it('accepts default placement on GNOME Wayland', () => {
    // Electron cannot position windows on Wayland and GNOME exposes no
    // window-rule mechanism. Reporting this honestly is the feature.
    expect(placementMode(detectPlatform(PROFILES.gnomeWayland))).toBe('DEFAULT_PLACEMENT')
  })

  it('accepts default placement on an unknown Wayland compositor', () => {
    expect(placementMode(detectPlatform({ XDG_SESSION_TYPE: 'wayland' }))).toBe('DEFAULT_PLACEMENT')
  })

  it('self-centres on X11 regardless of desktop', () => {
    expect(placementMode(detectPlatform(PROFILES.xfceX11))).toBe('SELF')
    expect(placementMode(detectPlatform(PROFILES.kdeX11))).toBe('SELF')
  })
})

describe('describePlatform', () => {
  it('produces a short label for logs and doctor', () => {
    expect(describePlatform(detectPlatform(PROFILES.hyprland))).toBe('hyprland/wayland')
    expect(describePlatform(detectPlatform(PROFILES.bare))).toBe('unknown/unknown')
  })

  it('labels a desktop detected from an env signature by its real name', () => {
    // The label is also the key `Backend.verifiedOn` matches on, so reading only
    // XDG_CURRENT_DESKTOP here made a signature-detected Hyprland session
    // `unknown/wayland` — matching no verifiedOn entry, and reporting every
    // verified backend as UNVERIFIED.
    const label = describePlatform(
      detectPlatform({ XDG_SESSION_TYPE: 'wayland', HYPRLAND_INSTANCE_SIGNATURE: 'abc123' })
    )

    expect(label).toBe('hyprland/wayland')
  })

  it('keeps the first desktop entry when there is no signature to go on', () => {
    expect(describePlatform(detectPlatform(PROFILES.xfceX11))).toBe('xfce/x11')
  })
})
