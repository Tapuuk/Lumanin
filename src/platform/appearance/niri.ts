import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { parseHex, toHex } from '../../shared/theme/colour'
import type { AppearanceBackend, AppearanceSignal } from './index'

/**
 * niri — the compositor's focus ring as an accent.
 *
 * niri has no theme system; it has a config file with a colour in it. That is
 * still worth reading, and for the same reason the Omarchy integration is: on a
 * niri desktop the focus ring *is* the accent the user chose, and matching it is
 * the difference between a launcher that belongs on their desktop and one that
 * merely runs on it.
 *
 * The syntax, from niri's configuration reference (checked 2026-08-08):
 *
 * ```kdl
 * layout {
 *     focus-ring {
 *         active-color "#7fc8ff"
 *         active-gradient from="#80c8ff" to="#bbddff" angle=45
 *     }
 *     border { active-color "#ffc87f" }
 * }
 * ```
 *
 * Colours are CSS-ish: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, and CSS
 * names. There is also a deprecated bare-numbers form (`active-color 127 200 255
 * 255`). This reads the quoted hex forms and the numeric one and ignores the
 * rest — a launcher accent is not worth a CSS colour parser, and anything it
 * cannot read simply falls through to the portal.
 *
 * This is a *preference*, never a palette: niri says nothing about backgrounds or
 * text, so the base comes from the portal's light/dark and the accent from here.
 *
 * **UNVERIFIED** — parser unit-tested against real config syntax; never run under
 * niri.
 */

/** Strip a trailing alpha pair: our tokens have no alpha channel. */
function hexColour(raw: string): string | null {
  const value = raw.trim().replace(/^["']|["']$/g, '')
  const opaque = /^#[0-9a-fA-F]{8}$/.test(value)
    ? value.slice(0, 7)
    : /^#[0-9a-fA-F]{4}$/.test(value)
      ? value.slice(0, 4)
      : value
  const parsed = parseHex(opaque)
  return parsed === null ? null : toHex(parsed)
}

export function parseNiriAccent(config: string): string | null {
  // Comments first: niri's KDL uses `//` and `/-` node-suppression, and a
  // commented-out `active-color` is one of the more likely things to be sitting
  // in a config file.
  const text = config.replace(/\/\/[^\n]*/g, '')

  // The focus ring is what the user sees around the focused window; `border` is
  // the fallback because a config with `focus-ring { off }` usually sets it
  // instead.
  for (const section of ['focus-ring', 'border']) {
    const block = new RegExp(`${section}\\s*\\{([\\s\\S]*?)\\}`).exec(text)
    if (block === null) continue
    const body = block[1] as string

    const quoted = /active-color\s+"([^"]+)"/.exec(body)
    if (quoted !== null) {
      const colour = hexColour(quoted[1] as string)
      if (colour !== null) return colour
    }

    // Deprecated numeric form: `active-color 127 200 255 255`.
    const numeric = /active-color\s+(\d+)\s+(\d+)\s+(\d+)/.exec(body)
    if (numeric !== null) {
      const [r, g, b] = numeric.slice(1, 4).map(Number) as [number, number, number]
      if ([r, g, b].every((c) => c >= 0 && c <= 255)) return toHex({ r, g, b })
    }

    const gradient = /active-gradient[^\n}]*from="([^"]+)"/.exec(body)
    if (gradient !== null) {
      const colour = hexColour(gradient[1] as string)
      if (colour !== null) return colour
    }
  }

  return null
}

export class NiriAppearance implements AppearanceBackend {
  readonly id = 'niri'

  constructor(private readonly path: string) {}

  read(): Promise<AppearanceSignal | null> {
    let config: string
    try {
      config = readFileSync(this.path, 'utf8')
    } catch {
      return Promise.resolve(null)
    }

    const accent = parseNiriAccent(config)
    if (accent === null) return Promise.resolve(null)

    return Promise.resolve({ accent, source: 'niri focus ring' })
  }

  watch(onChange: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null
    let watcher: FSWatcher | null = null

    try {
      watcher = watch(this.path, { persistent: false }, () => {
        if (timer !== null) clearTimeout(timer)
        // Longer than the others: this is a file a human is editing, and firing
        // on every keystroke-triggered save would repaint mid-edit.
        timer = setTimeout(onChange, 300)
      })
      watcher.on('error', () => undefined)
    } catch {
      return () => undefined
    }

    return () => {
      if (timer !== null) clearTimeout(timer)
      watcher?.close()
    }
  }
}
