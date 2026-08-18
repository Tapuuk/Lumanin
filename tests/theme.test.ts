import { describe, expect, it } from 'vitest'
import { defaultTheme } from '../themes/index'
import { effectiveTokens, tokensToCssVars, type ThemeTokens } from '../src/shared/theme/tokens'

/**
 * The default built-in, *resolved* — a seed run through `resolveTheme()`, which
 * is how it reaches the renderer. The contrast assertions below are therefore
 * testing the derivation, not a hand-tuned table of hex values.
 */
const tokyoNight = defaultTheme()

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

describe('tokensToCssVars', () => {
  it('emits a custom property for every token', () => {
    const vars = tokensToCssVars(tokyoNight.tokens)

    // The renderer must never read an undefined custom property —
    // that yields invisible text, the worst failure mode there is.
    for (const key of Object.keys(tokyoNight.tokens)) {
      if (key === 'ansi') continue
      const name = `--lumanin-${key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`
      expect(vars[name], name).toBeDefined()
    }

    for (let i = 0; i < 16; i += 1) {
      expect(vars[`--lumanin-ansi-${String(i)}`], `ansi ${String(i)}`).toBeDefined()
    }
  })

  it('gives radii a px unit and booleans a numeric form', () => {
    const vars = tokensToCssVars(tokyoNight.tokens)
    expect(vars['--lumanin-radius-outer']).toBe('6px')
    expect(vars['--lumanin-radius-inner']).toBe('4px')
    expect(vars['--lumanin-animations']).toBe('1')
  })

  it('derives a motion duration so components never branch on a boolean', () => {
    expect(tokensToCssVars(tokyoNight.tokens)['--lumanin-motion-duration']).toBe('80ms')

    const still: ThemeTokens = { ...tokyoNight.tokens, animations: false }
    expect(tokensToCssVars(still)['--lumanin-motion-duration']).toBe('0ms')
  })
})

describe('effectiveTokens', () => {
  const glassy: ThemeTokens = {
    ...tokyoNight.tokens,
    blur: true,
    opacity: 0.7,
    blurFallbackOpacity: 0.97
  }

  it('keeps the theme opacity when the compositor grants blur', () => {
    expect(effectiveTokens(glassy, true).opacity).toBe(0.7)
  })

  it('falls back to a near-opaque surface when blur is unavailable', () => {
    // Never ship unreadable transparency: without compositor blur, text would
    // otherwise sit on raw wallpaper.
    expect(effectiveTokens(glassy, false).opacity).toBe(0.97)
  })

  it('leaves an opaque theme alone either way', () => {
    expect(effectiveTokens(tokyoNight.tokens, false)).toBe(tokyoNight.tokens)
  })
})

describe('built-in pack contrast guard', () => {
  const { tokens } = tokyoNight

  it.each([
    ['text', tokens.text],
    ['textMuted', tokens.textMuted],
    ['textFaint', tokens.textFaint]
  ])('%s clears WCAG AA for body text against bg', (_name, colour) => {
    expect(contrast(colour, tokens.bg)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps body text legible on every surface a theme paints', () => {
    for (const surface of [tokens.bgSurface, tokens.bgSelected, tokens.bgHover]) {
      expect(contrast(tokens.text, surface)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps the focus border at 3:1, the large-element floor', () => {
    expect(contrast(tokens.borderFocus, tokens.bg)).toBeGreaterThanOrEqual(3)
  })

  it('keeps text-on-accent legible', () => {
    expect(contrast(tokens.textOnAccent, tokens.accent)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps status colours legible', () => {
    for (const colour of [tokens.ok, tokens.warn, tokens.err, tokens.info]) {
      expect(contrast(colour, tokens.bg)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
