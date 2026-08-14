import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/**
 * Icon Theme Specification lookup (PLATFORM-MATRIX §8).
 *
 * A `.desktop` file's `Icon=` is usually a *name*, not a path — `firefox`, not
 * `/usr/share/icons/hicolor/128x128/apps/firefox.png` — and turning one into the
 * other is the spec's whole job. Implemented directly rather than pulled in as a
 * dependency because the useful subset is small and the alternatives all want to
 * do image loading too, which Chromium already does for us.
 *
 * The full spec walks every theme's `index.theme`, resolves `Inherits`, and
 * scores directories by `Size`/`Scale`/`MinSize`/`MaxSize`. That is the right
 * algorithm for a toolkit picking a 16px icon for a menu; here every icon is
 * drawn at one size in one list, so this takes the direct route: try the
 * plausible directories largest-first and take the first hit. Wrong only in the
 * sense that a hand-tuned 22px variant might exist — invisible at the size we
 * draw.
 */

/** Largest first: scaling a big icon down looks better than the reverse. */
const SIZE_DIRECTORIES = [
  'scalable',
  '512x512',
  '256x256',
  '192x192',
  '128x128',
  '96x96',
  '72x72',
  '64x64',
  '48x48',
  '32x32',
  '24x24',
  'symbolic'
] as const

/** SVG first — it is resolution-independent and usually smaller. */
const EXTENSIONS = ['svg', 'png', 'xpm'] as const

export interface IconContext {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
}

/**
 * Roots that contain icon *themes*, in precedence order. The user's own
 * directories come first so a locally installed icon set wins, exactly as with
 * `.desktop` files.
 */
function iconRoots({ env, home }: IconContext): readonly string[] {
  const dataHome = env['XDG_DATA_HOME']
  const userData = dataHome !== undefined && dataHome.startsWith('/') ? dataHome : join(home, '.local', 'share')
  const dataDirs = (env['XDG_DATA_DIRS'] ?? '/usr/local/share:/usr/share')
    .split(':')
    .filter((dir) => dir.startsWith('/'))

  return [
    join(home, '.icons'),
    join(userData, 'icons'),
    ...dataDirs.map((dir) => join(dir, 'icons')),
    join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'icons'),
    '/var/lib/flatpak/exports/share/icons'
  ]
}

/**
 * Theme preference: whatever the desktop is actually set to, then the common
 * sets, then `hicolor` — which the spec designates as the fallback every theme
 * inherits and where most applications install their own icon.
 *
 * Asking the desktop is what makes a file listing look like the file manager
 * next to it: Breeze icons on KDE because Dolphin uses Breeze, Adwaita on GNOME
 * because Files uses Adwaita. The three sources are tried in the order that a
 * machine with more than one of them should be believed —
 *
 *  - `gtk-4.0`/`gtk-3.0` `settings.ini`, which KDE also writes through
 *    kde-gtk-config, so on a KDE session it already says `breeze`;
 *  - `kdeglobals` `[Icons] Theme`, which is where Plasma itself keeps it;
 *  - `gsettings`, because GNOME keeps it in dconf and writes neither file.
 *
 * The gsettings call is the only subprocess here, it runs once per resolver, and
 * it is skipped entirely when either file answered.
 */
function themeOrder(context: IconContext): readonly string[] {
  const configured = configuredGtkTheme(context) ?? configuredKdeTheme(context) ?? configuredGnomeTheme()
  const defaults = ['Papirus', 'Papirus-Dark', 'Adwaita', 'breeze', 'Yaru', 'gnome']
  return [...(configured === null ? [] : [configured]), ...defaults, 'hicolor']
}

/** `[Icons] Theme` from `kdeglobals` — where Plasma keeps the setting. */
function configuredKdeTheme({ env, home }: IconContext): string | null {
  const configHome = env['XDG_CONFIG_HOME']
  const base = configHome !== undefined && configHome.startsWith('/') ? configHome : join(home, '.config')
  try {
    // Scanned line by line rather than with one regex over the whole file: a
    // KConfig section runs until the next `[…]` header, and expressing "until
    // the next header or the end of the file" as a lookahead is where `\Z`
    // creeps in — which in a JavaScript regex is the letter Z, not the end of
    // anything, so the pattern silently matches nothing.
    let inside = false
    for (const line of readFileSync(join(base, 'kdeglobals'), 'utf8').split('\n')) {
      const header = /^\s*\[(.+)\]\s*$/.exec(line)
      if (header !== null) {
        inside = header[1] === 'Icons'
        continue
      }
      if (!inside) continue
      const match = /^\s*Theme\s*=\s*(.+?)\s*$/.exec(line)
      if (match?.[1] !== undefined && match[1].length > 0) return match[1]
    }
    return null
  } catch {
    return null
  }
}

/**
 * `org.gnome.desktop.interface icon-theme`, which lives in dconf and so cannot
 * be read off disk. Failure of any kind — no gsettings, no schema, a timeout —
 * is "the user did not tell us", which is what the defaults list is for.
 */
function configuredGnomeTheme(): string | null {
  try {
    const result = spawnSync('gsettings', ['get', 'org.gnome.desktop.interface', 'icon-theme'], {
      encoding: 'utf8',
      timeout: 2000
    })
    if (result.status !== 0 || typeof result.stdout !== 'string') return null
    const value = result.stdout.trim().replace(/^'(.*)'$/s, '$1')
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

/** `gtk-icon-theme-name` from the GTK 3/4 settings files, if the user set one. */
function configuredGtkTheme({ env, home }: IconContext): string | null {
  const configHome = env['XDG_CONFIG_HOME']
  const base = configHome !== undefined && configHome.startsWith('/') ? configHome : join(home, '.config')

  for (const file of [join(base, 'gtk-4.0', 'settings.ini'), join(base, 'gtk-3.0', 'settings.ini')]) {
    try {
      const match = /^\s*gtk-icon-theme-name\s*=\s*(.+?)\s*$/m.exec(readFileSync(file, 'utf8'))
      if (match?.[1] !== undefined && match[1].length > 0) return match[1]
    } catch {
      // No settings file is the normal case on a non-GTK desktop.
    }
  }
  return null
}

/**
 * Which of a theme's category directories to look in.
 *
 * An icon theme is not a flat namespace: `firefox` lives under `apps/`,
 * `text-x-python` under `mimetypes/`, `folder` under `places/`. Looking only in
 * `apps/` — which is all this did while its only caller was the application
 * index — finds none of the icons a file listing needs.
 */
export type IconCategory = 'apps' | 'mimetypes' | 'places' | 'devices' | 'status'

const APP_CATEGORIES: readonly IconCategory[] = ['apps']

export interface IconResolver {
  /** Absolute path to an icon file, or `null` when nothing matches the name. */
  resolve(icon: string | undefined, categories?: readonly IconCategory[]): string | null
  /**
   * The first of several names that resolves.
   *
   * File icons are named most-specific-first — `text-x-python`, then
   * `text-x-generic`, then `text-plain` — because a theme is free to ship any
   * subset of them, and "no icon at all" is a worse answer than a generic one.
   */
  resolveFirst(names: readonly string[], categories?: readonly IconCategory[]): string | null
}

export function createIconResolver(context: IconContext): IconResolver {
  const roots = iconRoots(context)
  const themes = themeOrder(context)
  // Flat directories from before the theme spec. Still where a surprising number
  // of applications — and most Wine and Steam entries — put their icon.
  const flat = ['/usr/share/pixmaps', join(context.home, '.local', 'share', 'pixmaps')]

  // Resolution is pure filesystem probing and the same names recur across
  // rebuilds, so the answer is worth keeping. Nulls are cached too: a missing
  // icon is the case that costs the most probes.
  const cache = new Map<string, string | null>()

  return {
    resolve(icon, categories = APP_CATEGORIES) {
      if (icon === undefined || icon.length === 0) return null

      // An absolute path is already the answer; the spec permits it and Steam,
      // Wine and most AppImages use it.
      if (isAbsolute(icon)) return existsSync(icon) ? icon : null

      const key = `${categories.join(',')}\u0000${icon}`
      const cached = cache.get(key)
      if (cached !== undefined) return cached

      const found = probe(icon, roots, themes, flat, categories)
      cache.set(key, found)
      return found
    },

    resolveFirst(names, categories = APP_CATEGORIES) {
      for (const name of names) {
        const found = this.resolve(name, categories)
        if (found !== null) return found
      }
      return null
    }
  }
}

function probe(
  icon: string,
  roots: readonly string[],
  themes: readonly string[],
  flat: readonly string[],
  categories: readonly IconCategory[]
): string | null {
  for (const theme of themes) {
    for (const root of roots) {
      for (const size of SIZE_DIRECTORIES) {
        for (const extension of EXTENSIONS) {
          for (const category of categories) {
            // Both layouts in the wild: `<theme>/<size>/apps` (hicolor, Adwaita)
            // and `<theme>/apps/<size>` (Papirus). Checking both is two stat
            // calls and saves missing every icon in one of the most popular
            // themes.
            const candidates = [
              join(root, theme, size, category, `${icon}.${extension}`),
              join(root, theme, category, size, `${icon}.${extension}`)
            ]
            for (const candidate of candidates) {
              if (existsSync(candidate)) return candidate
            }
          }
        }
      }
    }
  }

  for (const directory of flat) {
    for (const extension of EXTENSIONS) {
      const candidate = join(directory, `${icon}.${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }

  return null
}
