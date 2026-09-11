import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { parseGtkCss, type GtkPalette } from '../../shared/theme/gtkcss'
import type { Exec } from '../exec'
import type { AppearanceBackend, AppearanceSignal } from './index'

/**
 * GTK and libadwaita stylesheets — how GNOME theming is actually expressed.
 *
 * Two places are read, in order of how specific they are to *this user*:
 *
 *  1. `$XDG_CONFIG_HOME/gtk-4.0/gtk.css` and `gtk-3.0/gtk.css` — user overrides.
 *     This is where a hand-set accent lands, and where recolouring tools write.
 *  2. The selected theme's own stylesheet, found from `gtk-theme` in gsettings and
 *     looked up through the standard theme path. Covers Nord, Dracula, Catppuccin
 *     and the rest of the third-party GTK themes, most of which do state their
 *     palette as `@define-color`.
 *
 * The richer file wins, not the earlier one: a user override that sets a single
 * accent should tint their theme, not replace it with one colour and a pile of
 * derivations.
 *
 * **`@import` is not followed** — see `shared/theme/gtkcss.ts` for why. A theme
 * that hides its palette behind imports yields nothing here and the chain moves
 * on to the portal, which is the honest outcome rather than a half-read theme.
 *
 * **UNVERIFIED**: unit-tested against real Adwaita and GTK3 stylesheet text, but
 * never run in a GNOME session.
 */

const THEME_DIRS = (home: string, dataHome: string): readonly string[] => [
  join(home, '.themes'),
  join(dataHome, 'themes'),
  '/usr/share/themes',
  '/usr/local/share/themes'
]

export interface GtkDeps {
  readonly exec: Exec
  readonly configHome: string
  readonly home: string
  readonly dataHome: string
  readonly gsettings: string | null
}

export class GtkAppearance implements AppearanceBackend {
  readonly id = 'gtk-css'

  constructor(private readonly deps: GtkDeps) {}

  private async themeCss(): Promise<string[]> {
    if (this.deps.gsettings === null) return []

    const result = await this.deps.exec.run(this.deps.gsettings, [
      'get',
      'org.gnome.desktop.interface',
      'gtk-theme'
    ])
    if (!result.ok) return []

    const name = result.stdout.trim().replace(/^'|'$/g, '')
    // Adwaita has no stylesheet on disk — it is compiled into libadwaita — so
    // looking for one is guaranteed to fail and the portal handles it instead.
    if (name.length === 0 || name === 'Adwaita' || name.includes('/')) return []

    const found: string[] = []
    for (const dir of THEME_DIRS(this.deps.home, this.deps.dataHome)) {
      for (const version of ['gtk-4.0', 'gtk-3.0']) {
        const path = join(dir, name, version, 'gtk.css')
        if (existsSync(path)) found.push(path)
      }
    }
    return found
  }

  /**
   * Recomputed per read rather than taken from the probe's snapshot: a user who
   * creates `gtk.css` for the first time gets it applied on the next change,
   * instead of having to restart the daemon that decided at startup the file did
   * not exist.
   */
  private userCss(): string[] {
    return [
      join(this.deps.configHome, 'gtk-4.0', 'gtk.css'),
      join(this.deps.configHome, 'gtk-3.0', 'gtk.css')
    ].filter((path) => existsSync(path))
  }

  async read(): Promise<AppearanceSignal | null> {
    const candidates = [...this.userCss(), ...(await this.themeCss())]

    let best: { palette: GtkPalette; path: string } | null = null
    for (const path of candidates) {
      let css: string
      try {
        css = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      const palette = parseGtkCss(css)
      // Strictly greater, so an equally-rich user override still wins on ties by
      // virtue of coming first.
      if (palette !== null && (best === null || palette.matched > best.palette.matched)) {
        best = { palette, path }
      }
    }

    if (best === null) return null

    const label = best.path.includes('/themes/')
      ? (best.path.split('/themes/')[1]?.split('/')[0] ?? 'GTK theme')
      : 'GTK overrides'

    return {
      seed: {
        meta: { name: label, id: `gtk:${label}`, author: 'GTK theme' },
        colours: best.palette.colours
      },
      source: `GTK stylesheet (${label})`
    }
  }

  watch(onChange: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null
    const watchers: FSWatcher[] = []

    const fire = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(onChange, 150)
    }

    // The *directories*, not the files: watching a file that does not exist
    // throws, and "the user just wrote their first gtk.css" is precisely the
    // change worth catching.
    //
    // `dconf/user` is the one that is not obvious, and it closes a real gap. When
    // this backend finds a palette the chain stops here, so the portal is never
    // read and its monitor never starts — which would mean a GNOME user with a
    // third-party GTK theme saw nothing at all when they switched light/dark or
    // changed theme, because both of those live in dconf rather than in a file we
    // were watching.
    for (const dir of [
      join(this.deps.configHome, 'gtk-4.0'),
      join(this.deps.configHome, 'gtk-3.0'),
      join(this.deps.configHome, 'dconf')
    ]) {
      try {
        const watcher = watch(dir, { persistent: false }, fire)
        watcher.on('error', () => undefined)
        watchers.push(watcher)
      } catch {
        // Not present. Nothing to watch, nothing to report.
      }
    }

    return () => {
      if (timer !== null) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    }
  }
}
