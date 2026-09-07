import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { run } from '../probe/run'

/**
 * Icon Theme Specification lookup.
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
  /** The filesystem probe, injectable so a test can count and bound the touches. */
  readonly exists?: (path: string) => boolean
  /** The theme the desktop keeps outside a file, injectable for the same reason. */
  readonly gnomeTheme?: () => Promise<string | null>
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
 * The two files are read before the resolver is handed back. The third is a
 * subprocess and answers later, because the first press of the hotkey must not
 * wait behind a program that may not even be installed.
 */
function themeOrder(configured: string | null): readonly string[] {
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
async function configuredGnomeTheme(): Promise<string | null> {
  const result = await run('gsettings', ['get', 'org.gnome.desktop.interface', 'icon-theme'])
  if (!result.ok) return null
  const value = result.stdout.trim().replace(/^'(.*)'$/s, '$1')
  return value.length > 0 ? value : null
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
  /**
   * Reconsider the filesystem, after the set of installed applications moved.
   *
   * A changed set of theme directories invalidates everything. Anything less
   * invalidates only the names that failed: a name that resolved is almost
   * certainly still on disk, and a name that did not is exactly what installing
   * an application changes.
   */
  refresh(): void
}

export function createIconResolver(context: IconContext): IconResolver {
  const exists = context.exists ?? existsSync
  const gnomeTheme = context.gnomeTheme ?? configuredGnomeTheme
  const roots = iconRoots(context)
  // Flat directories from before the theme spec. Still where a surprising number
  // of applications — and most Wine and Steam entries — put their icon.
  const flatRoots = ['/usr/share/pixmaps', join(context.home, '.local', 'share', 'pixmaps')]

  const fromSettingsFile = configuredGtkTheme(context) ?? configuredKdeTheme(context)
  let themes = themeOrder(fromSettingsFile)

  // Resolution is pure filesystem probing and the same names recur across
  // rebuilds, so the answer is worth keeping. Nulls are cached too: a missing
  // icon is the case that costs the most probes.
  const cache = new Map<string, string | null>()
  const groups = new Map<string, readonly (readonly string[])[]>()
  let flat: readonly string[] | null = null
  let topology: string | null = null

  /**
   * The directories a probe may look in, grouped so precedence survives.
   *
   * Two properties make this a pruning rather than a change of behaviour. A
   * directory that does not exist cannot hold a file, so leaving it out cannot
   * change which candidate is found first — and on a real machine it is most of
   * the search space. And the extension loop has to stay *outside* category and
   * layout, which is why this yields groups rather than one flat list: within a
   * single theme, root and size, `apps/x.svg` beats `mimetypes/x.png`, and a
   * flat list would reverse that.
   *
   * Built per category set and on demand, because the application list asks only
   * for `apps` and the five-category file set is the expensive one to build.
   */
  const groupsFor = (categories: readonly IconCategory[]): readonly (readonly string[])[] => {
    const key = categories.join(',')
    const memoized = groups.get(key)
    if (memoized !== undefined) return memoized

    const built: (readonly string[])[] = []
    for (const theme of themes) {
      for (const root of roots) {
        if (!exists(join(root, theme))) continue
        for (const size of SIZE_DIRECTORIES) {
          const directories: string[] = []
          for (const category of categories) {
            // Both layouts in the wild: `<theme>/<size>/apps` (hicolor, Adwaita)
            // and `<theme>/apps/<size>` (Papirus).
            for (const directory of [join(root, theme, size, category), join(root, theme, category, size)]) {
              if (exists(directory)) directories.push(directory)
            }
          }
          if (directories.length > 0) built.push(directories)
        }
      }
    }

    groups.set(key, built)
    return built
  }

  const flatDirectories = (): readonly string[] => {
    flat ??= flatRoots.filter((directory) => exists(directory))
    return flat
  }

  const probe = (icon: string, categories: readonly IconCategory[]): string | null => {
    for (const group of groupsFor(categories)) {
      for (const extension of EXTENSIONS) {
        for (const directory of group) {
          const candidate = join(directory, `${icon}.${extension}`)
          if (exists(candidate)) return candidate
        }
      }
    }

    for (const directory of flatDirectories()) {
      for (const extension of EXTENSIONS) {
        const candidate = join(directory, `${icon}.${extension}`)
        if (exists(candidate)) return candidate
      }
    }

    return null
  }

  /** Which theme and flat directories exist at all — a few dozen probes. */
  const signature = (): string => {
    const present: string[] = []
    for (const theme of themes) {
      for (const root of roots) {
        const directory = join(root, theme)
        if (exists(directory)) present.push(directory)
      }
    }
    for (const directory of flatRoots) {
      if (exists(directory)) present.push(directory)
    }
    return present.join(' ')
  }

  const invalidate = (): void => {
    groups.clear()
    flat = null
    topology = null
    cache.clear()
  }

  if (fromSettingsFile === null) {
    void gnomeTheme()
      .then((theme) => {
        if (theme === null || theme === themes[0]) return
        themes = themeOrder(theme)
        invalidate()
      })
      .catch(() => {
        // An injected reader that rejects means the same as one that answers
        // nothing: the defaults list stands.
      })
  }

  return {
    resolve(icon, categories = APP_CATEGORIES) {
      if (icon === undefined || icon.length === 0) return null

      // An absolute path is already the answer; the spec permits it and Steam,
      // Wine and most AppImages use it.
      if (isAbsolute(icon)) return exists(icon) ? icon : null

      const key = `${categories.join(',')}\u0000${icon}`
      const cached = cache.get(key)
      if (cached !== undefined) return cached

      const found = probe(icon, categories)
      cache.set(key, found)
      return found
    },

    resolveFirst(names, categories = APP_CATEGORIES) {
      for (const name of names) {
        const found = this.resolve(name, categories)
        if (found !== null) return found
      }
      return null
    },

    refresh() {
      const current = signature()
      if (current !== topology) {
        invalidate()
        topology = current
        return
      }
      // The signature only sees theme roots and flat directories, so an
      // application installed into a size directory that did not exist when the
      // groups were built would otherwise be probed against a list that omits
      // it. Rebuilding the groups is bounded; the resolved names keep their
      // cache entries.
      groups.clear()
      flat = null
      for (const [key, value] of cache) {
        if (value === null) cache.delete(key)
      }
    }
  }
}
