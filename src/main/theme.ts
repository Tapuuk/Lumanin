import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { baseSeed, builtinSeed, defaultTheme } from '../../themes/index'
import type { AppearanceBackend, AppearanceSignal } from '../platform/appearance/index'
import type { ResolvedConfig } from '../shared/config'
import { resolveTheme, type ThemeSeed } from '../shared/theme/derive'
import { THEME_FILE_BASENAME } from '../shared/identity'
import type { ThemePayload } from '../shared/ipc'
import { parseThemePack } from '../shared/theme/pack'
import { effectiveTokens, tokensToCssVars, type Theme } from '../shared/theme/tokens'
import type { Logger } from '../node/logger'

/**
 * The theme resolution chain.
 *
 *   1. a theme forced in `config.toml`
 *   2. the desktop's appearance source — Omarchy's palette, or the portal's
 *      light/dark preference and accent
 *   3. the built-in default
 *
 * First hit wins, every source is watched, and a change re-resolves and pushes
 * new CSS custom properties to the renderer without a reload. That last part is
 * the whole point: theme switching has to *feel instant*, and a
 * launcher that has to restart to follow `omarchy theme set` is not integrated
 * with the desktop, it merely knows about it.
 *
 * Resolution is deliberately not on the toggle path. It reads files and, for the
 * portal, spawns `gdbus`; it runs at startup and when something changed, never
 * when the window is shown.
 */

export interface ThemeServiceDeps {
  readonly config: () => ResolvedConfig
  /** `$XDG_CONFIG_HOME/lumanin` — where user theme packs live. */
  readonly configDir: string
  readonly logger: Logger
  /** Pushed to the renderer whenever the resolved theme changes. */
  readonly onChange: (payload: ThemePayload) => void
}

/** Snap a zoom within 3% of 1 to exactly 1; round the rest to a hundredth. */
function nearOne(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1
  if (Math.abs(zoom - 1) < 0.03) return 1
  return Math.round(zoom * 100) / 100
}

export class ThemeService {
  private appearance: AppearanceBackend | null = null
  private blurGranted = false
  private disposers: (() => void)[] = []
  private lastSource = 'built-in default'
  private lastDesktopTextScale = 1
  private toolkitTextScale: () => Promise<number> = () => Promise.resolve(1)
  private lastToolkitTextScale = 1
  private generation = 0
  private current: ThemePayload

  constructor(private readonly deps: ThemeServiceDeps) {
    // A theme exists from the first instant, before any probe has finished: the
    // window can be shown by the hotkey the moment the daemon is up, and a
    // renderer that paints with no tokens paints invisible text.
    this.current = this.payload(this.resolve(null))
  }

  get payloadNow(): ThemePayload {
    return this.current
  }

  /** What the toolkit already scaled text by, as of the last resolution. */
  get toolkitScaleNow(): number {
    return this.lastToolkitTextScale
  }

  /**
   * Adopt the platform's appearance backend once the probes have run, and start
   * watching every source.
   */
  async attach(
    appearance: AppearanceBackend,
    blurGranted: boolean,
    toolkitTextScale: () => Promise<number> = () => Promise.resolve(1)
  ): Promise<void> {
    this.appearance = appearance
    this.blurGranted = blurGranted
    this.toolkitTextScale = toolkitTextScale

    this.disposers.push(appearance.watch(() => void this.refresh('desktop appearance changed')))
    this.watchConfigDir()

    await this.refresh('startup')
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
  }

  /** Re-run the chain and push the result if it differs. */
  async refresh(reason: string): Promise<void> {
    // Reading a source is asynchronous — the portal spawns `gdbus` — so two
    // changes in quick succession can finish out of order and leave the *older*
    // theme applied. Switching themes twice quickly is exactly what someone
    // comparing two of them does, so the last request in has to be the one that
    // wins, not the last to return.
    const generation = (this.generation += 1)

    const [signal, toolkit] = await Promise.all([
      this.appearance === null ? null : this.appearance.read().catch(() => null),
      this.toolkitTextScale().catch(() => 1)
    ])
    if (generation !== this.generation) return

    // Text size is a separate axis from colour: it applies whether or not the
    // palette followed the desktop, and whether or not a theme is forced.
    this.lastDesktopTextScale = signal?.textScale ?? 1
    this.lastToolkitTextScale = toolkit
    const theme = this.resolve(signal)
    const next = this.payload(theme)

    // Compared by value, not by identity: a `colors.toml` rewritten with the same
    // contents (Omarchy regenerates it on every `theme set`) must not repaint.
    if (JSON.stringify(next) === JSON.stringify(this.current)) return

    this.current = next
    this.deps.logger.info('theme resolved', {
      reason,
      theme: theme.meta.id,
      variant: theme.meta.variant,
      source: this.lastSource,
      textScale: {
        wanted: this.deps.config().appearance.textScale.value ?? this.lastDesktopTextScale,
        toolkitAlreadyApplied: this.lastToolkitTextScale,
        zoom: next.textScale
      }
    })
    this.deps.onChange(next)
  }

  private payload(theme: Theme): ThemePayload {
    return {
      meta: theme.meta,
      cssVars: tokensToCssVars(effectiveTokens(theme.tokens, this.blurGranted)),
      blurGranted: this.blurGranted,
      // What we zoom by: the size wanted, less what Chromium's toolkit has
      // already applied (`toolkit-scale.ts`) - so a desktop that scales GTK text
      // and its shell together is followed once, not twice. Rounded so a
      // quantised gsettings factor beside an exact shell ratio (1.1818 vs
      // 1.1667 on Omarchy at 14px) reads as "the same size" rather than as a
      // 0.99 zoom that blurs every glyph for nothing.
      textScale: nearOne(
        (this.deps.config().appearance.textScale.value ?? this.lastDesktopTextScale) / this.lastToolkitTextScale
      )
    }
  }

  private resolve(signal: AppearanceSignal | null): Theme {
    const forced = this.deps.config().appearance.theme.value
    if (forced !== null) {
      const seed = this.findNamedTheme(forced)
      if (seed !== null) {
        this.lastSource = `${this.deps.config().appearance.theme.origin} = "${forced}"`
        return this.finish(resolveTheme(seed))
      }
      // Warned every time it is resolved, not once at startup: the user may fix
      // the name in `config.toml` while the daemon is running, and the message is
      // the only feedback that they have not yet.
      this.deps.logger.warn('forced theme not found; falling through the chain', { theme: forced })
    }

    // A desktop that does not want us following it is honoured here rather than
    // by not watching — the watch stays live so flipping the setting back applies
    // immediately.
    if (signal !== null && this.deps.config().appearance.followSystem.value) {
      if (signal.seed !== undefined) {
        this.lastSource = signal.source
        return this.finish(resolveTheme(signal.seed))
      }

      // Preference-only source: choose one of our bases and tint it. Which base
      // is the desktop's call, not ours — GNOME asks for Adwaita so a GNOME user
      // gets GNOME's greys instead of our purple-blue in the middle of their
      // desktop. Only colour follows; spacing and type stay ours.
      const base = baseSeed(signal.preferBase, signal.variant ?? 'dark')
      this.lastSource = signal.source
      return this.finish(
        resolveTheme(
          signal.accent === undefined
            ? base
            : { ...base, colours: { ...base.colours, accent: signal.accent } }
        )
      )
    }

    this.lastSource = 'built-in default'
    return this.finish(defaultTheme())
  }

  /**
   * Apply the settings that override whatever the theme said.
   *
   * `[appearance].animations = false` is a user instruction, not a suggestion,
   * and it ORs together with the theme's own flag and with
   * `prefers-reduced-motion` (which the renderer applies in CSS). Somebody who
   * turned motion off must not have it turned back on by switching themes.
   */
  private finish(theme: Theme): Theme {
    if (this.deps.config().appearance.animations.value) return theme
    return { ...theme, tokens: { ...theme.tokens, animations: false } }
  }

  /** A built-in pack, or a `lumanin.toml` under `~/.config/lumanin/themes/<name>/`. */
  private findNamedTheme(name: string): ThemeSeed | null {
    const builtin = builtinSeed(name)
    if (builtin !== null) return builtin

    // Rejected rather than sanitised: a theme name is a directory name, and the
    // only safe response to `../../..` in one is to refuse it.
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) return null

    const file = join(this.deps.configDir, 'themes', name, THEME_FILE_BASENAME)
    try {
      return parseThemePack(readFileSync(file, 'utf8'), name)
    } catch {
      return null
    }
  }

  /**
   * Watch the user's own theme directory so editing a pack applies live — the
   * same courtesy the Omarchy watch extends to theme authors.
   */
  private watchConfigDir(): void {
    const dir = join(this.deps.configDir, 'themes')
    if (!existsSync(dir)) return

    let timer: ReturnType<typeof setTimeout> | null = null
    let watcher: FSWatcher | null = null
    try {
      watcher = watch(dir, { recursive: true, persistent: false }, () => {
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(() => void this.refresh('theme pack changed'), 120)
      })
      watcher.on('error', () => undefined)
    } catch {
      // Recursive watching is not available everywhere; losing it costs a live
      // reload, not correctness.
      return
    }

    this.disposers.push(() => {
      if (timer !== null) clearTimeout(timer)
      watcher?.close()
    })
  }
}
