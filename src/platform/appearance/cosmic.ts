import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { toHex } from '../../shared/theme/colour'
import type { AppearanceBackend, AppearanceSignal } from './index'

/**
 * COSMIC (System76).
 *
 * COSMIC stores configuration through `cosmic-config`: one **file per key**,
 * under `~/.config/cosmic/<config-id>/v<n>/<key>`, each holding a RON value. The
 * ones that matter here:
 *
 * ```
 * com.system76.CosmicTheme.Mode/v1/is_dark                  true
 * com.system76.CosmicTheme.Dark.Builder/v2/accent           "#3584e4ff"           (older files: v1, (red: …) floats)
 * com.system76.CosmicTheme.Dark.Builder/v2/bg_color         Some("#1e1e1eff")
 * ```
 *
 * Three findings from the cosmic-theme / cosmic-settings sources (re-checked
 * 2026-08-13) shape this file:
 *
 *  - **User colour customisations live under the `.Builder` config ids**
 *    (`ThemeBuilder`), not under `CosmicTheme.Dark` itself — the built theme's
 *    `accent` there is a whole Component struct, and `bg_color` never existed
 *    there at all.
 *  - **`Theme`/`ThemeBuilder` bumped to version 2** (libcosmic 72ddeaa5,
 *    2026-03) and colours now serialise as `"#RRGGBBAA"` hex strings. Old v1
 *    files keep the `(red: …)` float structs; cosmic-config itself falls back
 *    one version on read, and so does this backend. `ThemeMode` is still v1.
 *  - **A key file only exists once the user has changed that key** — the stock
 *    palette is compiled into libcosmic, so a stock session has `is_dark` and
 *    nothing else. (The version *directories* do exist on stock installs;
 *    cosmic-config creates them eagerly.)
 *
 * COSMIC also ships `xdg-desktop-portal-cosmic`, so light/dark and the accent
 * arrive through the portal as well. This backend sits above it because a
 * customised `bg_color` is a real palette and the portal's answer is not.
 *
 * **UNVERIFIED** — written against the sources named above; never run on
 * COSMIC. RON parsing here is a deliberately narrow scrape — a hex string or
 * `red:`/`green:`/`blue:` floats — rather than a real RON parser, because the
 * only thing we want out of these files is a colour.
 */

const DARK_BUILDER = 'com.system76.CosmicTheme.Dark.Builder'
const LIGHT_BUILDER = 'com.system76.CosmicTheme.Light.Builder'
/** Newest first: cosmic-config reads `v2` and falls back one version. */
const BUILDER_VERSIONS = ['v2', 'v1'] as const

/**
 * Both serialisations: v2 writes `"#RRGGBBAA"` (possibly inside `Some(…)`),
 * v1 wrote 0..1 floats — so 255 here would be black everywhere.
 */
export function parseRonColour(text: string): string | null {
  const hex = /#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?/.exec(text)
  if (hex !== null) {
    const value = hex[1] ?? ''
    return `#${value.toLowerCase()}`
  }

  const channel = (name: string): number | null => {
    const match = new RegExp(`\\b${name}\\s*:\\s*(-?[\\d.]+(?:e-?\\d+)?)`, 'i').exec(text)
    if (match === null) return null
    const value = Number(match[1])
    return Number.isFinite(value) ? value : null
  }

  const [r, g, b] = [channel('red'), channel('green'), channel('blue')]
  if (r === null || g === null || b === null) return null
  if ([r, g, b].some((c) => c < 0 || c > 1)) return null

  return toHex({ r: r * 255, g: g * 255, b: b * 255 })
}

export class CosmicAppearance implements AppearanceBackend {
  readonly id = 'cosmic'
  private readonly cosmicRoot: string

  /** @param modeFile the probed path to `CosmicTheme.Mode/v1/is_dark`. */
  constructor(private readonly modeFile: string) {
    // `…/cosmic/com.system76.CosmicTheme.Mode/v1/is_dark` → `…/cosmic`
    this.cosmicRoot = dirname(dirname(dirname(modeFile)))
  }

  private read1(path: string): string | null {
    try {
      return readFileSync(path, 'utf8').trim()
    } catch {
      return null
    }
  }

  read(): Promise<AppearanceSignal | null> {
    const isDark = this.read1(this.modeFile)
    const variant = isDark === 'true' ? ('dark' as const) : isDark === 'false' ? ('light' as const) : undefined
    const builderId = variant === 'light' ? LIGHT_BUILDER : DARK_BUILDER

    // Newest version that has the key wins, the way cosmic-config reads it.
    const key = (name: string): string | null => {
      for (const version of BUILDER_VERSIONS) {
        const value = this.read1(join(this.cosmicRoot, builderId, version, name))
        if (value !== null) return value
      }
      return null
    }

    const bgRaw = key('bg_color')
    const accentRaw = key('accent')
    const bg = bgRaw === null ? null : parseRonColour(bgRaw)
    const accent = accentRaw === null ? null : parseRonColour(accentRaw)

    // A background is a palette; an accent on its own is a preference. Reporting
    // the difference honestly is what lets the chain layer this over the portal
    // instead of having to choose between them.
    if (bg !== null) {
      return Promise.resolve({
        seed: {
          meta: {
            name: 'COSMIC',
            id: `cosmic:${variant ?? 'dark'}`,
            author: 'COSMIC theme',
            ...(variant !== undefined ? { variant } : {})
          },
          colours: {
            bg,
            // COSMIC does not store a text colour separately from its palette;
            // the derivation produces one against this background that clears AA.
            text: variant === 'light' ? '#000000' : '#ffffff',
            ...(accent !== null ? { accent } : {})
          }
        },
        source: 'COSMIC theme'
      })
    }

    if (variant === undefined && accent === null) return Promise.resolve(null)

    return Promise.resolve({
      ...(variant !== undefined ? { variant } : {}),
      ...(accent !== null ? { accent } : {}),
      // Nothing to prefer: COSMIC's own palette is not on disk to be matched, so
      // a preference-only answer lands on our default base rather than an
      // imitation of one we have never seen.
      source: 'COSMIC appearance settings'
    })
  }

  watch(onChange: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null
    const watchers: FSWatcher[] = []

    const fire = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(onChange, 150)
    }

    // Watching the version directories rather than the individual files: a key
    // file that does not exist yet cannot be watched, and "the user just set a
    // custom background for the first time" is precisely the change worth
    // catching. Both versions of both builders, because an update that bumps
    // the version moves where the next write lands.
    for (const dir of [
      dirname(this.modeFile),
      ...[DARK_BUILDER, LIGHT_BUILDER].flatMap((id) =>
        BUILDER_VERSIONS.map((version) => join(this.cosmicRoot, id, version))
      )
    ]) {
      try {
        const watcher = watch(dir, { persistent: false }, fire)
        watcher.on('error', () => undefined)
        watchers.push(watcher)
      } catch {
        // A directory cosmic-config has not created yet. Expected.
      }
    }

    return () => {
      if (timer !== null) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    }
  }
}
