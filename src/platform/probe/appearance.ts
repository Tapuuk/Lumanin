import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * Where each desktop keeps its colours, and which of those exist here.
 *
 * Filesystem facts rather than environment ones, which is why they live in the
 * probe layer and not in `detect.ts`. The distinction is load-bearing: "Hyprland
 * is running" is not the same question as "Omarchy's theme directory exists"
 * (plenty of Hyprland users never installed it), and "KDE libraries are
 * installed" is not the same as "a Plasma colour scheme is applied" — a GTK-only
 * machine routinely has a `kdeglobals` with no `[Colors:*]` in it at all.
 *
 * Cheap enough to run unconditionally at startup: a handful of `stat`s.
 */

export interface OmarchyProbe {
  readonly present: boolean
  /** The applied theme's directory, or `null`. */
  readonly themeDir: string | null
  /** Contents of `current/theme.name`, or `null` if it has not been written. */
  readonly themeName: string | null
}

export interface AppearanceSources {
  readonly configHome: string
  readonly omarchy: OmarchyProbe
  /** `kdeglobals` **containing an actual colour scheme**, not merely present. */
  readonly kdeglobals: string | null
  /** COSMIC's `is_dark` file; its presence is what identifies a COSMIC session. */
  readonly cosmicMode: string | null
  /** User GTK stylesheets that exist, GTK4 first. */
  readonly gtkCss: readonly string[]
  readonly niriConfig: string | null
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function resolveConfigHome(env: Readonly<Record<string, string | undefined>>): string {
  const home = env['HOME'] ?? homedir()
  const explicit = env['XDG_CONFIG_HOME']
  return explicit !== undefined && explicit.length > 0 && isAbsolute(explicit)
    ? explicit
    : join(home, '.config')
}

function probeOmarchy(configHome: string): OmarchyProbe {
  const current = join(configHome, 'omarchy', 'current')
  const themeDir = join(current, 'theme')
  if (!existsSync(themeDir)) return { present: false, themeDir: null, themeName: null }

  // `theme.name` is written *after* the theme directory is swapped in, so a
  // daemon that started mid-switch can legitimately see one without the other.
  // Not an error, and not a reason to call Omarchy absent.
  const themeName = readIfPresent(join(current, 'theme.name'))?.trim() || null
  return { present: true, themeDir, themeName }
}

function probeKdeGlobals(configHome: string): string | null {
  const path = join(configHome, 'kdeglobals')
  const contents = readIfPresent(path)
  if (contents === null) return null
  // Presence alone means nothing. Qt writes a `kdeglobals` for font and icon
  // settings on machines that have never run Plasma, and treating that as "KDE
  // has a theme for us" would beat the desktop's real source on a GNOME box with
  // one KDE app installed.
  return contents.includes('[Colors:Window]') ? path : null
}

export function probeAppearanceSources(
  env: Readonly<Record<string, string | undefined>> = process.env
): AppearanceSources {
  const configHome = resolveConfigHome(env)

  const cosmicMode = join(configHome, 'cosmic', 'com.system76.CosmicTheme.Mode', 'v1', 'is_dark')

  // niri's own load order: `$NIRI_CONFIG`, then the XDG path, then the system
  // file. Someone running `niri -c` or with `$NIRI_CONFIG` set has a config that
  // is *not* at the XDG path, and reading the XDG one anyway would take an accent
  // from a file their compositor is ignoring.
  const niriCandidates = [
    env['NIRI_CONFIG'],
    join(configHome, 'niri', 'config.kdl'),
    '/etc/niri/config.kdl'
  ].filter((path): path is string => path !== undefined && path.length > 0)

  return {
    configHome,
    omarchy: probeOmarchy(configHome),
    kdeglobals: probeKdeGlobals(configHome),
    cosmicMode: existsSync(cosmicMode) ? cosmicMode : null,
    // GTK4 first: a machine with both is a machine mid-migration, and the GTK4
    // file is the one its current applications read.
    gtkCss: [join(configHome, 'gtk-4.0', 'gtk.css'), join(configHome, 'gtk-3.0', 'gtk.css')].filter(
      (path) => existsSync(path)
    ),
    niriConfig: niriCandidates.find((path) => existsSync(path)) ?? null
  }
}
