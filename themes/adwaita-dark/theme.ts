import type { ThemeSeed } from '../../src/shared/theme/derive'

/**
 * Adwaita (dark) — the base a GNOME session lands on when the desktop gives us a
 * preference rather than a palette.
 *
 * A stock GNOME has no readable palette: Adwaita's colours are compiled into
 * libadwaita, not shipped as a stylesheet, so there is no file to derive from.
 * Falling back to Tokyo Night there would put a purple-blue launcher in the
 * middle of a grey desktop. These are libadwaita's own values, from its
 * `css-variables` documentation (checked 2026-08-08), so the panel is the same
 * grey as the GNOME windows around it and a system accent tints it exactly as it
 * tints them.
 *
 * Only the *colours* follow GNOME. Spacing, radius and typography stay ours —
 * the same line THEMING.md draws for the Glass exception, for the same reason:
 * this is a finish, not a costume.
 */
export const adwaitaDark: ThemeSeed = {
  meta: {
    name: 'Adwaita Dark',
    id: 'adwaita-dark',
    variant: 'dark',
    author: 'GNOME (palette), Lumanin (token mapping)'
  },
  colours: {
    bg: '#222226',
    text: '#ffffff',
    // `--view-bg-color`: what GNOME paints behind a list, which is what our
    // results are.
    bgSurface: '#1d1d20',
    accent: '#3584e4',
    textOnAccent: '#ffffff',
    ok: '#78e9ab',
    warn: '#ffc252',
    err: '#ff938c'
  }
}
