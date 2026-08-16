import { describe, expect, it } from 'vitest'
import {
  CompositeAppearance,
  type AppearanceBackend,
  type AppearanceSignal
} from '../src/platform/appearance/index'
import { parseRonColour } from '../src/platform/appearance/cosmic'
import { parseNiriAccent } from '../src/platform/appearance/niri'
import { readToolkitTextScale } from '../src/platform/appearance/toolkit-scale'
import type { Exec } from '../src/platform/exec'
import { contrast, parseHex } from '../src/shared/theme/colour'
import { contrastProblems, resolveTheme } from '../src/shared/theme/derive'
import { parseGtkColour, parseGtkCss } from '../src/shared/theme/gtkcss'
import { parseKdeGlobals } from '../src/shared/theme/kdeglobals'

/**
 * The other desktops. Every fixture here is real file content — Breeze's scheme
 * as KDE ships it, libadwaita's own values, niri's documented syntax — because
 * none of these paths can be exercised on the dev machine and a fixture invented
 * to match the parser tests nothing at all.
 */

// ---------------------------------------------------------------------------
// KDE
// ---------------------------------------------------------------------------

/** Trimmed from `KDE/breeze/colors/BreezeDark.colors`, keys verbatim. */
const BREEZE_DARK = `
[ColorEffects:Disabled]
Color=56,56,56

[Colors:Button]
BackgroundNormal=41,44,48
ForegroundNormal=252,252,252

[Colors:Selection]
BackgroundNormal=61,174,233
ForegroundNormal=252,252,252

[Colors:View]
BackgroundAlternate=35,38,41
BackgroundNormal=27,30,32
ForegroundNormal=252,252,252

[Colors:Window]
BackgroundAlternate=49,54,59
BackgroundNormal=42,46,50
DecorationFocus=61,174,233
DecorationHover=61,174,233
ForegroundActive=61,174,233
ForegroundInactive=161,169,177
ForegroundLink=29,153,243
ForegroundNegative=218,68,83
ForegroundNeutral=246,116,0
ForegroundNormal=252,252,252
ForegroundPositive=39,174,96

[General]
ColorScheme=BreezeDark
Name=Breeze Dark

[WM]
activeBackground=39,44,49
`

describe('parseKdeGlobals', () => {
  it('reads a Breeze scheme', () => {
    const scheme = parseKdeGlobals(BREEZE_DARK)
    expect(scheme?.name).toBe('BreezeDark')
    expect(scheme?.colours.bg).toBe('#2a2e32')
    expect(scheme?.colours.text).toBe('#fcfcfc')
    expect(scheme?.colours.bgSurface).toBe('#1b1e20')
    expect(scheme?.colours.err).toBe('#da4453')
  })

  it('reads decimal triplets, not hex', () => {
    // The trap: KDE writes `61,174,233`. A hex parser returns nothing for that
    // and the failure looks exactly like "KDE has no theme".
    expect(parseKdeGlobals(BREEZE_DARK)?.colours.accent).toBe('#3daee9')
  })

  it("prefers the user's explicit accent over the scheme's focus decoration", () => {
    const withAccent = `[General]\nAccentColor=255,0,102\n${BREEZE_DARK}`
    expect(parseKdeGlobals(withAccent)?.colours.accent).toBe('#ff0066')
  })

  it('handles the doubled section headers KDE writes', () => {
    // `[Colors:Header][Inactive]` is real, and splitting on the first `]`
    // silently merges it into `[Colors:Header]`.
    const scheme = parseKdeGlobals(`
[Colors:Header][Inactive]
BackgroundNormal=1,2,3
[Colors:Window]
BackgroundNormal=42,46,50
ForegroundNormal=252,252,252
`)
    expect(scheme?.colours.bg).toBe('#2a2e32')
  })

  it('is null for a kdeglobals with no colour scheme in it', () => {
    // Qt writes one of these on machines that have never run Plasma.
    expect(parseKdeGlobals('[General]\nfont=Noto Sans,10\n[Icons]\nTheme=breeze\n')).toBeNull()
  })

  it('produces a legible theme once derived', () => {
    const scheme = parseKdeGlobals(BREEZE_DARK)
    const theme = resolveTheme({ meta: { name: 'Breeze', id: 'kde:Breeze' }, colours: scheme!.colours })
    expect(contrastProblems(theme.tokens)).toEqual([])
    expect(theme.meta.variant).toBe('dark')
  })
})

// ---------------------------------------------------------------------------
// GTK / GNOME
// ---------------------------------------------------------------------------

/** libadwaita's own light values, in the `@define-color` form overrides use. */
const ADWAITA_LIGHT_CSS = `
@define-color window_bg_color #fafafb;
@define-color window_fg_color rgb(0 0 6 / 80%);
@define-color view_bg_color #ffffff;
@define-color accent_bg_color #3584e4;
@define-color accent_fg_color #ffffff;
@define-color success_color #007c3d;
@define-color warning_color #905400;
@define-color error_color #c30000;
`

/** A GTK3-era third-party theme, which uses the other vocabulary entirely. */
const GTK3_CSS = `
@define-color theme_bg_color #2e3440;
@define-color theme_fg_color #d8dee9;
@define-color theme_base_color #3b4252;
@define-color theme_selected_bg_color #88c0d0;
@define-color theme_selected_fg_color #2e3440;
@define-color borders #4c566a;
`

describe('parseGtkColour', () => {
  it('composites a translucent foreground onto the background it will sit on', () => {
    // libadwaita's own light `window_fg_color` is `rgb(0 0 6 / 80%)`. Dropping the
    // alpha would make GNOME's soft black a hard one — and on a dark theme,
    // invisible.
    const flat = parseGtkColour('rgb(0 0 6 / 80%)', parseHex('#fafafb'))
    expect(flat).toBe('#323237')
  })

  it('reads the legacy comma form with a decimal alpha', () => {
    expect(parseGtkColour('rgba(255, 0, 0, 0.5)', parseHex('#000000'))).toBe('#800000')
  })

  it('leaves an opaque colour alone', () => {
    expect(parseGtkColour('#3584e4', parseHex('#ffffff'))).toBe('#3584e4')
    expect(parseGtkColour('rgb(53, 132, 228)', null)).toBe('#3584e4')
  })
})

describe('parseGtkCss', () => {
  it('reads libadwaita names', () => {
    const palette = parseGtkCss(ADWAITA_LIGHT_CSS)
    expect(palette?.colours.bg).toBe('#fafafb')
    expect(palette?.colours.accent).toBe('#3584e4')
    expect(palette?.colours.textOnAccent).toBe('#ffffff')
  })

  it('reads GTK3 names too, because third-party themes still use them', () => {
    const palette = parseGtkCss(GTK3_CSS)
    expect(palette?.colours.bg).toBe('#2e3440')
    expect(palette?.colours.text).toBe('#d8dee9')
    expect(palette?.colours.accent).toBe('#88c0d0')
    expect(palette?.colours.border).toBe('#4c566a')
  })

  it('reads libadwaita 1.6 custom properties', () => {
    const palette = parseGtkCss(':root { --window-bg-color: #222226; --window-fg-color: #ffffff; }')
    expect(palette?.colours.bg).toBe('#222226')
  })

  it('does not map the selection colour, which is the accent under another name', () => {
    // GTK paints a real selection at full accent strength behind
    // `accent_fg_color`; our list always has one selected row and draws it in the
    // normal text colour. Letting the derivation tint from the accent is the only
    // version of that which stays readable.
    const palette = parseGtkCss(ADWAITA_LIGHT_CSS)
    expect(palette?.colours.bgSelected).toBeUndefined()

    const theme = resolveTheme({ meta: { name: 'a', id: 'a' }, colours: palette!.colours })
    expect(contrast(parseHex(theme.tokens.text)!, parseHex(theme.tokens.bgSelected)!)).toBeGreaterThanOrEqual(4.5)
  })

  it('prefers the richer stylesheet, which is what `matched` is for', () => {
    expect(parseGtkCss(ADWAITA_LIGHT_CSS)!.matched).toBeGreaterThan(
      parseGtkCss('@define-color window_bg_color #fafafb;\n@define-color window_fg_color #000;')!.matched
    )
  })

  it('resolves a colour defined as another colour', () => {
    // GTK themes do this constantly. Left unresolved, the alias is an
    // unparseable value and the token is dropped — and when the alias is
    // `window_bg_color` that drops the whole palette, because it is what every
    // translucent value is composited against.
    const palette = parseGtkCss(`
@define-color base_bg #2e3440;
@define-color window_bg_color @base_bg;
@define-color window_fg_color #d8dee9;
`)
    expect(palette?.colours.bg).toBe('#2e3440')
  })

  it('gives up on a circular alias rather than looping', () => {
    expect(
      parseGtkCss('@define-color a @b;\n@define-color b @a;\n@define-color window_bg_color @a;')
    ).toBeNull()
  })

  it('is null for a stylesheet that only styles widgets', () => {
    // The common case for a theme that hides its palette behind @import: we take
    // nothing rather than half a theme, and the chain moves on.
    expect(parseGtkCss('@import url("colors.css");\nwindow { padding: 0; }')).toBeNull()
  })

  it('produces a legible theme once derived', () => {
    for (const css of [ADWAITA_LIGHT_CSS, GTK3_CSS]) {
      const palette = parseGtkCss(css)
      const theme = resolveTheme({ meta: { name: 'GTK', id: 'gtk:x' }, colours: palette!.colours })
      expect(contrastProblems(theme.tokens)).toEqual([])
    }
  })

  it('infers light and dark correctly from each', () => {
    expect(
      resolveTheme({ meta: { name: 'a', id: 'a' }, colours: parseGtkCss(ADWAITA_LIGHT_CSS)!.colours })
        .meta.variant
    ).toBe('light')
    expect(
      resolveTheme({ meta: { name: 'b', id: 'b' }, colours: parseGtkCss(GTK3_CSS)!.colours }).meta.variant
    ).toBe('dark')
  })
})

// ---------------------------------------------------------------------------
// niri
// ---------------------------------------------------------------------------

const NIRI_CONFIG = `
layout {
    gaps 16
    focus-ring {
        width 4
        active-color "#7fc8ff"
        inactive-color "#505050"
    }
    border {
        off
        active-color "#ffc87f"
    }
}
`

describe('parseNiriAccent', () => {
  it('takes the focus ring, which is the colour the user actually sees', () => {
    expect(parseNiriAccent(NIRI_CONFIG)).toBe('#7fc8ff')
  })

  it('falls back to the border when the focus ring is not the styled one', () => {
    expect(parseNiriAccent('layout {\n border { active-color "#ffc87f" }\n}')).toBe('#ffc87f')
  })

  it('drops the alpha pair from #rrggbbaa', () => {
    expect(parseNiriAccent('focus-ring { active-color "#7fc8ff80" }')).toBe('#7fc8ff')
  })

  it('reads the deprecated bare-numbers form', () => {
    expect(parseNiriAccent('focus-ring { active-color 127 200 255 255 }')).toBe('#7fc8ff')
  })

  it('takes the first stop of a gradient', () => {
    expect(
      parseNiriAccent('focus-ring { active-gradient from="#80c8ff" to="#bbddff" angle=45 }')
    ).toBe('#80c8ff')
  })

  it('ignores a commented-out colour', () => {
    // Very likely to be sitting in a real config, directly above the live one.
    expect(parseNiriAccent('focus-ring {\n // active-color "#ff0000"\n active-color "#7fc8ff"\n}')).toBe(
      '#7fc8ff'
    )
  })

  it('is null when there is no colour it understands', () => {
    expect(parseNiriAccent('focus-ring { active-color "rebeccapurple" }')).toBeNull()
    expect(parseNiriAccent('layout { gaps 16 }')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// COSMIC
// ---------------------------------------------------------------------------

describe('parseRonColour', () => {
  it('reads 0..1 floats, not bytes', () => {
    // The trap that would make every COSMIC colour black.
    expect(parseRonColour('(red: 1.0, green: 0.5, blue: 0.0, alpha: 1.0)')).toBe('#ff8000')
  })

  it('finds the channels inside a nested component', () => {
    expect(parseRonColour('(base: (red: 0.0, green: 0.0, blue: 1.0, alpha: 1.0), on: ())')).toBe(
      '#0000ff'
    )
  })

  it('handles exponent notation, which is how a serialiser writes a small float', () => {
    expect(parseRonColour('(red: 1e-8, green: 0.0, blue: 0.0, alpha: 1.0)')).toBe('#000000')
  })

  it('is null for anything that is not a colour', () => {
    expect(parseRonColour('true')).toBeNull()
    expect(parseRonColour('(red: 255, green: 0, blue: 0)')).toBeNull()
  })

  it('reads the v2 hex spellings, wrapped or bare', () => {
    // libcosmic bumped ThemeBuilder to v2 in 2026 and colours now serialise as
    // "#RRGGBBAA" strings; Option keys arrive wrapped in Some(…).
    expect(parseRonColour('"#3584e4ff"')).toBe('#3584e4')
    expect(parseRonColour('Some("#1E1E1EFF")')).toBe('#1e1e1e')
    expect(parseRonColour('"#ff8000"')).toBe('#ff8000')
    expect(parseRonColour('None')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

describe('CompositeAppearance', () => {
  function source(signal: AppearanceSignal | null, id = 'fake'): AppearanceBackend {
    return {
      id,
      read: () => Promise.resolve(signal),
      watch: () => () => undefined
    }
  }

  const PALETTE: AppearanceSignal = {
    source: 'palette',
    seed: { meta: { name: 'p', id: 'p' }, colours: { bg: '#101010', text: '#f0f0f0' } }
  }

  it('lets the first palette win outright', async () => {
    const composite = new CompositeAppearance([
      source(PALETTE, 'first'),
      source({ source: 'portal', variant: 'light', accent: '#ff0000' }, 'second')
    ])
    const signal = await composite.read()

    // A desktop that handed over a whole theme has already said what it wants;
    // a lower-priority accent must not repaint half of it.
    expect(signal?.seed?.colours.bg).toBe('#101010')
    expect(signal?.accent).toBeUndefined()
  })

  it('merges preference-only sources field by field', async () => {
    // The niri case, and the reason this capability composes rather than picks:
    // the accent is in `config.kdl` and the light/dark is on the bus, and taking
    // either alone throws away half of what the desktop said.
    const composite = new CompositeAppearance([
      source({ source: 'niri focus ring', accent: '#7fc8ff' }, 'niri'),
      source({ source: 'portal', variant: 'light' }, 'portal-settings')
    ])
    const signal = await composite.read()

    expect(signal?.accent).toBe('#7fc8ff')
    expect(signal?.variant).toBe('light')
    expect(signal?.source).toContain('niri')
    expect(signal?.source).toContain('portal')
  })

  it('lets the higher-priority source win a field both supply', async () => {
    const composite = new CompositeAppearance([
      source({ source: 'niri', accent: '#7fc8ff' }, 'niri'),
      source({ source: 'portal', accent: '#ff0000' }, 'portal-settings')
    ])
    expect((await composite.read())?.accent).toBe('#7fc8ff')
  })

  it('takes the text scale from a lower source when the palette has none', async () => {
    // KDE's palette comes from kdeglobals and knows nothing about text size;
    // gsettings does. Only a backend that says it has one is asked past the
    // palette, and a preference-only source is not.
    let portalAsked = 0
    const composite = new CompositeAppearance([
      source(PALETTE, 'kde-colors'),
      {
        id: 'portal-settings',
        read: () => {
          portalAsked += 1
          return Promise.resolve({ source: 'portal', variant: 'light' as const })
        },
        watch: () => () => undefined
      },
      {
        id: 'gsettings',
        providesTextScale: true,
        read: () => Promise.resolve({ source: 'GNOME interface settings', textScale: 1.25 }),
        watch: () => () => undefined
      }
    ])
    const signal = await composite.read()
    expect(signal?.seed?.colours.bg).toBe('#101010')
    expect(signal?.textScale).toBe(1.25)
    expect(signal?.variant).toBeUndefined()
    expect(portalAsked).toBe(0)
  })

  it('keeps a palette source\'s own text scale', async () => {
    const composite = new CompositeAppearance([
      source({ ...PALETTE, textScale: 14 / 12 }, 'omarchy'),
      {
        id: 'gsettings',
        providesTextScale: true,
        read: () => Promise.resolve({ source: 'gnome', textScale: 2 }),
        watch: () => () => undefined
      }
    ])
    expect((await composite.read())?.textScale).toBeCloseTo(14 / 12)
  })

  it('stops asking once a palette answers', async () => {
    // Not just tidiness: the portal backend spawns `gdbus`, and doing that on
    // every Omarchy machine for a result that is discarded is a subprocess per
    // theme resolution for nothing.
    let asked = 0
    const composite = new CompositeAppearance([
      source(PALETTE, 'first'),
      {
        id: 'portal-settings',
        read: () => {
          asked += 1
          return Promise.resolve(null)
        },
        watch: () => () => undefined
      }
    ])
    await composite.read()
    expect(asked).toBe(0)
  })

  it('survives a backend that throws', async () => {
    const composite = new CompositeAppearance([
      {
        id: 'broken',
        read: () => Promise.reject(new Error('nope')),
        watch: () => () => undefined
      },
      source(PALETTE, 'good')
    ])
    expect((await composite.read())?.seed?.colours.bg).toBe('#101010')
  })

  it('is null when every source says nothing', async () => {
    expect(await new CompositeAppearance([source(null), source(null)]).read()).toBeNull()
  })

  it('disposes every source it subscribed to', async () => {
    let live = 0
    const watching = (): AppearanceBackend => ({
      id: 'w',
      read: () => Promise.resolve(null),
      watch: () => {
        live += 1
        return () => {
          live -= 1
        }
      }
    })

    const stop = new CompositeAppearance([watching(), watching()]).watch(() => undefined)
    expect(live).toBe(2)
    stop()
    expect(live).toBe(0)
    await Promise.resolve()
  })
})

describe('every desktop palette survives derivation', () => {
  it('keeps the accent legible even when the desktop chose it for its own UI', () => {
    // niri's default focus ring is a pale blue that is 2.1:1 on a light
    // background. It is the right accent and the wrong contrast, and the guard
    // has to fix the second without discarding the first.
    const theme = resolveTheme({
      meta: { name: 'niri', id: 'niri' },
      colours: { bg: '#fafafb', text: '#323234', accent: parseNiriAccent(NIRI_CONFIG)! }
    })
    expect(contrast(parseHex(theme.tokens.accent)!, parseHex(theme.tokens.bg)!)).toBeGreaterThanOrEqual(3)
    expect(contrastProblems(theme.tokens)).toEqual([])
  })
})

describe('readToolkitTextScale', () => {
  const exec = (stdout: string, ok = true): Exec => ({
    run: () => Promise.resolve({ ok, stdout, stderr: '' })
  })

  it('reads text-scaling-factor from gsettings', async () => {
    expect(await readToolkitTextScale(exec('1.1818\n'), '/usr/bin/gsettings')).toBeCloseTo(1.1818)
  })

  it('is 1 without gsettings, on a failed call, or on nonsense', async () => {
    expect(await readToolkitTextScale(exec('1.5'), null)).toBe(1)
    expect(await readToolkitTextScale(exec('', false), '/usr/bin/gsettings')).toBe(1)
    expect(await readToolkitTextScale(exec('banana'), '/usr/bin/gsettings')).toBe(1)
    expect(await readToolkitTextScale(exec('40'), '/usr/bin/gsettings')).toBe(1)
  })
})
