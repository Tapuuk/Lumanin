import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OmarchyAppearance,
  readOmarchyTextScale,
  readOmarchyTheme,
  readShellBaseSize
} from '../src/platform/appearance/omarchy'
import { resolveTheme } from '../src/shared/theme/derive'
import { mergePalettes, parseAlacritty, parseOmarchyColors } from '../src/shared/theme/omarchy'
import { parseThemePack } from '../src/shared/theme/pack'

/**
 * The Omarchy integration, tested against the file formats that are actually on
 * disk today (see the comment block in `src/shared/theme/omarchy.ts` for the
 * two shapes).
 */

/** Verbatim shape of a stock theme's `colors.toml`. */
const COLORS_TOML = `
accent = "#89b4fa"
cursor = "#f5e0dc"
foreground = "#cdd6f4"
background = "#1a1b1e"
selection_foreground = "#1a1b1e"
selection_background = "#f5e0dc"

color0 = "#45475a"
color1 = "#f38ba8"
color2 = "#a6e3a1"
color3 = "#f9e2af"
color4 = "#89b4fa"
color5 = "#f5c2e7"
color6 = "#94e2d5"
color7 = "#bac2de"
color8 = "#585b70"
color9 = "#f38ba8"
color10 = "#a6e3a1"
color11 = "#f9e2af"
color12 = "#89b4fa"
color13 = "#f5c2e7"
color14 = "#94e2d5"
color15 = "#a6adc8"
`

/** Exactly what Omarchy 4.0 writes to `current/theme/colors.toml` for catppuccin. */
const COLORS_TOML_V4 = `mode = "dark"

accent = "#89b4fa"
selection = "#45475a"
muted = "#585b70"

background = "#1e1e2e"
dark_background = "#161622"
darker_background = "#101019"
lighter_background = "#313244"

foreground = "#cdd6f4"
dark_foreground = "#6c7086"
light_foreground = "#bac2de"
bright_foreground = "#cdd6f4"

red = "#f38ba8"
yellow = "#f9e2af"
orange = "#f6b6ab"
green = "#a6e3a1"
cyan = "#94e2d5"
blue = "#89b4fa"
magenta = "#f5c2e7"
brown = "#7b5b55"

bright_red = "#f38ba8"
bright_yellow = "#f9e2af"
bright_green = "#a6e3a1"
bright_cyan = "#94e2d5"
bright_blue = "#89b4fa"
bright_magenta = "#f5c2e7"
`

/** A third-party theme that predates `colors.toml` and ships only this. */
const ALACRITTY_TOML = `
[colors]
[colors.primary]
background = '#1a0d2e'
foreground = '#d4a5ff'

[colors.normal]
black   = "#2d1b4e"
red     = "#ff6ec7"
green   = "#5ffbf1"
yellow  = "#f9f871"
blue    = "#8b9aff"
magenta = "#f4a5ff"
cyan    = "#5ffbf1"
white   = "#ffffff"

[colors.bright]
black   = "#543a6e"
red     = "#ff9adc"
green   = "#8ffef4"
yellow  = "#fbf9a5"
blue    = "#b8c1ff"
magenta = "#ffc8ff"
cyan    = "#8ffef4"
white   = "#fef6ff"
`

describe('parseOmarchyColors', () => {
  it('reads the flat generated schema', () => {
    const palette = parseOmarchyColors(COLORS_TOML)
    expect(palette?.colours.bg).toBe('#1a1b1e')
    expect(palette?.colours.text).toBe('#cdd6f4')
    expect(palette?.colours.accent).toBe('#89b4fa')
    expect(palette?.ansi).toHaveLength(16)
  })

  it('ignores the terminal selection colours', () => {
    // Catppuccin's selection background is a near-white pink, tuned to be loud
    // against a wall of monospace. A launcher row painted with it shouts.
    const palette = parseOmarchyColors(COLORS_TOML)
    expect(Object.values(palette?.colours ?? {})).not.toContain('#f5e0dc')
    expect(resolveTheme({ meta: { name: 'x', id: 'x' }, ...palette! }).tokens.bgSelected).not.toBe('#f5e0dc')
  })

  it('returns null for a file with no palette in it', () => {
    expect(parseOmarchyColors('[window]\nopacity = 0.5\n')).toBeNull()
    expect(parseOmarchyColors('this is not toml {{{')).toBeNull()
  })
})

describe('parseAlacritty', () => {
  it('reads the legacy nested schema', () => {
    const palette = parseAlacritty(ALACRITTY_TOML)
    expect(palette?.colours.bg).toBe('#1a0d2e')
    expect(palette?.colours.text).toBe('#d4a5ff')
    // What `omarchy-theme-colors-from-alacritty` does too:
    // the accent is the palette's blue.
    expect(palette?.colours.accent).toBe('#8b9aff')
    expect(palette?.ansi?.[8]).toBe('#543a6e')
  })

  it('falls back to the normal row when a theme omits its bright one', () => {
    const withoutBright = ALACRITTY_TOML.slice(0, ALACRITTY_TOML.indexOf('[colors.bright]'))
    const palette = parseAlacritty(withoutBright)
    expect(palette?.ansi?.[8]).toBe('#2d1b4e')
  })

  it('reads a glass theme translucency from the window opacity', () => {
    const palette = parseAlacritty('[window]\nopacity = 0.5\n')
    expect(palette?.ui?.blur).toBe(true)
    expect(palette?.ui?.opacity).toBe(0.5)
  })

  it('does not treat a fully opaque window as a glass theme', () => {
    expect(parseAlacritty('[window]\nopacity = 1.0\n')).toBeNull()
  })
})

describe('mergePalettes', () => {
  it('takes colour from colors.toml and translucency from alacritty.toml', () => {
    // The live case on this machine: `catppuccin-glass` ships a full
    // `colors.toml` and an `alacritty.toml` containing nothing but an opacity.
    const merged = mergePalettes(
      parseOmarchyColors(COLORS_TOML),
      parseAlacritty('[window]\nopacity = 0.5\n')
    )
    expect(merged?.colours.bg).toBe('#1a1b1e')
    expect(merged?.ui?.opacity).toBe(0.5)
  })

  it('falls back to alacritty when there is no colors.toml', () => {
    const merged = mergePalettes(null, parseAlacritty(ALACRITTY_TOML))
    expect(merged?.colours.bg).toBe('#1a0d2e')
  })

  it('is null when neither file had a palette', () => {
    expect(mergePalettes(null, null)).toBeNull()
    expect(mergePalettes(null, parseAlacritty('[window]\nopacity = 0.5\n'))).toBeNull()
  })
})

describe('parseThemePack', () => {
  it('reads the lumanin.toml pack format', () => {
    const seed = parseThemePack(
      `
[meta]
name = "Sample"
variant = "light"
author = "Someone"

[colors]
bg = "#ffffff"
text = "#101010"
accent = "#0055ff"

[ui]
radius_outer = 10
animations = false
opacity = 0.8
`,
      'sample'
    )
    expect(seed?.meta).toMatchObject({ name: 'Sample', id: 'sample', variant: 'light' })
    expect(seed?.colours.accent).toBe('#0055ff')
    expect(seed?.ui).toMatchObject({ radiusOuter: 10, animations: false, opacity: 0.8 })
  })

  it('drops a variant it does not understand rather than guessing', () => {
    const seed = parseThemePack('[meta]\nvariant = "drak"\n[colors]\nbg="#fff"\ntext="#000"\n', 'x')
    expect(seed?.meta.variant).toBeUndefined()
    // …and the luminance inference then gets it right anyway.
    expect(resolveTheme(seed!).meta.variant).toBe('light')
  })

  it('clamps a ruinous radius instead of honouring it', () => {
    const seed = parseThemePack('[colors]\nbg="#000"\ntext="#fff"\n[ui]\nradius_outer = 400\n', 'x')
    expect(seed?.ui?.radiusOuter).toBe(32)
  })

  it('is null for a pack with no background or text', () => {
    expect(parseThemePack('[meta]\nname = "Empty"\n', 'x')).toBeNull()
  })
})

describe('readOmarchyTheme', () => {
  function omarchyTree(files: Readonly<Record<string, string>>): string {
    const root = mkdtempSync(join(tmpdir(), 'lumanin-omarchy-'))
    const themeDir = join(root, 'current', 'theme')
    mkdirSync(themeDir, { recursive: true })
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(name.includes('/') ? root : themeDir, name.replace('../', 'current/')), contents)
    }
    return join(root, 'current')
  }

  it('reads the applied theme and names it from theme.name', () => {
    const root = omarchyTree({ 'colors.toml': COLORS_TOML, '../theme.name': 'catppuccin-glass\n' })
    const theme = readOmarchyTheme(root)
    expect(theme?.name).toBe('catppuccin-glass')
    expect(theme?.seed.colours.bg).toBe('#1a1b1e')
  })

  it('treats light.mode as the authoritative variant', () => {
    // The marker exists because a palette's luminance is not always the whole
    // story, and four stock themes rely on it.
    const root = omarchyTree({ 'colors.toml': COLORS_TOML, 'light.mode': '' })
    expect(readOmarchyTheme(root)?.seed.meta.variant).toBe('light')
  })

  it('reads the Omarchy 4 shape: mode key, named palette, shell selection colour', () => {
    // Verified against the `colors.toml` Omarchy 4.0 (Quattro) writes for
    // catppuccin.
    const root = omarchyTree({ 'colors.toml': COLORS_TOML_V4, '../theme.name': 'catppuccin\n' })
    const theme = readOmarchyTheme(root)
    expect(theme?.seed.meta.variant).toBe('dark')
    expect(theme?.seed.colours.bg).toBe('#1e1e2e')
    expect(theme?.seed.colours.accent).toBe('#89b4fa')
    expect(theme?.seed.colours.bgSelected).toBe('#45475a')
    expect(theme?.seed.colours.err).toBe('#f38ba8')
    // ANSI slots rebuilt the way Omarchy's own alacritty template does it.
    expect(theme?.seed.ansi).toHaveLength(16)
    expect(theme?.seed.ansi?.[0]).toBe('#1e1e2e')
    expect(theme?.seed.ansi?.[8]).toBe('#585b70')
    expect(theme?.seed.ansi?.[15]).toBe('#cdd6f4')
  })

  it('takes mode = "light" from colors.toml ahead of luminance', () => {
    const root = omarchyTree({ 'colors.toml': COLORS_TOML_V4.replace('mode = "dark"', 'mode = "light"') })
    expect(readOmarchyTheme(root)?.seed.meta.variant).toBe('light')
  })

  it("lets a theme's own lumanin.toml beat everything we would infer", () => {
    // The zero-config adoption path promised to theme authors only means
    // anything if the file actually wins.
    const root = omarchyTree({
      'colors.toml': COLORS_TOML,
      'lumanin.toml': '[meta]\nname = "Authored"\n[colors]\nbg = "#010203"\ntext = "#fefefe"\n'
    })
    const theme = readOmarchyTheme(root)
    expect(theme?.seed.meta.name).toBe('Authored')
    expect(theme?.seed.colours.bg).toBe('#010203')
  })

  it('is null when Omarchy is not installed', () => {
    expect(readOmarchyTheme(mkdtempSync(join(tmpdir(), 'lumanin-empty-')))).toBeNull()
  })

  it('is null when the theme directory holds nothing we can read', () => {
    expect(readOmarchyTheme(omarchyTree({ 'README.md': 'hello' }))).toBeNull()
  })
})

describe('OmarchyAppearance watch', () => {
  /**
   * Reproduces `omarchy-theme-set` exactly, because the details are what broke
   * the obvious implementation: it assembles the new theme in `next-theme`, then
   * `rm -rf current/theme && mv current/next-theme current/theme`, and only then
   * writes `current/theme.name`.
   *
   * A watch on `current/theme` is therefore watching a directory that no longer
   * exists the moment the user switches themes — it fires once and never again.
   */
  function themeSet(root: string, name: string, colours: string): void {
    const current = join(root, 'current')
    const next = join(current, 'next-theme')
    mkdirSync(next, { recursive: true })
    writeFileSync(join(next, 'colors.toml'), colours)
    rmSync(join(current, 'theme'), { recursive: true, force: true })
    renameSync(next, join(current, 'theme'))
    writeFileSync(join(current, 'theme.name'), `${name}\n`)
  }

  it('survives the theme directory being replaced, and fires again', async () => {
    // `OmarchyAppearance` takes the `current/` directory itself - the probe
    // decides whether that lives under `$XDG_STATE_HOME` (Omarchy 4) or
    // `$XDG_CONFIG_HOME` (Omarchy 3).
    const stateHome = mkdtempSync(join(tmpdir(), 'lumanin-watch-'))
    const root = join(stateHome, 'omarchy')
    mkdirSync(join(root, 'current'), { recursive: true })
    themeSet(root, 'first', COLORS_TOML)

    let fired = 0
    const stop = new OmarchyAppearance(join(root, 'current'), stateHome).watch(() => {
      fired += 1
    })

    const gruvbox = COLORS_TOML.replace('#1a1b1e', '#282828').replace('#cdd6f4', '#ebdbb2')
    themeSet(root, 'second', gruvbox)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const afterFirstSwitch = fired
    expect(readOmarchyTheme(join(root, 'current'))?.seed.colours.bg).toBe('#282828')

    // The second switch is the one that matters: it is the one an inner-directory
    // watch would have missed, because the directory it was watching is gone.
    themeSet(root, 'third', COLORS_TOML)
    await new Promise((resolve) => setTimeout(resolve, 400))

    stop()
    expect(afterFirstSwitch).toBeGreaterThan(0)
    expect(fired).toBeGreaterThan(afterFirstSwitch)
  })
})

describe('Omarchy 4 text size', () => {
  it('reads [font] base-size and scales against the shell default of 12', () => {
    expect(readShellBaseSize('[font]\nbase-size = 14\n')).toBe(14)
    expect(readShellBaseSize('[bar]\nsize-horizontal = 26\n')).toBeNull()
    expect(readShellBaseSize('[font]\nbase-size = 0\n')).toBeNull()
    expect(readShellBaseSize('not toml = = =')).toBeNull()
  })

  it("prefers the user's shell.toml, then the theme's, then 1", () => {
    const stateHome = mkdtempSync(join(tmpdir(), 'lumanin-textscale-'))
    const configHome = mkdtempSync(join(tmpdir(), 'lumanin-textscale-cfg-'))
    const current = join(stateHome, 'omarchy', 'current')
    mkdirSync(join(current, 'theme'), { recursive: true })
    expect(readOmarchyTextScale(current, configHome)).toBe(1)

    writeFileSync(join(current, 'theme', 'shell.toml'), '[font]\nbase-size = 15\n')
    expect(readOmarchyTextScale(current, configHome)).toBe(15 / 12)

    mkdirSync(join(configHome, 'omarchy'), { recursive: true })
    writeFileSync(join(configHome, 'omarchy', 'shell.toml'), '[font]\nbase-size = 9\n')
    expect(readOmarchyTextScale(current, configHome)).toBe(0.75)
  })

  it('reports the text scale beside the palette', async () => {
    const stateHome = mkdtempSync(join(tmpdir(), 'lumanin-textscale-sig-'))
    const configHome = mkdtempSync(join(tmpdir(), 'lumanin-textscale-sig-cfg-'))
    const current = join(stateHome, 'omarchy', 'current')
    mkdirSync(join(current, 'theme'), { recursive: true })
    writeFileSync(join(current, 'theme', 'colors.toml'), COLORS_TOML_V4)
    mkdirSync(join(configHome, 'omarchy'), { recursive: true })
    writeFileSync(join(configHome, 'omarchy', 'shell.toml'), '[font]\nbase-size = 14\n')
    const signal = await new OmarchyAppearance(current, configHome).read()
    expect(signal?.textScale).toBeCloseTo(14 / 12)
    expect(signal?.seed?.colours.bg).toBe('#1e1e2e')
  })
})
