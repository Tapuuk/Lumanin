import type { SeedColours } from './derive'

/**
 * KDE Plasma colour schemes.
 *
 * **Verified against `KDE/breeze/colors/BreezeDark.colors` on 2026-08-08.** A
 * `.colors` scheme file and `~/.config/kdeglobals` are the *same INI format* —
 * applying a scheme in System Settings copies its sections into `kdeglobals` —
 * so reading `kdeglobals` gets the live palette without having to find, parse and
 * follow a scheme file, and it works for a user who hand-edited their colours
 * instead of installing a scheme.
 *
 * The sections that matter:
 *
 * ```ini
 * [General]
 * AccentColor=61,174,233      ; Plasma 6 user accent; absent if never set
 * ColorScheme=BreezeDark
 * [Colors:Window]             ; chrome — our panel
 * BackgroundNormal=41,44,48
 * ForegroundNormal=252,252,252
 * ForegroundInactive=161,169,177
 * ForegroundNegative=218,68,83
 * ForegroundNeutral=246,116,0
 * ForegroundPositive=39,174,96
 * ForegroundLink=29,153,243
 * DecorationFocus=61,174,233
 * [Colors:View]               ; content — our results list
 * [Colors:Selection]          ; the selected row, and in practice the accent
 * ```
 *
 * Values are decimal `R,G,B`, occasionally `R,G,B,A`. Not hex — a hex parser
 * silently returns nothing here, which would look exactly like "KDE has no
 * theme".
 *
 * Nothing in a KDE scheme describes a *border*: Breeze draws frames from a
 * shaded background rather than a named colour. That token is left for the
 * derivation rather than invented here.
 */

export interface KdeScheme {
  readonly colours: SeedColours
  /** `[General] ColorScheme`, for the theme's display name. */
  readonly name: string | null
}

type Ini = Map<string, Map<string, string>>

function parseIni(text: string): Ini {
  const sections: Ini = new Map()
  let current = new Map<string, string>()
  sections.set('', current)

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue

    if (line.startsWith('[')) {
      // Section names contain colons and can carry a second bracketed group
      // (`[Colors:Header][Inactive]`), so the name is everything up to the last
      // `]` — splitting on `:` or taking the first `]` both mangle real files.
      // Everything up to the *last* `]`, so `[Colors:Header][Inactive]` stays one
      // distinct section rather than being merged into `[Colors:Header]`.
      const name = line.slice(1, line.lastIndexOf(']'))
      // Merged, not replaced. A section can legitimately appear more than once —
      // `kdeglobals` accumulates writes from several KDE components — and
      // starting a fresh map each time silently discards everything the earlier
      // occurrence said, which is how a user's `[General] AccentColor` disappears
      // behind a later `[General] ColorScheme`.
      current = sections.get(name) ?? new Map<string, string>()
      sections.set(name, current)
      continue
    }

    const split = line.indexOf('=')
    if (split === -1) continue
    current.set(line.slice(0, split).trim(), line.slice(split + 1).trim())
  }

  return sections
}

/** `R,G,B` or `R,G,B,A` decimal triplets — KDE never writes hex here. */
function rgb(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const parts = value.split(',').map((part) => Number(part.trim()))
  if (parts.length < 3) return undefined
  const [r, g, b] = parts as [number, number, number]
  if (![r, g, b].every((c) => Number.isFinite(c) && c >= 0 && c <= 255)) return undefined
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

export function parseKdeGlobals(text: string): KdeScheme | null {
  const ini = parseIni(text)
  const get = (section: string, key: string): string | undefined => rgb(ini.get(section)?.get(key))

  const window = 'Colors:Window'
  const view = 'Colors:View'
  const selection = 'Colors:Selection'

  const bg = get(window, 'BackgroundNormal')
  const text_ = get(window, 'ForegroundNormal')
  // Without these two there is no scheme in the file — which is the normal state
  // of `kdeglobals` on a machine that merely has KDE libraries installed.
  if (bg === undefined || text_ === undefined) return null

  // Priority is deliberate. The user's explicit accent beats the scheme's focus
  // decoration, which in turn beats the selection background — Plasma 6 tints
  // Selection from the accent, so it is a good last resort but a poor first one.
  const accent =
    rgb(ini.get('General')?.get('AccentColor')) ??
    get(window, 'DecorationFocus') ??
    get(selection, 'BackgroundNormal')

  const colours: Record<string, string> = { bg, text: text_ }
  const put = (token: string, value: string | undefined): void => {
    if (value !== undefined) colours[token] = value
  }

  put('accent', accent)
  put('borderFocus', get(window, 'DecorationFocus'))
  // The results list is content, not chrome, so it takes the View background —
  // on most schemes that is the deliberate step away from the window colour we
  // would otherwise have to invent.
  put('bgSurface', get(view, 'BackgroundNormal'))
  // No `bgSelected`: Plasma's `[Colors:Selection]` background *is* the accent,
  // which the derivation already tints the selected row from. Mapping it
  // directly would paint a permanent row of `#3daee9` and put 2.4:1 text on it.
  put('textOnAccent', get(selection, 'ForegroundNormal'))
  put('textMuted', get(window, 'ForegroundInactive'))
  put('ok', get(window, 'ForegroundPositive'))
  put('warn', get(window, 'ForegroundNeutral'))
  put('err', get(window, 'ForegroundNegative'))
  put('info', get(window, 'ForegroundLink'))

  return {
    colours: colours as unknown as SeedColours,
    name: ini.get('General')?.get('ColorScheme') ?? null
  }
}
