import { describe, expect, it } from 'vitest'
import { contrast, luminance, parseHex } from '../src/shared/theme/colour'
import { contrastProblems, resolveTheme, type ThemeSeed } from '../src/shared/theme/derive'
import { tokensToCssVars, type ThemeTokens } from '../src/shared/theme/tokens'

/**
 * The derivation goldens: *"deterministic derivation
 * function, golden-tested against 3 sample palettes"*.
 *
 * The palettes are inlined rather than read from the machine's Omarchy install
 * on purpose — a test that passes only on a laptop with the right themes
 * installed is not a test.
 */

/** Catppuccin Mocha, as Omarchy's `colors.toml` writes it. */
const MOCHA: ThemeSeed = {
  meta: { name: 'Catppuccin', id: 'catppuccin' },
  colours: { bg: '#1a1b1e', text: '#cdd6f4', accent: '#89b4fa' },
  ansi: [
    '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af',
    '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
    '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af',
    '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'
  ]
}

/** Catppuccin Latte — a light theme, so every "lighten" has to run the other way. */
const LATTE: ThemeSeed = {
  meta: { name: 'Catppuccin Latte', id: 'catppuccin-latte' },
  colours: { bg: '#eff1f5', text: '#4c4f69', accent: '#1e66f5' }
}

/** Gruvbox — warm, low-contrast, and its "blue" is nothing like a blue. */
const GRUVBOX: ThemeSeed = {
  meta: { name: 'Gruvbox', id: 'gruvbox' },
  colours: { bg: '#282828', text: '#ebdbb2', accent: '#458588' }
}

const SAMPLES = [MOCHA, LATTE, GRUVBOX]

function tokensOf(seed: ThemeSeed): ThemeTokens {
  return resolveTheme(seed).tokens
}

describe('resolveTheme', () => {
  it.each(SAMPLES.map((seed) => [seed.meta.id, seed] as const))(
    '%s: leaves no token undefined',
    (_id, seed) => {
      const tokens = tokensOf(seed)
      // The failure this prevents is the worst one in the app: an undefined CSS
      // custom property renders as invisible text, not as an error.
      for (const [key, value] of Object.entries(tokens)) {
        expect(value, key).toBeDefined()
        if (typeof value === 'string' && key !== 'font' && key !== 'fontMono') {
          expect(value, key).toMatch(/^#[0-9a-f]{6}$/)
        }
      }
      expect(tokens.ansi).toHaveLength(16)
    }
  )

  it.each(SAMPLES.map((seed) => [seed.meta.id, seed] as const))(
    '%s: clears the contrast guard on every shipped pair',
    (_id, seed) => {
      expect(contrastProblems(tokensOf(seed))).toEqual([])
    }
  )

  it('is deterministic', () => {
    // Not a tautology test: the derivation is what makes a bug report about a
    // derived theme actionable, and anything time- or order-dependent in here
    // would make one unreproducible.
    for (const seed of SAMPLES) {
      expect(tokensOf(seed)).toEqual(tokensOf(seed))
    }
  })

  it('infers the variant from the background when the source is silent', () => {
    expect(resolveTheme(MOCHA).meta.variant).toBe('dark')
    expect(resolveTheme(LATTE).meta.variant).toBe('light')
  })

  it('believes an explicit variant over the luminance', () => {
    // Some third-party themes are near-black and still call themselves light,
    // and `light.mode` is a statement of intent we do not get to overrule.
    const forced = resolveTheme({ ...MOCHA, meta: { ...MOCHA.meta, variant: 'light' } })
    expect(forced.meta.variant).toBe('light')
  })

  it('moves surfaces away from the background in the direction that is visible', () => {
    // "lighten by 6%" is wrong on a light theme — it would make a near-white
    // surface disappear into a near-white background.
    const dark = tokensOf(MOCHA)
    expect(luminance(parseHex(dark.bgSurface)!)).toBeGreaterThan(luminance(parseHex(dark.bg)!))

    const light = tokensOf(LATTE)
    expect(luminance(parseHex(light.bgSurface)!)).toBeLessThan(luminance(parseHex(light.bg)!))
  })

  it('takes the accent from the palette blue when the theme names none', () => {
    const { accent } = tokensOf({
      meta: MOCHA.meta,
      colours: { bg: '#1a1b1e', text: '#cdd6f4' },
      ansi: MOCHA.ansi as readonly string[]
    })
    expect(accent).toBe('#89b4fa')
  })

  it('lifts a foreground the source supplied below AA', () => {
    // Terminal palettes routinely put a 2.8:1 comment colour here. Taking it
    // literally would make our faint text genuinely unreadable.
    const tokens = tokensOf({
      ...MOCHA,
      colours: { ...MOCHA.colours, textFaint: '#565f89' }
    })
    expect(contrast(parseHex(tokens.textFaint)!, parseHex(tokens.bg)!)).toBeGreaterThanOrEqual(4.5)
  })

  it('honours an explicitly specified token that already passes', () => {
    const tokens = tokensOf({ ...MOCHA, colours: { ...MOCHA.colours, bgSurface: '#123456' } })
    expect(tokens.bgSurface).toBe('#123456')
  })

  it('survives a malformed colour instead of refusing to start', () => {
    const tokens = tokensOf({ ...MOCHA, colours: { ...MOCHA.colours, accent: 'not a colour' } })
    expect(tokens.accent).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('produces a css variable for every token it derived', () => {
    const vars = tokensToCssVars(tokensOf(GRUVBOX))
    for (const name of ['--lumanin-bg', '--lumanin-text-faint', '--lumanin-accent-subtle', '--lumanin-ansi-15']) {
      expect(vars[name], name).toBeDefined()
    }
  })
})
