import { parse as parseToml } from 'smol-toml'
import type { MutableUi, SeedColours, UiTokens } from './derive'

/**
 * Reading an Omarchy theme's palette.
 *
 * **Verified against Omarchy on 2026-08-08, because the format moved and
 * THEMING.md's original description of it is no longer true.** What is actually
 * on disk today:
 *
 *  - Every theme's applied copy lives in `~/.config/omarchy/current/theme/`, and
 *    `omarchy-theme-set` guarantees a **`colors.toml`** in it: if the theme
 *    itself ships one it is copied, and if it does not, `omarchy-theme-set` runs
 *    `omarchy-theme-colors-from-alacritty` to generate one before the swap. So
 *    `colors.toml` — not `alacritty.toml` — is the reliable source.
 *  - None of the 19 stock themes ships an `alacritty.toml` at all any more. Some
 *    third-party themes still do (and some ship *only* that), which is why the
 *    alacritty reader below stays: it covers a theme installed before the format
 *    changed, and a generator that bailed out because the palette was incomplete.
 *  - `colors.toml` names an `accent` explicitly, which is strictly better than
 *    THEMING.md's "use `colors.normal.blue`" — that rule survives here only as
 *    the fallback the generator itself uses (`accent = color4`).
 *
 * These functions are pure text-in/palette-out so they can be golden-tested
 * against real theme files without touching a filesystem.
 */

export interface OmarchyPalette {
  readonly colours: SeedColours
  /** All 16 slots, or absent — a partial palette is not useful to anyone. */
  readonly ansi?: readonly string[]
  readonly ui?: Partial<UiTokens>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asColour(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // `0x`-prefixed and bare hex both appear in alacritty files; `parseHex`
  // normalises them, so anything hex-shaped is passed through as-is.
  return /^(#|0[xX])?[0-9a-fA-F]{3}$|^(#|0[xX])?[0-9a-fA-F]{6}$/.test(value.trim())
    ? value.trim()
    : undefined
}

function parse(text: string): Record<string, unknown> | null {
  try {
    return asRecord(parseToml(text))
  } catch {
    // A theme with a broken file falls through to the next source in the chain.
    return null
  }
}

/**
 * `colors.toml` — the flat, generated schema:
 *
 * ```toml
 * accent = "#89b4fa"
 * foreground = "#cdd6f4"
 * background = "#1a1b1e"
 * color0 = "#45475a"   # … through color15
 * ```
 *
 * `cursor` and `selection_*` are deliberately not read. They are terminal
 * concerns: a selection background is tuned to be loud against a wall of
 * monospace text (Catppuccin's is a near-white pink), and using it for the
 * selected row would make a launcher shout. The selected row is derived from the
 * accent instead, which is consistent across every theme.
 */
export function parseOmarchyColors(text: string): OmarchyPalette | null {
  const file = parse(text)
  if (file === null) return null

  const bg = asColour(file['background'])
  const text_ = asColour(file['foreground'])
  if (bg === undefined || text_ === undefined) return null

  const colours: SeedColours = { bg, text: text_ }
  const accent = asColour(file['accent'])

  const slots: string[] = []
  for (let i = 0; i < 16; i += 1) {
    const slot = asColour(file[`color${String(i)}`])
    if (slot === undefined) break
    slots.push(slot)
  }

  return {
    colours: accent === undefined ? colours : { ...colours, accent },
    ...(slots.length === 16 ? { ansi: slots } : {})
  }
}

const ALACRITTY_SLOTS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const

/**
 * `alacritty.toml` — the legacy source, kept for third-party themes predating the
 * `colors.toml` switch.
 *
 * Also where a theme's translucency comes from: `[window].opacity` is Omarchy's
 * only expression of "this theme is meant to be see-through" (the `-glass`
 * variants set it), and mapping it onto our Glass exception is what makes a glass
 * Omarchy theme feel like one here. See THEMING.md §"Blur / Glass themes" for why
 * that still renders near-opaque until the compositor actually grants blur.
 */
export function parseAlacritty(text: string): OmarchyPalette | null {
  const file = parse(text)
  if (file === null) return null

  // Alacritty accepts both `[colors.primary]` and a nested `[colors]` table, and
  // smol-toml gives the same shape for either, so one lookup covers both.
  const colours = asRecord(file['colors'])
  const primary = asRecord(colours?.['primary'])
  const normal = asRecord(colours?.['normal'])
  const bright = asRecord(colours?.['bright'])

  const ui: MutableUi = {}
  const opacity = asRecord(file['window'])?.['opacity']
  if (typeof opacity === 'number' && opacity > 0 && opacity < 1) {
    ui.blur = true
    ui.opacity = opacity
  }

  const bg = asColour(primary?.['background'])
  const fg = asColour(primary?.['foreground'])
  if (bg === undefined || fg === undefined) {
    // Opacity alone is still worth returning: a `-glass` theme whose colours live
    // in `colors.toml` keeps its translucency, which is the common case now.
    return Object.keys(ui).length > 0 ? { colours: { bg: '', text: '' }, ui } : null
  }

  const readRow = (row: Record<string, unknown> | null): string[] | null => {
    if (row === null) return null
    const slots = ALACRITTY_SLOTS.map((name) => asColour(row[name]))
    return slots.every((slot): slot is string => slot !== undefined) ? slots : null
  }

  const normalSlots = readRow(normal)
  // `omarchy-theme-colors-from-alacritty` falls back to the normal row when a
  // theme omits its bright one; matching that keeps the two paths agreeing.
  const brightSlots = readRow(bright) ?? normalSlots

  const seed: SeedColours =
    normalSlots === null
      ? { bg, text: fg }
      : { bg, text: fg, accent: normalSlots[4] as string }

  return {
    colours: seed,
    ...(normalSlots !== null && brightSlots !== null
      ? { ansi: [...normalSlots, ...brightSlots] }
      : {}),
    ...(Object.keys(ui).length > 0 ? { ui } : {})
  }
}

/**
 * Merge what the two files said, `colors.toml` winning on colour and
 * `alacritty.toml` contributing the translucency it alone records.
 */
export function mergePalettes(
  primary: OmarchyPalette | null,
  secondary: OmarchyPalette | null
): OmarchyPalette | null {
  const usable = (palette: OmarchyPalette | null): palette is OmarchyPalette =>
    palette !== null && palette.colours.bg !== '' && palette.colours.text !== ''

  const base = usable(primary) ? primary : usable(secondary) ? secondary : null
  if (base === null) return null

  const ui = { ...secondary?.ui, ...primary?.ui }
  return {
    colours: base.colours,
    ...(base.ansi !== undefined ? { ansi: base.ansi } : {}),
    ...(Object.keys(ui).length > 0 ? { ui } : {})
  }
}
