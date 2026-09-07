import { parse as parseToml } from 'smol-toml'
import { COLOUR_TOKENS, type MutableUi, type SeedColours, type ThemeSeed, type UiTokens } from './derive'

/**
 * The `lumanin.toml` theme-pack format.
 *
 * ```toml
 * [meta]   name = "Tokyo Night"  variant = "dark"  author = "…"
 * [colors] bg = "#1a1b26"  text = "#c0caf5"  accent = "#7aa2f7"  # any subset
 * [ui]     radius_outer = 6  animations = false  opacity = 1.0
 * ```
 *
 * This is also the file third-party Omarchy theme authors are meant to drop into
 * their theme directories, which is why the filename is fixed and why the
 * parser is forgiving: an unknown key is
 * ignored, a malformed value falls back to derivation, and nothing here can stop
 * the launcher from starting. Keys are snake_case in the file and camelCase in
 * the token set, and that mapping is spelled out rather than computed so adding a
 * token is a deliberate act.
 */

const UI_KEYS: Readonly<Record<string, keyof UiTokens>> = {
  radius_outer: 'radiusOuter',
  radius_inner: 'radiusInner',
  font: 'font',
  font_mono: 'fontMono',
  animations: 'animations',
  opacity: 'opacity',
  blur: 'blur',
  blur_fallback_opacity: 'blurFallbackOpacity'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function readUi(table: Record<string, unknown> | null): Partial<UiTokens> {
  const ui: MutableUi = {}
  if (table === null) return ui

  for (const [fileKey, token] of Object.entries(UI_KEYS)) {
    const raw = table[fileKey]
    if (raw === undefined) continue

    switch (token) {
      case 'radiusOuter':
      case 'radiusInner':
        // Clamped rather than merely type-checked: a 400px radius is a valid
        // number and an unusable panel.
        if (typeof raw === 'number' && Number.isFinite(raw)) {
          ui[token] = Math.max(0, Math.min(32, Math.round(raw)))
        }
        break
      case 'font':
      case 'fontMono':
        if (typeof raw === 'string') ui[token] = raw
        break
      case 'animations':
      case 'blur':
        if (typeof raw === 'boolean') ui[token] = raw
        break
      case 'opacity':
      case 'blurFallbackOpacity':
        if (typeof raw === 'number' && Number.isFinite(raw)) ui[token] = clamp01(raw)
        break
    }
  }
  return ui
}

/**
 * `id` comes from the directory the file was found in, not from the file — the
 * name a user types in `config.toml` has to be the name on disk, or `theme =
 * "…"` would be unresolvable without reading every pack first.
 */
export function parseThemePack(text: string, id: string): ThemeSeed | null {
  let file: Record<string, unknown> | null
  try {
    file = asRecord(parseToml(text))
  } catch {
    return null
  }
  if (file === null) return null

  const meta = asRecord(file['meta'])
  const colours = asRecord(file['colors'])

  const bg = asString(colours?.['bg'])
  const text_ = asString(colours?.['text'])
  // Everything else can be derived; these two cannot be, and a pack without them
  // is not a theme.
  if (bg === undefined || text_ === undefined) return null

  const seedColours: Record<string, string> = { bg, text: text_ }
  for (const token of COLOUR_TOKENS) {
    const value = asString(colours?.[token])
    if (value !== undefined) seedColours[token] = value
  }

  const ansiRaw = colours?.['ansi']
  const ansi =
    Array.isArray(ansiRaw) && ansiRaw.length === 16 && ansiRaw.every((c) => typeof c === 'string')
      ? (ansiRaw as string[])
      : undefined

  const variant = asString(meta?.['variant'])

  return {
    meta: {
      name: asString(meta?.['name']) ?? id,
      id,
      ...(asString(meta?.['author']) !== undefined ? { author: asString(meta?.['author']) as string } : {}),
      // Anything other than the two we understand is dropped so the luminance
      // inference runs — an author who typed `variant = "drak"` gets the right
      // answer rather than a light theme rendered as dark.
      ...(variant === 'dark' || variant === 'light' ? { variant } : {})
    },
    colours: seedColours as unknown as SeedColours,
    ...(ansi !== undefined ? { ansi } : {}),
    ui: readUi(asRecord(file['ui']))
  }
}
