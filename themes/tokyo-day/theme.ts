import type { ThemeSeed } from '../../src/shared/theme/derive'

/**
 * Tokyo Night Day — the built-in *light* base.
 *
 * It exists because the XDG portal's `color-scheme` signal picks
 * between our built-in light and dark bases, so shipping only a dark theme would
 * make "follow the system" a setting that can only ever do nothing. Pairing it
 * with the default rather than inventing a second identity keeps the two
 * recognisably one launcher.
 *
 * Palette from upstream Tokyo Night's `day` variant (MIT); see `themes/CREDITS.md`.
 */
export const tokyoDay: ThemeSeed = {
  meta: {
    name: 'Tokyo Day',
    id: 'tokyo-day',
    variant: 'light',
    author: 'Folke Lemaitre (palette), Lumanin (token mapping)'
  },
  colours: {
    bg: '#e1e2e7',
    text: '#3760bf',
    accent: '#2e7de9',
    bgSurface: '#d0d5e3',
    border: '#a1a6c5'
  },
  ansi: [
    '#b4b5b9', '#f52a65', '#587539', '#8c6c3e',
    '#2e7de9', '#9854f1', '#007197', '#6172b0',
    '#a1a6c5', '#f52a65', '#587539', '#8c6c3e',
    '#2e7de9', '#9854f1', '#007197', '#3760bf'
  ]
}
