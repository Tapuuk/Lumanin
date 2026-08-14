import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * `$PATH` probe (PLATFORM-MATRIX §Detection step 5).
 *
 * Resolution is done by walking `$PATH` rather than spawning `which`: this runs
 * for a dozen binaries at daemon start, and a dozen subprocesses is a lot of
 * milliseconds to spend proving that `ydotool` is not installed.
 */

/** The binaries any backend's probe may ask about. */
export const PROBED_BINARIES = [
  'hyprctl',
  'swaymsg',
  'ydotool',
  'ydotoold',
  'wtype',
  'wl-copy',
  'wl-paste',
  'xdotool',
  // The X11 helpers the selection and window backends shell out to. Distros
  // disagree about which clipboard helper is installed, so both are probed and
  // whichever exists is used.
  'xclip',
  'xsel',
  'wmctrl',
  'gtk-launch',
  'gio',
  'xdg-open',
  'fd',
  'plocate',
  'locate',
  'wayland-info',
  'weston-info',
  'busctl',
  'gdbus',
  // Read-only, and only ever for appearance: `org.gnome.desktop.interface`
  // colour-scheme, accent and gtk-theme. Nothing writes settings through it.
  'gsettings',
  // Only ever consulted to decide whether a systemd user unit is worth
  // installing, and to reload it once written. Never used with root.
  'systemctl'
] as const

export type ProbedBinary = (typeof PROBED_BINARIES)[number]

/** Resolved absolute path per binary, or `null` when it is not installed. */
export type BinaryMap = Readonly<Record<ProbedBinary, string | null>>

export function resolveBinary(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  const path = env['PATH']
  if (path === undefined || path.length === 0) return null

  for (const dir of path.split(delimiter)) {
    // A relative $PATH entry is a misconfiguration, and resolving one would make
    // which binary we find depend on the daemon's working directory.
    if (dir.length === 0 || !isAbsolute(dir)) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here, or not executable by us. Keep looking.
    }
  }
  return null
}

export function probeBinaries(
  env: Readonly<Record<string, string | undefined>> = process.env
): BinaryMap {
  const found = {} as Record<ProbedBinary, string | null>
  for (const name of PROBED_BINARIES) found[name] = resolveBinary(name, env)
  return found
}
