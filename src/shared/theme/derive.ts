import {
  contrast,
  contrastPole,
  ensureContrast,
  isLight,
  mix,
  parseHex,
  toHex,
  type Rgb
} from './colour'
import type { AnsiPalette, Theme, ThemeTokens } from './tokens'

/**
 * `resolveTheme()` — turn any partial description of a theme into a complete,
 * legible token set.
 *
 * The rule is: a theme file may specify any subset; `resolveTheme()` fills every
 * remaining token by derivation from `bg`/`text`/`accent` and returns a
 * fully-populated token set. It exists
 * because the alternative failure mode is the worst one there is — the renderer
 * reading an undefined custom property and painting invisible text.
 *
 * Two properties are load-bearing and are what the golden tests pin:
 *
 *  - **Deterministic.** The same input always produces the same output, so a
 *    derived Omarchy theme is reproducible and a bug report about it is
 *    actionable.
 *  - **Legible by construction.** Every derived foreground is pushed through the
 *    contrast guard against the background it will actually sit on. A third-party
 *    palette whose comment colour fails AA does not get to make our faint text
 *    unreadable — the guard lifts it and the theme still looks like itself.
 *
 * An explicitly-specified token is never second-guessed except by that guard: an
 * author who writes a colour gets that colour.
 */

export const COLOUR_TOKENS = [
  'bg',
  'bgSurface',
  'bgSelected',
  'bgHover',
  'border',
  'borderFocus',
  'text',
  'textMuted',
  'textFaint',
  'textOnAccent',
  'accent',
  'accentSubtle',
  'ok',
  'warn',
  'err',
  'info'
] as const

export type ColourToken = (typeof COLOUR_TOKENS)[number]

export type UiTokens = Pick<
  ThemeTokens,
  | 'radiusOuter'
  | 'radiusInner'
  | 'font'
  | 'fontMono'
  | 'animations'
  | 'opacity'
  | 'blur'
  | 'blurFallbackOpacity'
>

/**
 * A `UiTokens` under construction. The token set is `readonly` because nothing
 * downstream of resolution may mutate a theme; the parsers that *build* one need
 * somewhere to accumulate, and this is that somewhere.
 */
export type MutableUi = { -readonly [K in keyof UiTokens]?: UiTokens[K] }

/** `bg` and `text` anchor the derivation; everything else is optional. */
export type SeedColours = Partial<Record<ColourToken, string>> & {
  readonly bg: string
  readonly text: string
}

export interface SeedMeta {
  readonly name: string
  readonly id: string
  readonly author?: string
  /** Omit to infer from the background's luminance. */
  readonly variant?: 'dark' | 'light'
}

export interface ThemeSeed {
  readonly meta: SeedMeta
  readonly colours: SeedColours
  /** 16 ANSI slots if the source has them; anything shorter is ignored. */
  readonly ansi?: readonly string[]
  readonly ui?: Partial<UiTokens>
}

/** WCAG AA for body text. Applied to every derived foreground. */
const AA_TEXT = 4.5
/** WCAG AA for large text, focus borders and other non-text indicators. */
const AA_LARGE = 3

const DEFAULT_UI: UiTokens = {
  radiusOuter: 6,
  radiusInner: 4,
  // Empty means "fontconfig default": we ship no bundled fonts.
  font: '',
  fontMono: '',
  animations: true,
  opacity: 1,
  blur: false,
  blurFallbackOpacity: 0.97
}

interface Palette {
  readonly bg: Rgb
  readonly text: Rgb
  readonly accent: Rgb
  readonly pole: Rgb
  readonly ansi: readonly Rgb[] | null
  readonly given: Partial<Record<ColourToken, Rgb>>
}

function readColours(colours: SeedColours): Partial<Record<ColourToken, Rgb>> {
  const parsed: Partial<Record<ColourToken, Rgb>> = {}
  for (const token of COLOUR_TOKENS) {
    const raw = colours[token]
    if (raw === undefined) continue
    const rgb = parseHex(raw)
    // A malformed colour is dropped, not fatal: the token then derives like any
    // other absent one, which is the difference between a theme that looks
    // slightly off and a launcher that will not start.
    if (rgb !== null) parsed[token] = rgb
  }
  return parsed
}

function readAnsi(ansi: readonly string[] | undefined): readonly Rgb[] | null {
  if (ansi === undefined || ansi.length < 16) return null
  const parsed = ansi.slice(0, 16).map(parseHex)
  return parsed.every((c): c is Rgb => c !== null) ? parsed : null
}

/**
 * The 16 ANSI slots when the source has none.
 *
 * Extensions colour badges by ANSI index and the calculator uses them, so the
 * slots cannot simply be absent — but inventing a palette out of nothing would
 * be arbitrary. These are built from the theme's own semantic colours, so a
 * derived palette is at least *of* the theme, and the bright half is the normal
 * half stepped toward the contrast pole exactly the way a terminal's is.
 */
function deriveAnsi(palette: Palette, semantic: Record<string, Rgb>): AnsiPalette {
  const { bg, text, accent, pole } = palette
  const normal: Rgb[] = [
    mix(bg, pole, 0.12),
    semantic['err'] ?? accent,
    semantic['ok'] ?? accent,
    semantic['warn'] ?? accent,
    accent,
    mix(accent, semantic['err'] ?? accent, 0.5),
    semantic['info'] ?? accent,
    text
  ]
  const slots = [...normal, ...normal.map((colour) => mix(colour, pole, 0.25))]
  return slots.map(toHex) as unknown as AnsiPalette
}

export function resolveTheme(seed: ThemeSeed): Theme {
  const given = readColours(seed.colours)

  // `bg` and `text` are the two the type demands, but a malformed value still has
  // to land somewhere sane rather than throwing.
  const bg = given.bg ?? { r: 0x1a, g: 0x1b, b: 0x26 }
  const pole = contrastPole(bg)
  const text = ensureContrast(given.text ?? mix(bg, pole, 0.85), bg, AA_TEXT)

  const ansi = readAnsi(seed.ansi)

  // Accent is the palette's blue unless the theme names one.
  // `colors.toml` always names one, so this branch is for hand-written packs and
  // for legacy alacritty derivation.
  const accent = ensureContrast(given.accent ?? ansi?.[4] ?? mix(text, bg, 0.2), bg, AA_LARGE)

  const palette: Palette = { bg, text, accent, pole, ansi, given }

  const pick = (token: ColourToken, derived: Rgb, against: Rgb | null, ratio: number): Rgb => {
    const colour = palette.given[token] ?? derived
    return against === null ? colour : ensureContrast(colour, against, ratio)
  }

  const ok = pick('ok', ansi?.[2] ?? { r: 0x9e, g: 0xce, b: 0x6a }, bg, AA_TEXT)
  const warn = pick('warn', ansi?.[3] ?? { r: 0xe0, g: 0xaf, b: 0x68 }, bg, AA_TEXT)
  const err = pick('err', ansi?.[1] ?? { r: 0xf7, g: 0x76, b: 0x8e }, bg, AA_TEXT)
  const info = pick('info', ansi?.[6] ?? { r: 0x7d, g: 0xcf, b: 0xff }, bg, AA_TEXT)

  /**
   * The selected row's background, guaranteed to be one our text can sit on.
   *
   * Every desktop names a selection colour, and every one of them means it to be
   * used with its *own* selection foreground — KDE pairs `#3daee9` with white,
   * GTK paints the accent at full strength behind `accent_fg_color`. Our list
   * shows a selection permanently and draws it in the normal text colour, so
   * taking those literally gives a bright slab with 2.4:1 text on it.
   *
   * Pulling it back toward the background preserves the hue the desktop chose —
   * the row still reads as *that* theme's selection — and stops as soon as the
   * text clears AA, so a theme whose selection was already fine is untouched.
   */
  const legibleSelection = (candidate: Rgb): Rgb => {
    for (let step = 0; step <= 20; step += 1) {
      const selection = mix(candidate, bg, step / 20)
      if (contrast(text, selection) >= AA_TEXT) return selection
    }
    // Unreachable in practice: step 20 *is* the background, and `text` was
    // already lifted to clear AA against it. Returning it rather than the
    // candidate keeps the impossible case legible instead of merely coloured.
    return bg
  }

  const tokens: ThemeTokens = {
    bg: toHex(bg),

    // Surfaces step away from the background toward the contrast pole. On a light
    // theme that is *darker*, which is why this is not the literal "lighten by
    // 6%" the doc says in prose — lightening a white background yields nothing.
    bgSurface: toHex(pick('bgSurface', mix(bg, pole, 0.06), null, 0)),
    // Selection and hover are tinted with the accent rather than merely lifted,
    // so the selected row reads as *chosen* and not just as a lighter row.
    bgSelected: toHex(legibleSelection(pick('bgSelected', mix(bg, accent, 0.15), null, 0))),
    bgHover: toHex(legibleSelection(pick('bgHover', mix(bg, accent, 0.08), null, 0))),

    // Borders come from the palette's bright black — the slot a
    // terminal theme already reserves for "visible but recessive".
    border: toHex(pick('border', ansi?.[8] ?? mix(bg, text, 0.25), null, 0)),
    // A focus ring is a non-text indicator, so it is held to 3:1 rather than 4.5.
    borderFocus: toHex(pick('borderFocus', accent, bg, AA_LARGE)),

    text: toHex(text),
    textMuted: toHex(pick('textMuted', mix(text, bg, 0.28), bg, AA_TEXT)),
    // The one most likely to arrive failing AA: terminal palettes put their
    // comment colour here and comment colours are routinely below 3:1.
    textFaint: toHex(pick('textFaint', mix(text, bg, 0.45), bg, AA_TEXT)),
    // Whichever of the theme's own two anchors reads better on the accent —
    // picking a fixed white or black would break one half of all themes.
    textOnAccent: toHex(
      pick('textOnAccent', contrast(bg, accent) >= contrast(text, accent) ? bg : text, accent, AA_TEXT)
    ),

    accent: toHex(accent),
    accentSubtle: toHex(pick('accentSubtle', mix(accent, bg, 0.55), null, 0)),

    ok: toHex(ok),
    warn: toHex(warn),
    err: toHex(err),
    info: toHex(info),

    ansi: (ansi?.map(toHex) as unknown as AnsiPalette) ?? deriveAnsi(palette, { ok, warn, err, info }),

    ...DEFAULT_UI,
    ...seed.ui
  }

  return {
    meta: {
      name: seed.meta.name,
      id: seed.meta.id,
      variant: seed.meta.variant ?? (isLight(bg) ? 'light' : 'dark'),
      author: seed.meta.author ?? 'unknown'
    },
    tokens
  }
}

/**
 * Report every shipped foreground/background pair that misses its target, for
 * `lumanin theme lint`. Returns an empty array for a theme that passed, which is
 * every theme `resolveTheme()` produced — the guard runs during derivation, so
 * this is here to catch a *hand-written* pack before it ships, and to explain
 * what the guard had to change.
 */
export function contrastProblems(tokens: ThemeTokens): readonly string[] {
  const bg = parseHex(tokens.bg)
  if (bg === null) return [`bg is not a colour: ${tokens.bg}`]

  const problems: string[] = []
  const check = (name: string, value: string, against: Rgb, ratio: number, label: string): void => {
    const colour = parseHex(value)
    if (colour === null) {
      problems.push(`${name} is not a colour: ${value}`)
      return
    }
    const actual = contrast(colour, against)
    if (actual < ratio) {
      problems.push(`${name} is ${actual.toFixed(2)}:1 against ${label}, below ${String(ratio)}:1`)
    }
  }

  for (const name of ['text', 'textMuted', 'textFaint', 'ok', 'warn', 'err', 'info'] as const) {
    check(name, tokens[name], bg, AA_TEXT, 'bg')
  }
  check('borderFocus', tokens.borderFocus, bg, AA_LARGE, 'bg')
  check('accent', tokens.accent, bg, AA_LARGE, 'bg')

  const accent = parseHex(tokens.accent)
  if (accent !== null) check('textOnAccent', tokens.textOnAccent, accent, AA_TEXT, 'accent')

  // Text has to survive the selected row too, not just the base background.
  const selected = parseHex(tokens.bgSelected)
  if (selected !== null) check('text', tokens.text, selected, AA_TEXT, 'bgSelected')

  return problems
}
