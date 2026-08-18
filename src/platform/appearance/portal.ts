import { spawnLines, type Exec, type LineStream } from '../exec'
import type { AppearanceBackend, AppearanceSignal } from './index'

/**
 * `org.freedesktop.portal.Settings` — the desktop-agnostic appearance signal.
 *
 * This is the one that covers everything: KDE, GNOME, COSMIC, niri with a
 * portal, and anything else that ships one. It does not hand over a palette, only
 * a preference — `color-scheme` (0 no preference / 1 prefer dark / 2 prefer
 * light) and, on GNOME 47+ and Plasma 6, an `accent-color`. That selects and
 * tints one of our built-in bases rather than producing a theme of its own.
 *
 * Shelling out to `gdbus` rather than taking a D-Bus client dependency is the
 * call `probe/dbus.ts` already made, for the same reason: a native binding is
 * another native module to rebuild against Electron's ABI, and this runs twice a
 * session plus one long-lived monitor.
 *
 * **Both the read and the change signal were verified live** (on
 * Hyprland with `xdg-desktop-portal-gtk`, where this backend loses to Omarchy but
 * still answers). `ReadOne color-scheme` returns `(<uint32 1>,)`; `ReadOne
 * accent-color` returns `org.freedesktop.portal.Error.NotFound` when the desktop
 * has no accent, which is a normal answer and not an error worth logging. The
 * monitor emits:
 *
 * ```
 * /org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged \
 *   ('org.freedesktop.appearance', 'color-scheme', <uint32 2>)
 * ```
 *
 * — and, on GNOME's portal, a second line for the `org.gnome.desktop.interface`
 * namespace carrying the same change. Filtering on `org.freedesktop.appearance`
 * is what keeps one user action from causing two repaints.
 */

const PORTAL_DEST = 'org.freedesktop.portal.Desktop'
const PORTAL_PATH = '/org/freedesktop/portal/desktop'
const NAMESPACE = 'org.freedesktop.appearance'

/**
 * Pull the first `uint32` out of a GVariant literal. Matching on the type tag
 * rather than parsing GVariant properly, because the shape differs between
 * `ReadOne` and the older `Read` and the tag does not.
 */
function readUint32(output: string): number | null {
  const match = /uint32\s+(\d+)/.exec(output)
  return match === null ? null : Number(match[1])
}

/**
 * `accent-color` is `(ddd)` — three doubles in 0..1, **not** bytes. Reading them
 * as 0-255 would make every accent a shade of black.
 */
function readAccent(output: string): string | null {
  const match = /\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/.exec(output)
  if (match === null) return null

  const channels = match.slice(1, 4).map(Number)
  if (channels.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) return null

  return `#${channels.map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`
}

export interface PortalDeps {
  readonly exec: Exec
  readonly gdbus: string | null
  /**
   * The built-in base this desktop should land on when the portal only gives a
   * preference. Decided by the caller, which is the only place allowed to know
   * desktop names.
   */
  readonly preferBase?: string
}

export class PortalAppearance implements AppearanceBackend {
  readonly id = 'portal-settings'
  private monitor: LineStream | null = null
  private onChange: (() => void) | null = null

  constructor(private readonly deps: PortalDeps) {}

  /**
   * Start the monitor the first time this backend is actually asked something.
   *
   * `watch()` cannot start it, because every usable source is watched but only
   * the ones above the winning palette are ever *read* — on Omarchy or KDE the
   * chain short-circuits long before it reaches the portal, and eagerly
   * subscribing would leave a `gdbus monitor` running for the life of the daemon
   * on machines whose appearance it will never decide.
   *
   * Waiting until a read reaches us means the process exists exactly where the
   * portal is the thing answering the question, which is also the only place its
   * change signal could tell us anything new.
   */
  private ensureMonitor(): void {
    const { gdbus } = this.deps
    if (this.onChange === null || this.monitor !== null || gdbus === null) return

    const notify = this.onChange
    this.monitor = spawnLines(
      gdbus,
      ['monitor', '--session', '--dest', PORTAL_DEST, '--object-path', PORTAL_PATH],
      (line) => {
        if (!line.includes('SettingChanged')) return
        // GNOME's portal emits the same change twice, once per namespace.
        // Ours is the standard one; taking both repaints twice for
        // one click.
        if (!line.includes(NAMESPACE)) return
        notify()
      }
    )
  }

  private async readKey(key: string): Promise<string | null> {
    const { gdbus } = this.deps
    if (gdbus === null) return null

    // `ReadOne` is current; `Read` is the deprecated method older portals still
    // ship. Trying the modern one first avoids a deprecation warning on every
    // desktop that has moved on.
    for (const method of ['ReadOne', 'Read'] as const) {
      const result = await this.deps.exec.run(gdbus, [
        'call',
        '--session',
        '--dest',
        PORTAL_DEST,
        '--object-path',
        PORTAL_PATH,
        '--method',
        `org.freedesktop.portal.Settings.${method}`,
        NAMESPACE,
        key
      ])
      if (result.ok) return result.stdout
      // A key the desktop does not implement is a settled answer, not a reason
      // to retry with the other method.
      if (result.stderr.includes('NotFound')) return null
    }
    return null
  }

  async read(): Promise<AppearanceSignal | null> {
    this.ensureMonitor()

    const [scheme, accent] = await Promise.all([
      this.readKey('color-scheme'),
      this.readKey('accent-color')
    ])

    const signal: { variant?: 'dark' | 'light'; accent?: string; preferBase?: string; source: string } = {
      source: 'XDG portal appearance settings'
    }

    const preference = scheme === null ? null : readUint32(scheme)
    // 0 is "no preference", which is not "dark". Leaving `variant` unset lets the
    // chain fall through to our default rather than asserting a choice the
    // desktop explicitly declined to make.
    if (preference === 1) signal.variant = 'dark'
    if (preference === 2) signal.variant = 'light'

    const colour = accent === null ? null : readAccent(accent)
    if (colour !== null) signal.accent = colour
    if (this.deps.preferBase !== undefined) signal.preferBase = this.deps.preferBase

    return signal.variant === undefined && signal.accent === undefined ? null : signal
  }

  watch(onChange: () => void): () => void {
    if (this.deps.gdbus === null) return () => undefined
    this.onChange = onChange

    return () => {
      this.onChange = null
      this.monitor?.stop()
      this.monitor = null
    }
  }
}
