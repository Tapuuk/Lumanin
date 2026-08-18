import type { ThemeSeed } from '../../shared/theme/derive'
import type { CapabilityReport } from '../capability'
import type { AppearanceSources } from '../probe/appearance'
import type { BinaryMap } from '../probe/binaries'
import type { Exec } from '../exec'
import { CosmicAppearance } from './cosmic'
import { GsettingsAppearance } from './gsettings'
import { GtkAppearance } from './gtk'
import { KdeAppearance } from './kde'
import { NiriAppearance } from './niri'
import { OmarchyAppearance } from './omarchy'
import { omarchyCurrentCandidates } from '../probe/appearance'
import { PortalAppearance } from './portal'

/**
 * The `appearance` capability: where the desktop says what
 * it wants to look like.
 *
 * Two shapes of answer, and the difference is the whole design:
 *
 *  - A **palette** — Omarchy's `colors.toml`, KDE's `kdeglobals`, a GTK
 *    stylesheet, a customised COSMIC background. Every token can be derived from
 *    it, and the result looks like *that theme*.
 *  - A **preference** — the portal's light/dark and accent, niri's focus ring.
 *    It selects and tints one of our own built-in bases.
 *
 * Both arrive as `AppearanceSignal`, so the theme engine has one code path and
 * never learns which kind of desktop produced it.
 *
 * **This capability is composed, not won.** Everywhere else in the platform layer
 * the first usable backend takes the capability and the rest are ignored, because
 * the rest are alternative ways of doing the same job. Here they are not: a niri
 * user's accent lives in `config.kdl` and their light/dark preference lives in
 * the portal, and a KDE user's palette is in `kdeglobals` while their *live
 * change signal* is on the bus. Picking one would mean discarding half of what
 * the desktop told us. So every usable backend is consulted, in priority order:
 * the first to produce a palette wins colour outright, and preferences fill in
 * only what no palette supplied. `doctor` still reports a single winner, because
 * "which one decided how this looks" remains a question with one answer.
 */

export interface AppearanceSignal {
  /** A complete palette, when the source has one. */
  readonly seed?: ThemeSeed
  /** The desktop's light/dark preference, when it expresses one. */
  readonly variant?: 'dark' | 'light'
  /** A system accent colour to tint a built-in base with. */
  readonly accent?: string
  /**
   * Which built-in base fits this desktop when only a preference is available —
   * `adwaita` on GNOME, so a GNOME user gets GNOME's greys rather than ours.
   * Only colours follow the desktop; our spacing, radius and typography stay
   * ours (the Glass exception follows the same rule, and the reasoning is
   * identical here).
   */
  readonly preferBase?: string
  /**
   * The desktop's text scale, `1` being its default size. Omarchy 4 expresses it
   * as the shell font's `base-size` over 12; GNOME as `text-scaling-factor`.
   * A launcher that ignores it is the one thing on the desktop that stayed small
   * when the user asked for bigger text.
   */
  readonly textScale?: number
  /** Where this came from, for `doctor` and for the log line on a theme swap. */
  readonly source: string
}

export interface AppearanceBackend {
  readonly id: string
  /**
   * Set by a backend that can report `textScale`. Once a palette has settled the
   * question of colour, only these are still consulted - the portal would be
   * spawned for an answer it cannot give otherwise.
   */
  readonly providesTextScale?: true
  /** `null` when the source exists but currently says nothing usable. */
  read(): Promise<AppearanceSignal | null>
  /**
   * Call `onChange` when the desktop's appearance changes. Returns a disposer.
   *
   * A backend that cannot observe changes returns a no-op disposer rather than
   * throwing — "this desktop cannot tell us" is a degraded capability, reported
   * at probe time, not a call-time failure.
   */
  watch(onChange: () => void): () => void
}

export interface AppearanceDeps {
  readonly exec: Exec
  readonly binaries: BinaryMap
  readonly sources: AppearanceSources
  readonly home: string
  readonly dataHome: string
  /**
   * Built-in base for preference-only sources. Passed in because choosing it
   * requires knowing which desktop this is, and that knowledge belongs to the
   * caller that already has the profile.
   */
  readonly preferBase?: string
}

class NoAppearance implements AppearanceBackend {
  readonly id = 'builtin-default'
  read(): Promise<AppearanceSignal | null> {
    return Promise.resolve(null)
  }
  watch(): () => void {
    return () => undefined
  }
}

/** Consults every usable source; see the class-level note on why. */
export class CompositeAppearance implements AppearanceBackend {
  readonly id: string

  constructor(private readonly backends: readonly AppearanceBackend[]) {
    this.id = backends[0]?.id ?? 'builtin-default'
  }

  async read(): Promise<AppearanceSignal | null> {
    // Sequential rather than concurrent on purpose: these are file reads and, for
    // the portal, subprocesses, and the common case answers on the first one. A
    // `Promise.all` would spawn `gdbus` on every Omarchy machine for a result
    // that is then thrown away.
    const answers: AppearanceSignal[] = []
    let seeded = false
    for (const backend of this.backends) {
      // A palette settles the question of colour; lower-priority sources can
      // still not contribute one. What they may still contribute is the text
      // scale, so after the palette only backends that have one are asked, and
      // only until one answers.
      if (seeded && backend.providesTextScale !== true) continue
      const signal = await backend.read().catch(() => null)
      if (signal !== null) answers.push(signal)
      if (signal?.seed !== undefined) seeded = true
      if (seeded && answers.some((answer) => answer.textScale !== undefined)) break
    }

    if (answers.length === 0) return null

    const withSeed = answers.find((answer) => answer.seed !== undefined)
    if (withSeed !== undefined) {
      if (withSeed.textScale !== undefined) return withSeed
      const scaled = answers.find((answer) => answer.textScale !== undefined)?.textScale
      return scaled === undefined ? withSeed : { ...withSeed, textScale: scaled }
    }

    // Preference-only: take each field from the highest-priority source that has
    // it. niri supplies an accent and nothing else; the portal underneath it
    // supplies the light/dark it does not know about.
    const merged: {
      variant?: 'dark' | 'light'
      accent?: string
      preferBase?: string
      textScale?: number
      source: string
    } = { source: answers.map((answer) => answer.source).join(' + ') }

    for (const answer of answers) {
      if (merged.variant === undefined && answer.variant !== undefined) merged.variant = answer.variant
      if (merged.accent === undefined && answer.accent !== undefined) merged.accent = answer.accent
      if (merged.preferBase === undefined && answer.preferBase !== undefined) {
        merged.preferBase = answer.preferBase
      }
      if (merged.textScale === undefined && answer.textScale !== undefined) merged.textScale = answer.textScale
    }

    return merged.variant === undefined && merged.accent === undefined && merged.textScale === undefined
      ? null
      : merged
  }

  watch(onChange: () => void): () => void {
    const disposers = this.backends.map((backend) => backend.watch(onChange))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }
}

function build(id: string, deps: AppearanceDeps): AppearanceBackend | null {
  const { sources, binaries } = deps

  switch (id) {
    case 'omarchy':
      return new OmarchyAppearance(
        sources.omarchy.currentDir ?? omarchyCurrentCandidates(sources.configHome, sources.stateHome)[0]!,
        sources.configHome
      )
    case 'kde-colors':
      return sources.kdeglobals === null ? null : new KdeAppearance(sources.kdeglobals)
    case 'cosmic':
      return sources.cosmicMode === null ? null : new CosmicAppearance(sources.cosmicMode)
    case 'gtk-css':
      return new GtkAppearance({
        exec: deps.exec,
        configHome: sources.configHome,
        home: deps.home,
        dataHome: deps.dataHome,
        gsettings: binaries.gsettings
      })
    case 'niri':
      return sources.niriConfig === null ? null : new NiriAppearance(sources.niriConfig)
    case 'portal-settings':
      return new PortalAppearance({
        exec: deps.exec,
        gdbus: binaries.gdbus,
        ...(deps.preferBase !== undefined ? { preferBase: deps.preferBase } : {})
      })
    case 'gsettings':
      return binaries.gsettings === null
        ? null
        : new GsettingsAppearance({
            exec: deps.exec,
            gsettings: binaries.gsettings,
            configHome: sources.configHome,
            ...(deps.preferBase !== undefined ? { preferBase: deps.preferBase } : {})
          })
    default:
      return null
  }
}

/**
 * Build every backend the probe found usable, in the chain's own order.
 *
 * Driven by the `CapabilityReport` rather than by re-deciding here, so what runs
 * is exactly what `doctor` printed — the report *is* the selection, which is the
 * property that keeps the two from drifting.
 */
export function createAppearance(report: CapabilityReport, deps: AppearanceDeps): AppearanceBackend {
  const usable = report.candidates
    // `PLANNED` means the probe passed but nothing exists to construct. Selecting
    // one would surface the failure at call time, which the capability contract
    // forbids.
    .filter((candidate) => candidate.usable && candidate.status !== 'PLANNED')
    .map((candidate) => build(candidate.id, deps))
    .filter((backend): backend is AppearanceBackend => backend !== null)

  return usable.length === 0 ? new NoAppearance() : new CompositeAppearance(usable)
}
