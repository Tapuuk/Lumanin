import { resolveTheme, type ThemeSeed } from '../src/shared/theme/derive'
import type { Theme } from '../src/shared/theme/tokens'
import { adwaitaDark } from './adwaita-dark/theme'
import { adwaitaLight } from './adwaita-light/theme'
import { tokyoDay } from './tokyo-day/theme'
import { tokyoNight } from './tokyo-night/theme'

/**
 * The built-in theme packs.
 *
 * These are compiled-in seeds rather than `lumanin.toml` files read from disk.
 * The file format is real and is what user and third-party packs use — see
 * `parseThemePack()` — but a built-in has to resolve before any filesystem is
 * known to be readable, and has to survive being packed into an asar where
 * `themes/` is not a directory any more. Both go through the same
 * `resolveTheme()`, so the two paths cannot drift in behaviour.
 */

export const BUILTIN_SEEDS: readonly ThemeSeed[] = [tokyoNight, tokyoDay, adwaitaDark, adwaitaLight]

/** The end of the resolution chain. */
export const DEFAULT_BASE = 'tokyo'

/**
 * Built-in packs come in light/dark pairs, named `<base>-night`/`<base>-day` or
 * `<base>-dark`/`<base>-light`.
 *
 * The pairing is what makes "follow the system" mean anything: a desktop that
 * tells us light or dark is choosing between two members of a pair, not picking
 * a theme by name. `preferBase` on an `AppearanceSignal` names the pair — GNOME
 * asks for `adwaita` so a GNOME user gets GNOME's greys — and the variant picks
 * the member.
 */
const PAIRS: Readonly<Record<string, { dark: string; light: string }>> = {
  tokyo: { dark: 'tokyo-night', light: 'tokyo-day' },
  adwaita: { dark: 'adwaita-dark', light: 'adwaita-light' }
}

export function builtinSeed(id: string): ThemeSeed | null {
  return BUILTIN_SEEDS.find((seed) => seed.meta.id === id) ?? null
}

export function builtinTheme(id: string): Theme | null {
  const seed = builtinSeed(id)
  return seed === null ? null : resolveTheme(seed)
}

/**
 * The built-in for a base and variant. Never null — everything downstream may
 * rely on that, and an unknown base falls back to ours rather than to nothing.
 */
export function baseSeed(base: string | undefined, variant: 'dark' | 'light' = 'dark'): ThemeSeed {
  const pair = PAIRS[base ?? DEFAULT_BASE] ?? PAIRS[DEFAULT_BASE]
  return builtinSeed(pair?.[variant] ?? 'tokyo-night') ?? tokyoNight
}

/** The default, resolved. */
export function defaultTheme(variant: 'dark' | 'light' = 'dark'): Theme {
  return resolveTheme(baseSeed(DEFAULT_BASE, variant))
}
