import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'
import type { ThemeSeed } from '../../shared/theme/derive'
import { mergePalettes, parseAlacritty, parseOmarchyColors } from '../../shared/theme/omarchy'
import { parseThemePack } from '../../shared/theme/pack'
import { THEME_FILE_BASENAME } from '../../shared/identity'
import type { AppearanceBackend, AppearanceSignal } from './index'

/**
 * Omarchy as an appearance source — the flagship integration in THEMING.md §2.
 *
 * **The layout on disk, verified against `omarchy-theme-set` on 2026-08-08.**
 * THEMING.md originally described a symlink at `~/.config/omarchy/current/theme`
 * and derivation from `alacritty.toml`; neither is true of current Omarchy, and
 * both mattered:
 *
 *  - `omarchy-theme-set` assembles the new theme in `current/next-theme`, then
 *    does `rm -rf current/theme && mv current/next-theme current/theme`, then
 *    writes `current/theme.name`. So `theme` is a **real directory that gets
 *    replaced**, and a watch on it dies the first time the user switches themes.
 *    The watch therefore sits on the *parent*, `current/`, which survives — and
 *    `theme.name` being written last makes it the ideal trigger: when it changes,
 *    the swap is already complete.
 *  - The palette lives in **`colors.toml`**. `omarchy-theme-set` guarantees one
 *    exists, generating it from `alacritty.toml` when a theme ships only that.
 *    No stock theme ships an `alacritty.toml` any more.
 *
 * Priority within a theme directory: a `lumanin.toml` the theme author wrote
 * beats anything we would infer. That file is the zero-config adoption path
 * THEMING.md promises third-party theme authors, so it has to actually win.
 */

/** Debounce for the watch. A theme swap touches several files in quick succession. */
const COALESCE_MS = 120

export function omarchyRoot(configHome: string): string {
  // Omarchy itself hardcodes `$HOME/.config/omarchy`, so in practice this is
  // always that — but deriving it from the resolved config home keeps CONFIG.md's
  // "never hardcode ~/.config" rule intact and makes the tests drivable.
  return join(configHome, 'omarchy')
}

export interface OmarchyTheme {
  readonly seed: ThemeSeed
  readonly name: string
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Read the currently-applied Omarchy theme, or `null` if there is not one.
 *
 * Exported for the tests and for `doctor`, which needs to explain *why* a theme
 * did not apply without starting a daemon.
 */
export function readOmarchyTheme(root: string): OmarchyTheme | null {
  const current = join(root, 'current')
  const themeDir = join(current, 'theme')
  if (!existsSync(themeDir)) return null

  const name = readIfPresent(join(current, 'theme.name'))?.trim() || basename(themeDir)
  const id = `omarchy:${name}`
  // The marker file is authoritative where it exists; luminance inference in
  // `resolveTheme()` covers third-party themes that omit it.
  const variant = existsSync(join(themeDir, 'light.mode')) ? ('light' as const) : undefined

  const native = readIfPresent(join(themeDir, THEME_FILE_BASENAME))
  if (native !== null) {
    const pack = parseThemePack(native, id)
    if (pack !== null) {
      return {
        seed: {
          ...pack,
          // The author's own `variant` wins; `light.mode` fills in when they were
          // silent about it.
          meta: { ...pack.meta, ...(pack.meta.variant === undefined && variant !== undefined ? { variant } : {}) }
        },
        name
      }
    }
  }

  const colours = readIfPresent(join(themeDir, 'colors.toml'))
  const alacritty = readIfPresent(join(themeDir, 'alacritty.toml'))

  const palette = mergePalettes(
    colours === null ? null : parseOmarchyColors(colours),
    alacritty === null ? null : parseAlacritty(alacritty)
  )
  if (palette === null) return null

  return {
    seed: {
      meta: { name, id, author: 'Omarchy theme', ...(variant !== undefined ? { variant } : {}) },
      colours: palette.colours,
      ...(palette.ansi !== undefined ? { ansi: palette.ansi } : {}),
      ...(palette.ui !== undefined ? { ui: palette.ui } : {})
    },
    name
  }
}

export class OmarchyAppearance implements AppearanceBackend {
  readonly id = 'omarchy'
  private readonly root: string

  constructor(configHome: string) {
    this.root = omarchyRoot(configHome)
  }

  read(): Promise<AppearanceSignal | null> {
    const theme = readOmarchyTheme(this.root)
    if (theme === null) return Promise.resolve(null)
    return Promise.resolve({ seed: theme.seed, source: `Omarchy theme "${theme.name}"` })
  }

  watch(onChange: () => void): () => void {
    const current = join(this.root, 'current')
    let timer: ReturnType<typeof setTimeout> | null = null
    let parent: FSWatcher | null = null
    let inner: FSWatcher | null = null
    let disposed = false

    const fire = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        // Re-arm before reporting: the inner watch is on a directory that the
        // theme swap deleted, so by now it is watching an inode nobody will ever
        // write to again.
        armInner()
        if (!disposed) onChange()
      }, COALESCE_MS)
    }

    const armInner = (): void => {
      inner?.close()
      inner = null
      if (disposed) return
      try {
        // Best-effort and separate from the parent watch: this one exists only so
        // a theme author editing `colors.toml` in place sees it live. Losing it is
        // not a failure — the parent watch still catches every real theme switch.
        inner = watch(join(current, 'theme'), { persistent: false }, fire)
        inner.on('error', () => undefined)
      } catch {
        inner = null
      }
    }

    try {
      parent = watch(current, { persistent: false }, fire)
      parent.on('error', () => undefined)
    } catch {
      // No Omarchy directory to watch. The probe already reported that; a backend
      // must not throw at call time.
      return () => undefined
    }
    armInner()

    return () => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      parent?.close()
      inner?.close()
    }
  }
}
