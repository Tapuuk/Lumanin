import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { Exec } from '../exec'
import type { AppearanceBackend, AppearanceSignal } from './index'

/**
 * GNOME via gsettings — the fallback for a GNOME session with no working portal.
 *
 * `org.gnome.desktop.interface color-scheme` is `'default'`, `'prefer-dark'` or
 * `'prefer-light'`, and GNOME 47 added `accent-color`, which is a **named
 * enum**, not a colour: `blue`, `teal`, `green`, `yellow`, `orange`, `red`,
 * `pink`, `purple`, `slate`. The hex values below are libadwaita's own, from
 * `adw-accent-color.c`, so a GNOME user's accent is the
 * exact colour their other applications are using rather than an approximation.
 *
 * Live updates come from `~/.config/dconf/user`, which dconf rewrites on every
 * change. That is a binary database and is not parsed — it is only a trigger to
 * re-run the two `gsettings get` calls above.
 *
 * **UNVERIFIED as a whole** — the `gsettings get` calls were run successfully on
 * this machine (they answer on any system with the schemas installed), but the
 * backend has never been the chosen one in a real GNOME session.
 */

/** libadwaita `AdwAccentColor` → hex. From `adw_accent_color_to_rgba()`. */
const GNOME_ACCENTS: Readonly<Record<string, string>> = {
  blue: '#3584e4',
  teal: '#2190a4',
  green: '#3a944a',
  yellow: '#c88800',
  orange: '#ed5b00',
  red: '#e62d42',
  pink: '#d56199',
  purple: '#9141ac',
  slate: '#6f8396'
}

export interface GsettingsDeps {
  readonly exec: Exec
  readonly gsettings: string
  readonly configHome: string
  readonly preferBase?: string
}

export class GsettingsAppearance implements AppearanceBackend {
  readonly id = 'gsettings'
  readonly providesTextScale = true as const

  constructor(private readonly deps: GsettingsDeps) {}

  private async get(key: string): Promise<string | null> {
    const result = await this.deps.exec.run(this.deps.gsettings, [
      'get',
      'org.gnome.desktop.interface',
      key
    ])
    // A key that does not exist in the installed schema — `accent-color` before
    // GNOME 47 — makes gsettings exit non-zero. Expected, not an error.
    return result.ok ? result.stdout.trim().replace(/^'|'$/g, '') : null
  }

  async read(): Promise<AppearanceSignal | null> {
    const [scheme, accentName, scaling] = await Promise.all([
      this.get('color-scheme'),
      this.get('accent-color'),
      this.get('text-scaling-factor')
    ])

    const signal: {
      variant?: 'dark' | 'light'
      accent?: string
      preferBase?: string
      textScale?: number
      source: string
    } = {
      source: 'GNOME interface settings'
    }

    // `text-scaling-factor` is what GNOME's "Large Text" and Omarchy's
    // `omarchy display text size` both write; `1.0` is the default and is still
    // an answer (it says "not scaled", which beats guessing).
    const factor = scaling === null ? NaN : Number(scaling)
    if (Number.isFinite(factor) && factor >= 0.5 && factor <= 4) signal.textScale = factor

    // `'default'` means the user has expressed no preference, so it must fall
    // through rather than being read as light.
    if (scheme === 'prefer-dark') signal.variant = 'dark'
    if (scheme === 'prefer-light') signal.variant = 'light'

    const accent = accentName === null ? undefined : GNOME_ACCENTS[accentName]
    if (accent !== undefined) signal.accent = accent
    if (this.deps.preferBase !== undefined) signal.preferBase = this.deps.preferBase

    return signal.variant === undefined && signal.accent === undefined && signal.textScale === undefined
      ? null
      : signal
  }

  watch(onChange: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null
    let watcher: FSWatcher | null = null

    try {
      watcher = watch(join(this.deps.configHome, 'dconf', 'user'), { persistent: false }, () => {
        if (timer !== null) clearTimeout(timer)
        // Every dconf write lands here, not just ours, so the debounce is long
        // enough that a burst of unrelated settings changes costs one re-read.
        timer = setTimeout(onChange, 250)
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
