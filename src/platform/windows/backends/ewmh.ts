import type { Exec } from '../../exec'
import type { WindowInfo, WindowsBackend } from '../index'

/**
 * EWMH via `wmctrl` (PLATFORM-MATRIX §7 backend 5) — the path that covers every
 * X11 desktop at once: XFCE, MATE, Cinnamon, i3, KDE on X11.
 *
 * The matrix names "EWMH via an x11 module". `wmctrl` reads the same
 * `_NET_CLIENT_LIST` and `_NET_WM_*` properties through one subprocess instead of
 * a native addon, which is the right trade at M1: no build step, no ABI to rebuild
 * against Electron, and the properties are the standard's, not wmctrl's. If the
 * subprocess cost ever shows up in a profile, the addon can replace this without
 * the interface moving.
 *
 * `-x` is what makes the output usable — without it wmctrl prints no class at all,
 * and a switcher that cannot tell you which application a window belongs to is a
 * list of titles.
 *
 * UNVERIFIED: written against wmctrl's documented output. The dev machine is
 * Wayland; the X11 paths need a human in a VM per TESTING.md.
 */
export function createEwmh(exec: Exec): WindowsBackend {
  return {
    id: 'ewmh',

    async list() {
      const listing = await exec.run('wmctrl', ['-l', '-x'])
      if (!listing.ok) return []

      // wmctrl cannot report which window is active, so the id comes from
      // xdotool where it exists. Its absence costs the focused flag and nothing
      // else, so it is not worth failing the whole listing over.
      const active = await exec.run('xdotool', ['getactivewindow'])
      const activeId = active.ok ? normaliseId(active.stdout.trim()) : null

      return parseWmctrl(listing.stdout, activeId)
    },

    async focus(windowId) {
      const result = await exec.run('wmctrl', ['-i', '-a', windowId])
      return result.ok
    }
  }
}

/**
 * wmctrl and xdotool disagree about how to print the same X11 window id — hex
 * with an `0x` prefix versus decimal — so both are normalised before comparison.
 * Leaving that out makes the focused flag silently always false.
 */
function normaliseId(raw: string): string | null {
  const value = raw.startsWith('0x') ? Number.parseInt(raw, 16) : Number.parseInt(raw, 10)
  return Number.isFinite(value) ? String(value) : null
}

/**
 * Parse `wmctrl -l -x`:
 *
 *     0x02000007  0 Alacritty.Alacritty   host   Some window title
 *
 * Five fields — id, desktop, `instance.class`, hostname, title — and only the
 * first four are delimited by whitespace. The title is the rest of the line and
 * routinely contains spaces, so it is taken as the remainder rather than split.
 *
 * Exported for tests: this is the part that can be wrong.
 */
export function parseWmctrl(stdout: string, activeId: string | null): readonly WindowInfo[] {
  const windows: WindowInfo[] = []

  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue

    const match = /^(\S+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s?(.*)$/.exec(line)
    if (match === null) continue

    const [, rawId, desktop, wmClass, , title] = match
    if (rawId === undefined || desktop === undefined || wmClass === undefined) continue

    // Desktop -1 is "sticky / on all workspaces", not workspace number -1.
    const workspace = desktop === '-1' ? 'all' : desktop
    const id = normaliseId(rawId)

    windows.push({
      id: rawId,
      title: title ?? '',
      // `instance.class`; the class half is the application identity.
      appId: wmClass.split('.').pop() ?? wmClass,
      focused: id !== null && id === activeId,
      workspace
    })
  }

  return windows
}
