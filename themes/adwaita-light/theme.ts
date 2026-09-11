import type { ThemeSeed } from '../../src/shared/theme/derive'

/**
 * Adwaita (light). See `themes/adwaita-dark/theme.ts` for why these exist.
 *
 * `text` is `#000006` rather than libadwaita's literal `rgb(0 0 6 / 80%)`: our
 * tokens have no alpha channel, and 80% black over `#fafafb` is what the
 * derivation would produce anyway once it composited it. Written out flat so the
 * value in the file is the value on screen.
 */
export const adwaitaLight: ThemeSeed = {
  meta: {
    name: 'Adwaita Light',
    id: 'adwaita-light',
    variant: 'light',
    author: 'GNOME (palette), Lumanin (token mapping)'
  },
  colours: {
    bg: '#fafafb',
    text: '#323237',
    bgSurface: '#ffffff',
    accent: '#3584e4',
    textOnAccent: '#ffffff',
    ok: '#007c3d',
    warn: '#905400',
    err: '#c30000'
  }
}
