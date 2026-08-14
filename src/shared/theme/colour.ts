/**
 * Colour arithmetic for the theme engine.
 *
 * Renderer-safe and dependency-free on purpose: these functions run in the
 * daemon when a theme is resolved and in tests when a derivation is golden-ed,
 * and `docs/THEMING.md` requires the derivation be *deterministic* — the same
 * Omarchy palette must always produce the same token set, or a "why did my theme
 * shift" bug becomes unreproducible.
 *
 * All ratios here are WCAG 2.1 relative-luminance contrast, which is what
 * THEMING.md's contrast guard is stated in (4.5:1 body text, 3:1 large text and
 * focus borders).
 */

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

export const WHITE: Rgb = { r: 255, g: 255, b: 255 }
export const BLACK: Rgb = { r: 0, g: 0, b: 0 }

/**
 * Parse the hex forms that actually appear in the wild.
 *
 * Omarchy's `colors.toml` writes `#rrggbb`, but the alacritty files it is
 * generated from use `0xrrggbb` and `'#rrggbb'` interchangeably, and hand-written
 * theme packs use `#rgb`. Returns `null` rather than throwing: a malformed colour
 * in a third-party theme must degrade to "fall back to the derivation", never to
 * a launcher that will not start.
 */
export function parseHex(input: string): Rgb | null {
  const raw = input.trim().replace(/^#/, '').replace(/^0[xX]/, '')

  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    const [r, g, b] = [...raw].map((c) => Number.parseInt(c + c, 16))
    return { r: r as number, g: g as number, b: b as number }
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return {
      r: Number.parseInt(raw.slice(0, 2), 16),
      g: Number.parseInt(raw.slice(2, 4), 16),
      b: Number.parseInt(raw.slice(4, 6), 16)
    }
  }
  return null
}

function channel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
}

export function toHex(colour: Rgb): string {
  return `#${channel(colour.r)}${channel(colour.g)}${channel(colour.b)}`
}

/** WCAG 2.1 relative luminance. */
export function luminance(colour: Rgb): number {
  const linear = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(colour.r) + 0.7152 * linear(colour.g) + 0.0722 * linear(colour.b)
}

/** WCAG 2.1 contrast ratio, 1 (identical) to 21 (black on white). */
export function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

/** `amount` is how much of `b` ends up in the result: 0 → all `a`, 1 → all `b`. */
export function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = Math.max(0, Math.min(1, amount))
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t
  }
}

/**
 * Whether a colour reads as a light surface.
 *
 * The 0.5 threshold is on *perceptual* luminance rather than on the raw average,
 * so a saturated mid-blue background is correctly called dark.
 */
export function isLight(colour: Rgb): boolean {
  return luminance(colour) > 0.5
}

/**
 * The direction a surface has to move to become more visible against `bg`:
 * white on a dark theme, black on a light one. Every "lighten by 6%" in
 * THEMING.md means this — a literal lighten turns a white background into
 * nothing at all.
 */
export function contrastPole(bg: Rgb): Rgb {
  return isLight(bg) ? BLACK : WHITE
}

/**
 * The pole a foreground should actually be pushed toward to become legible.
 *
 * Not the same question as {@link contrastPole}, and the difference is not
 * academic. A mid-tone background — Gruvbox's `#458588` accent, luminance 0.20 —
 * reads as "dark", so `contrastPole` says white; but white only reaches 4.23:1
 * against it while black reaches 4.97:1. Pushing toward the "obvious" pole would
 * mean a foreground that can never clear AA no matter how far it travels.
 * Surfaces still use `contrastPole` (they want to move in the direction that
 * looks like a lift), but anything that has a *ratio* to hit uses this.
 */
export function bestPole(bg: Rgb): Rgb {
  return contrast(WHITE, bg) >= contrast(BLACK, bg) ? WHITE : BLACK
}

/**
 * Push `fg` away from `bg` until it clears `ratio`, and give up gracefully.
 *
 * THEMING.md makes the contrast guard binding on the tokens we *ship*, but it is
 * just as load-bearing on tokens we *derive*: an Omarchy palette whose comment
 * colour sits at 2.8:1 against its own background would otherwise become our
 * `textFaint` and be genuinely unreadable. Moving toward the pole rather than
 * toward a fixed colour keeps a derived faint grey grey.
 *
 * Returns the best it managed if the target is unreachable (which only happens
 * for a mid-grey background where neither pole clears the ratio), because a
 * slightly-too-low contrast is still a usable launcher and an exception is not.
 */
export function ensureContrast(fg: Rgb, bg: Rgb, ratio: number): Rgb {
  if (contrast(fg, bg) >= ratio) return fg

  const pole = bestPole(bg)
  let best = fg
  // 5% steps: fine enough that the guard never overshoots into a colour the
  // theme author would not recognise, coarse enough to stay exactly reproducible.
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(fg, pole, step / 20)
    best = candidate
    if (contrast(candidate, bg) >= ratio) return candidate
  }
  return best
}

/** Convenience wrapper for the common "string in, string out" case. */
export function withContrast(fg: string, bg: string, ratio: number): string {
  const foreground = parseHex(fg)
  const background = parseHex(bg)
  if (foreground === null || background === null) return fg
  return toHex(ensureContrast(foreground, background, ratio))
}
