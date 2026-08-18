import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { ThemeSeed } from '../../shared/theme/derive'
import { mergePalettes, parseAlacritty, parseOmarchyColors } from '../../shared/theme/omarchy'
import { parseThemePack } from '../../shared/theme/pack'
import { THEME_FILE_BASENAME } from '../../shared/identity'
import type { AppearanceBackend, AppearanceSignal } from './index'

/**
 * Omarchy as an appearance source — the flagship integration.
 *
 * **The layout on disk, verified against `omarchy-theme-set` and again against
 * Omarchy 4.** Older Omarchy had a
 * symlink at `~/.config/omarchy/current/theme` and derivation from
 * `alacritty.toml`; neither is true of current Omarchy, and both mattered:
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
 *  - Omarchy 4 moved `current/` itself, from `$XDG_CONFIG_HOME/omarchy/` to
 *    `$XDG_STATE_HOME/omarchy/`. The probe finds whichever exists (state first)
 *    and hands the backend that directory; nothing here assumes either.
 *  - Omarchy 4's `colors.toml` carries `mode = "dark" | "light"` (the older
 *    `light.mode` marker file is legacy but still honoured by Omarchy itself, so
 *    both are read here), and names its palette (`red`, `bright_red`, `selection`,
 *    `muted`, …) instead of `color0..15`; `parseOmarchyColors` reads both shapes.
 *
 *  - Omarchy 4's text size is `[font] base-size` in `shell.toml`: the user's
 *    override in `$XDG_CONFIG_HOME/omarchy/shell.toml` (what `omarchy display
 *    text size` writes), else the applied theme's own `shell.toml`, else 12.
 *    The shell scales its every type token by `base-size / 12`, and so do we.
 *
 * Priority within a theme directory: a `lumanin.toml` the theme author wrote
 * beats anything we would infer. That file is the zero-config adoption path
 * promised to third-party theme authors, so it has to actually win.
 */

/** Debounce for the watch. A theme swap touches several files in quick succession. */
const COALESCE_MS = 120

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
export function readOmarchyTheme(current: string): OmarchyTheme | null {
  const themeDir = join(current, 'theme')
  if (!existsSync(themeDir)) return null

  const name = readIfPresent(join(current, 'theme.name'))?.trim() || basename(themeDir)
  const id = `omarchy:${name}`
  const colours = readIfPresent(join(themeDir, 'colors.toml'))
  const parsedColours = colours === null ? null : parseOmarchyColors(colours)
  // Omarchy's own precedence (`omarchy-theme-color`): the `mode` key, then the
  // legacy `light.mode` marker, then background luminance - which is what
  // `resolveTheme()` does for a seed with no variant.
  const variant =
    parsedColours?.variant ?? (existsSync(join(themeDir, 'light.mode')) ? ('light' as const) : undefined)

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

  const alacritty = readIfPresent(join(themeDir, 'alacritty.toml'))

  const palette = mergePalettes(parsedColours, alacritty === null ? null : parseAlacritty(alacritty))
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

/** The shell's default `base-size`; the size every Omarchy type token is relative to. */
export const OMARCHY_SHELL_BASE_PX = 12

/** `[font] base-size` from one `shell.toml`, or `null` if it is absent or unreadable. */
export function readShellBaseSize(text: string): number | null {
  try {
    const file = parseToml(text) as Record<string, unknown>
    const font = file['font']
    if (typeof font !== 'object' || font === null || Array.isArray(font)) return null
    const size = (font as Record<string, unknown>)['base-size']
    const n = typeof size === 'number' ? size : typeof size === 'string' ? Number(size) : NaN
    // Omarchy's own accepted range is 9 to 20; anything wildly outside it is a
    // typo, not a wish, and a launcher zoomed to 0 is not recoverable by mouse.
    return Number.isFinite(n) && n >= 6 && n <= 40 ? n : null
  } catch {
    return null
  }
}

/**
 * The text scale Omarchy is running at: the user's `shell.toml` override first,
 * then the applied theme's own `shell.toml`, then the shell default. Always an
 * answer, because "not scaled" is one.
 */
export function readOmarchyTextScale(current: string, configHome: string): number {
  for (const path of [join(configHome, 'omarchy', 'shell.toml'), join(current, 'theme', 'shell.toml')]) {
    const text = readIfPresent(path)
    if (text === null) continue
    const size = readShellBaseSize(text)
    if (size !== null) return size / OMARCHY_SHELL_BASE_PX
  }
  return 1
}

export class OmarchyAppearance implements AppearanceBackend {
  readonly id = 'omarchy'
  readonly providesTextScale = true as const

  /**
   * @param current Omarchy's `current/` directory, wherever the probe found it.
   * @param configHome `$XDG_CONFIG_HOME`, where the user's `omarchy/shell.toml` lives.
   */
  constructor(
    private readonly current: string,
    private readonly configHome: string
  ) {}

  read(): Promise<AppearanceSignal | null> {
    const theme = readOmarchyTheme(this.current)
    if (theme === null) return Promise.resolve(null)
    return Promise.resolve({
      seed: theme.seed,
      textScale: readOmarchyTextScale(this.current, this.configHome),
      source: `Omarchy theme "${theme.name}"`
    })
  }

  watch(onChange: () => void): () => void {
    const current = this.current
    let timer: ReturnType<typeof setTimeout> | null = null
    let parent: FSWatcher | null = null
    let inner: FSWatcher | null = null
    let shell: FSWatcher | null = null
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

    try {
      // The user's text-size override. `omarchy display text size` rewrites the
      // file in place (write to a temp file, `mv` over it), so the watch is on
      // the directory and filtered by name - a watch on the file itself would
      // follow the old inode into oblivion on the first change.
      shell = watch(join(this.configHome, 'omarchy'), { persistent: false }, (_event, filename) => {
        if (filename === null || filename === undefined || filename.toString() === 'shell.toml') fire()
      })
      shell.on('error', () => undefined)
    } catch {
      shell = null
    }

    return () => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      parent?.close()
      inner?.close()
      shell?.close()
    }
  }
}
