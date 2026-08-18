import type { ThemeSeed } from '../../src/shared/theme/derive'

/**
 * Tokyo Night (night variant) — the built-in default.
 *
 * Palette values are from the upstream Tokyo Night colour scheme (MIT); see
 * `themes/CREDITS.md`.
 *
 * This is a *seed*, not a finished token set: it names what the palette actually
 * defines and lets `resolveTheme()` derive the rest. That is deliberate — the
 * default theme then exercises the exact same derivation path as a theme derived
 * from Omarchy, so a bug in the derivation shows up here rather than only on
 * someone else's machine. It is also why `textFaint` is absent: upstream's
 * comment colour `#565f89` is 2.8:1 against `bg` and the contrast guard would
 * have to lift it anyway.
 */
export const tokyoNight: ThemeSeed = {
  meta: {
    name: 'Tokyo Night',
    id: 'tokyo-night',
    variant: 'dark',
    author: 'Folke Lemaitre (palette), Lumanin (token mapping)'
  },
  colours: {
    bg: '#1a1b26',
    text: '#c0caf5',
    accent: '#7aa2f7',
    bgSurface: '#1f2335',
    border: '#3b4261'
  },
  ansi: [
    '#15161e', '#f7768e', '#9ece6a', '#e0af68',
    '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
    '#414868', '#f7768e', '#9ece6a', '#e0af68',
    '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'
  ]
}
