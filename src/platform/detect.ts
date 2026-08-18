import { probeBinaries, type BinaryMap } from './probe/binaries'
import { probeDbus, type DbusProbe, type Tri } from './probe/dbus'
import { probeAppearanceSources, type AppearanceSources, type OmarchyProbe } from './probe/appearance'
import { probeWaylandProtocols, type WaylandProtocols } from './probe/wayland'

/**
 * The only file allowed to know desktop-environment names.
 *
 * Two layers, deliberately separated:
 *  - {@link detectPlatform} is synchronous and reads only the environment. The
 *    window needs a placement decision before anything can be awaited.
 *  - {@link probePlatform} adds the binary, D-Bus and Wayland-protocol findings.
 *    Those cost subprocesses, so they happen once at daemon start and are cached
 *    on the profile.
 *
 * Everything takes an injected environment and injectable probe results:
 * platform probes must be mockable so the whole DE matrix can be tested
 * from Arch + Hyprland.
 */

export type SessionType = 'wayland' | 'x11' | 'unknown'

/**
 * How the panel ends up where it does. Reported by `lumanin doctor` as the
 * `windowPlacement` capability. This is a capability,
 * not a guarantee, and "centered on the focused monitor" is not always available.
 */
export type PlacementMode = 'COMPOSITOR_RULE' | 'SELF' | 'DEFAULT_PLACEMENT'

/** The env-only layer, available synchronously at startup. */
export interface PlatformEnv {
  readonly sessionType: SessionType
  /** `$XDG_CURRENT_DESKTOP`, split on `:` and lowercased. Tiebreakers only. */
  readonly desktops: readonly string[]
  /** True when a compositor we ship window-rule snippets for is running. */
  readonly hasCompositorRuleSupport: boolean
  readonly isHyprland: boolean
  readonly isSway: boolean
  readonly isKde: boolean
  readonly isGnome: boolean
  /**
   * COSMIC (System76's Rust desktop).
   *
   * A first-class target rather than an "unknown compositor": it has its own
   * config-file shortcut mechanism, its own theme store and its own portal, and
   * every one of those needs to be asked for by name. Detected from
   * `XDG_CURRENT_DESKTOP=COSMIC` with `XDG_SESSION_DESKTOP` as the fallback —
   * cosmic-session's `start-cosmic` exports both, and nothing else it exports
   * reaches child processes (`COSMIC_SESSION_SOCK` is scrubbed from everything
   * cosmic-comp spawns; a `COSMIC_SESSION` variable never existed).
   */
  readonly isCosmic: boolean
}

/**
 * The full profile: env hints plus everything the probes found. Startup-static —
 * a re-probe on theme change is unnecessary.
 */
export interface PlatformProfile extends PlatformEnv {
  readonly binaries: BinaryMap
  readonly dbus: DbusProbe
  readonly protocols: WaylandProtocols
  readonly appearance: AppearanceSources
}

export function detectPlatform(env: Readonly<Record<string, string | undefined>> = process.env): PlatformEnv {
  const sessionTypeRaw = (env['XDG_SESSION_TYPE'] ?? '').toLowerCase()
  const sessionType: SessionType =
    sessionTypeRaw === 'wayland' ? 'wayland' : sessionTypeRaw === 'x11' ? 'x11' : 'unknown'

  const desktops = (env['XDG_CURRENT_DESKTOP'] ?? '')
    .split(':')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)

  // Env hints beat the desktop list: a Hyprland session started without
  // XDG_CURRENT_DESKTOP still exports its instance signature.
  const isHyprland = desktops.includes('hyprland') || env['HYPRLAND_INSTANCE_SIGNATURE'] !== undefined
  const isSway = desktops.includes('sway') || env['SWAYSOCK'] !== undefined
  const isKde = desktops.includes('kde') || env['KDE_FULL_SESSION'] !== undefined
  const isGnome = desktops.includes('gnome') || env['GNOME_SHELL_SESSION_MODE'] !== undefined
  const isCosmic =
    desktops.includes('cosmic') || (env['XDG_SESSION_DESKTOP'] ?? '').toLowerCase() === 'cosmic'

  return {
    sessionType,
    desktops,
    // The three we write rules for: Hyprland and sway take a line in a config
    // file, KWin takes a rule in `kwinrulesrc`. COSMIC is deliberately absent —
    // cosmic-comp's only rule mechanism (CosmicSettings.WindowRules) is tiling
    // exceptions, nothing that can float, place or size a window, so claiming
    // this here would report a placement mechanism that does not exist and
    // cannot be installed, which is the opposite of what the capability is for.
    hasCompositorRuleSupport: isHyprland || isSway || isKde,
    isHyprland,
    isSway,
    isKde,
    isGnome,
    isCosmic
  }
}

/**
 * Electron cannot position windows on Wayland at all: `setPosition`, `setBounds`
 * and `center` are unsupported and `getBounds()` returns `{x: 0, y: 0}`. Wayland
 * deliberately forbids clients from reading or setting global screen coordinates.
 *
 * So on Wayland we size the window and the compositor places it — via our rule
 * snippets where a rule mechanism exists, and wherever it likes where none does
 * (GNOME). Only X11 gets to place itself. Do not "fix" this in code.
 */
export function placementMode(profile: PlatformEnv): PlacementMode {
  if (profile.sessionType === 'x11') return 'SELF'
  if (profile.hasCompositorRuleSupport) return 'COMPOSITOR_RULE'
  return 'DEFAULT_PLACEMENT'
}

/**
 * A short human label for logs and `doctor` — and, less obviously, the key that
 * `Backend.verifiedOn` is matched against.
 *
 * That second use is why it cannot just read `desktops[0]`. Detection
 * deliberately accepts env signatures as well as `XDG_CURRENT_DESKTOP`, so a
 * Hyprland session started without that variable is correctly detected as
 * Hyprland — but was labelled `unknown/wayland`, which matches no `verifiedOn`
 * entry and turned every verified backend into a spurious UNVERIFIED. The
 * detected flags have to win here for the same reason they win there.
 */
export function describePlatform(profile: PlatformEnv): string {
  return `${desktopLabel(profile)}/${profile.sessionType}`
}

function desktopLabel(profile: PlatformEnv): string {
  if (profile.isHyprland) return 'hyprland'
  if (profile.isSway) return 'sway'
  if (profile.isKde) return 'kde'
  if (profile.isGnome) return 'gnome'
  if (profile.isCosmic) return 'cosmic'
  return profile.desktops[0] ?? 'unknown'
}

/**
 * Run the probes and return the full profile. Called once at daemon start.
 *
 * A probe that cannot run yields `UNKNOWN`, never `false` — "we could not
 * check" and "it is not there" must stay
 * distinguishable, because backends select differently on each.
 */
export async function probePlatform(
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<PlatformProfile> {
  const base = detectPlatform(env)
  const binaries = probeBinaries(env)

  // Independent probes; there is no reason to pay for them in series.
  const [dbus, protocols] = await Promise.all([
    probeDbus(binaries),
    probeWaylandProtocols(binaries, base.sessionType === 'wayland')
  ])

  return {
    ...base,
    binaries,
    dbus,
    protocols: withKnownGaps(base, protocols),
    appearance: probeAppearanceSources(env)
  }
}

/**
 * Protocols we know are absent even when nothing could enumerate them.
 *
 * `wayland-info` is not installed by default on any target distro, so `UNKNOWN`
 * is the *common* answer, and backends are told to read UNKNOWN as "might work".
 * That is the right default and it is wrong here: mutter has never implemented
 * `wlr-data-control` and has not implemented its `ext-data-control` successor
 * either, and the two capabilities that need it do not degrade gracefully when
 * it turns out to be missing — `wl-paste --watch` silently watches nothing, and
 * `wl-copy` falls back to a popup surface that GNOME may never focus, which its
 * own manual page describes as a hang.
 *
 * So this is not a guess dressed as a probe: it is a documented upstream fact
 * recorded in the one file allowed to know desktop names, with `probed` left
 * false so `doctor` still says the enumeration never ran.
 *
 * Re-checked: nothing merged through mutter 51.beta, and no merge
 * request for either protocol exists — the 2019 upstream wontfix stands.
 */
function withKnownGaps(base: PlatformEnv, protocols: WaylandProtocols): WaylandProtocols {
  if (!base.isGnome || protocols.probed) return protocols
  return {
    ...protocols,
    hasDataControl: false,
    detail: `${protocols.detail}; mutter implements no data-control protocol`
  }
}

/** Treat "we could not check" as permission to try, not as a failure. */
export function maybe(value: Tri): boolean {
  return value !== false
}

export type { AppearanceSources, BinaryMap, DbusProbe, OmarchyProbe, WaylandProtocols, Tri }
