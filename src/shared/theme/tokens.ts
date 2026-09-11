/**
 * The semantic design tokens.
 *
 * Components may only use these — never a raw hex value, never a palette name.
 * The token set is exhaustive by construction: `ThemeTokens` has no optional
 * colour fields, so a theme that omits a token cannot reach the renderer with a
 * hole in it. That matters because reading an undefined CSS
 * custom property yields invisible text, the worst failure mode there is.
 *
 * One fully-specified built-in pack ships. `resolveTheme()` derives a full set
 * from a partial theme file, the Omarchy/portal resolution chain picks the source,
 * and hot-swapping is live. None of that changes this shape.
 */

/** Named ANSI slots 0–15, in the conventional order. */
export type AnsiPalette = readonly [
  string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string, string
]

export interface ThemeTokens {
  readonly bg: string
  readonly bgSurface: string
  readonly bgSelected: string
  readonly bgHover: string

  readonly border: string
  readonly borderFocus: string

  readonly text: string
  readonly textMuted: string
  readonly textFaint: string
  readonly textOnAccent: string

  readonly accent: string
  readonly accentSubtle: string

  readonly ok: string
  readonly warn: string
  readonly err: string
  readonly info: string

  readonly ansi: AnsiPalette

  readonly radiusOuter: number
  readonly radiusInner: number
  /** Empty string means "use the fontconfig default" — we ship no fonts. */
  readonly font: string
  readonly fontMono: string
  readonly animations: boolean
  readonly opacity: number
  readonly blur: boolean
  readonly blurFallbackOpacity: number
}

export interface ThemeMeta {
  readonly name: string
  readonly id: string
  readonly variant: 'dark' | 'light'
  readonly author: string
}

export interface Theme {
  readonly meta: ThemeMeta
  readonly tokens: ThemeTokens
}

const CSS_VAR_PREFIX = '--lumanin-'

function kebab(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * Flatten tokens into CSS custom properties for `:root`. Booleans become `1`/`0`
 * so they can drive `@media`-free conditional styling via `calc()`; `animations`
 * additionally gets a duration variable, because every component that animates
 * needs a duration and none of them should branch on a boolean.
 */
export function tokensToCssVars(tokens: ThemeTokens): Record<string, string> {
  const vars: Record<string, string> = {}

  for (const [key, value] of Object.entries(tokens)) {
    if (key === 'ansi') continue
    const name = `${CSS_VAR_PREFIX}${kebab(key)}`
    if (typeof value === 'boolean') {
      vars[name] = value ? '1' : '0'
    } else if (typeof value === 'number') {
      vars[name] = key.startsWith('radius') ? `${String(value)}px` : String(value)
    } else {
      vars[name] = String(value)
    }
  }

  tokens.ansi.forEach((colour, index) => {
    vars[`${CSS_VAR_PREFIX}ansi-${String(index)}`] = colour
  })

  // Motion is near-none by default and off entirely when the theme
  // says so. The system `prefers-reduced-motion` signal ORs with this in CSS.
  vars[`${CSS_VAR_PREFIX}motion-duration`] = tokens.animations ? '80ms' : '0ms'

  // The effective surface opacity depends on whether the compositor actually
  // granted blur; the renderer is told the resolved value, never asked to guess.
  vars[`${CSS_VAR_PREFIX}surface-opacity`] = String(tokens.opacity)

  return vars
}

/**
 * Apply the resolved opacity for a theme given what the platform could actually
 * deliver. A translucent theme on a compositor without blur falls back to
 * `blurFallbackOpacity` rather than leaving text sitting on raw wallpaper.
 */
export function effectiveTokens(tokens: ThemeTokens, blurGranted: boolean): ThemeTokens {
  if (!tokens.blur || blurGranted) return tokens
  return { ...tokens, opacity: tokens.blurFallbackOpacity }
}
