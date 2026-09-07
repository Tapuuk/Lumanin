# Theme palette credits

Palettes are colour lists, not code, but they are authored work and are credited
properly here. Where a built-in pack departs from its upstream palette, the reason
is recorded - every departure so far is the WCAG AA contrast guard that
built-in packs must clear.

## tokyo-night

- Upstream: [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) — MIT.
- Variant used: `night`.
- Departure: `textFaint` uses `#7d86ab` rather than upstream's comment colour
  `#565f89`. Upstream measures 2.80:1 against `bg` (`#1a1b26`), below the 4.5:1
  body-text floor; the replacement measures 4.78:1.
