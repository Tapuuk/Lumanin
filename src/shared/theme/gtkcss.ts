import { mix, parseHex, toHex, type Rgb } from './colour'
import type { SeedColours } from './derive'

/**
 * GTK / libadwaita colour definitions.
 *
 * This is how GNOME theming is actually expressed. Two syntaxes are live at once
 * and a real machine has both:
 *
 * ```css
 * @define-color window_bg_color #242424;   /* GTK3, and GTK4 overrides *​/
 * :root { --window-bg-color: #242424; }    /* libadwaita 1.6+ *​/
 * ```
 *
 * and two vocabularies — libadwaita's (`window_bg_color`, `accent_bg_color`) and
 * GTK3's (`theme_bg_color`, `theme_selected_bg_color`). Third-party themes use
 * whichever they were written against, so both are accepted and libadwaita's
 * name wins where a file defines both.
 *
 * **What this deliberately does not do is follow `@import`.** A GTK theme's
 * stylesheet is a program, not a palette: it imports, it computes with `mix()`
 * and `shade()`, and resolving it properly means implementing GTK's CSS engine.
 * We scrape the colour definitions we can see and let the derivation fill the
 * rest. A theme that hides its palette behind imports falls through to the next
 * source in the chain, which is the honest outcome — not a half-read theme.
 */

export interface GtkPalette {
  readonly colours: SeedColours
  /** How many recognised names were found, so callers can prefer a richer file. */
  readonly matched: number
}

/**
 * GTK colour values, in the forms that appear in real stylesheets.
 *
 * `rgba()` with alpha is the interesting one: libadwaita's own light
 * `window_fg_color` is `rgb(0 0 6 / 80%)`. A token set has no alpha channel, so
 * it is composited against the background it will sit on — dropping the alpha
 * instead would make GNOME's "80% black" text pure black, which is both wrong
 * and, on a dark theme, invisible.
 */
export function parseGtkColour(raw: string, against: Rgb | null): string | null {
  const value = raw.trim().replace(/;$/, '')

  const hex = parseHex(value)
  if (hex !== null && /^#|^0x/i.test(value)) return toHex(hex)

  const fn = /^rgba?\(\s*([^)]+)\)$/i.exec(value)
  if (fn === null) return null

  // Both `rgb(1, 2, 3)` and the CSS Color 4 form `rgb(1 2 3 / 80%)`.
  const [channelPart, alphaPart] = fn[1]!.split('/')
  const channels = channelPart!
    .split(/[\s,]+/)
    .filter((part) => part.length > 0)
    .map((part) => (part.endsWith('%') ? (Number.parseFloat(part) / 100) * 255 : Number(part)))

  if (channels.length < 3 || channels.some((c) => !Number.isFinite(c))) return null
  const colour: Rgb = { r: channels[0]!, g: channels[1]!, b: channels[2]! }

  const alphaRaw = alphaPart ?? (channels.length > 3 ? String(channels[3]) : undefined)
  const alpha =
    alphaRaw === undefined
      ? 1
      : alphaRaw.trim().endsWith('%')
        ? Number.parseFloat(alphaRaw) / 100
        : Number(alphaRaw)

  if (!Number.isFinite(alpha) || alpha >= 1) return toHex(colour)
  if (against === null) return toHex(colour)
  return toHex(mix(against, colour, Math.max(0, alpha)))
}

/** Pull every `@define-color name value;` and `--name: value;` out of a stylesheet. */
function definitions(css: string): Map<string, string> {
  const found = new Map<string, string>()

  for (const match of css.matchAll(/@define-color\s+([\w-]+)\s+([^;]+);/g)) {
    found.set(match[1]!.replace(/-/g, '_'), match[2]!.trim())
  }
  // libadwaita 1.6 moved to custom properties. Same names, kebab-cased, so they
  // are normalised onto the same keys rather than handled as a second vocabulary.
  for (const match of css.matchAll(/--([\w-]+)\s*:\s*([^;}]+)[;}]/g)) {
    const key = match[1]!.replace(/-/g, '_')
    if (!found.has(key)) found.set(key, match[2]!.trim())
  }

  return resolveAliases(found)
}

/**
 * Resolve `@define-color a @b;` — one name defined as another.
 *
 * GTK themes do this constantly (`@define-color theme_bg_color @bg_color;`), and
 * without it the alias reads as an unparseable value and the token is silently
 * dropped. When the alias is `window_bg_color` that drops the *whole* palette,
 * since it is the one value everything else is composited against.
 *
 * Bounded rather than recursive: a self-referential or circular definition is a
 * broken stylesheet, and the right response is to give up on that name, not to
 * loop.
 */
function resolveAliases(defs: Map<string, string>): Map<string, string> {
  const resolved = new Map(defs)

  for (const [key, value] of defs) {
    let current = value
    for (let depth = 0; depth < 8; depth += 1) {
      const alias = /^@([\w-]+)$/.exec(current.trim())
      if (alias === null) break
      const next = defs.get(alias[1]!.replace(/-/g, '_'))
      if (next === undefined || next === current) break
      current = next
    }
    resolved.set(key, current)
  }

  return resolved
}

/** libadwaita name first, GTK3 name second. */
const TOKEN_SOURCES: readonly (readonly [keyof SeedColours | 'bg' | 'text', readonly string[]])[] = [
  ['bg', ['window_bg_color', 'theme_bg_color']],
  ['text', ['window_fg_color', 'theme_fg_color']],
  ['bgSurface', ['view_bg_color', 'card_bg_color', 'theme_base_color']],
  // Note there is no `bgSelected` here, and deliberately so: GTK's selection
  // colour *is* its accent, and the derivation already tints the selected row
  // from the accent. Mapping it directly would paint the row a solid slab of
  // accent — which is right for GTK, where a selection is transient and drawn in
  // `accent_fg_color`, and wrong for a list that always has one selected row
  // drawn in the normal text colour.
  ['accent', ['accent_bg_color', 'theme_selected_bg_color']],
  ['textOnAccent', ['accent_fg_color', 'theme_selected_fg_color']],
  ['textMuted', ['dim_label_color', 'insensitive_fg_color']],
  ['border', ['borders', 'headerbar_border_color']],
  ['ok', ['success_color', 'theme_success_color']],
  ['warn', ['warning_color', 'theme_warning_color']],
  ['err', ['error_color', 'theme_error_color']]
]

export function parseGtkCss(css: string): GtkPalette | null {
  const defs = definitions(css)
  if (defs.size === 0) return null

  // Resolved first and separately: it is the surface every translucent value
  // below has to be composited against, so it cannot be resolved in the same
  // pass as them.
  const backgroundRaw = defs.get('window_bg_color') ?? defs.get('theme_bg_color')
  const background = backgroundRaw === undefined ? null : parseGtkColour(backgroundRaw, null)
  if (background === null) return null
  const againstBg = parseHex(background)

  const colours: Record<string, string> = { bg: background }
  let matched = 1

  for (const [token, names] of TOKEN_SOURCES) {
    if (token === 'bg') continue
    for (const name of names) {
      const raw = defs.get(name)
      if (raw === undefined) continue
      const value = parseGtkColour(raw, againstBg)
      if (value === null) continue
      colours[token] = value
      matched += 1
      break
    }
  }

  if (colours['text'] === undefined) return null
  return { colours: colours as unknown as SeedColours, matched }
}
