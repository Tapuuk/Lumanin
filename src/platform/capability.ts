import type { PlatformProfile } from './detect'
import { describePlatform } from './detect'

/**
 * The capability/backend framework (PLATFORM-MATRIX §"Capability → backend priority").
 *
 * Rules this encodes, all of them from CLAUDE.md or PLATFORM-MATRIX:
 *
 *  - **Backends are selected by capability, not by desktop name.** A backend's
 *    `probe` may read the profile's protocol/binary/D-Bus findings; DE booleans
 *    are tiebreakers, and only `detect.ts` is allowed to know DE names at all.
 *  - **First backend whose probe passes wins**, and the choice is reportable.
 *  - **Every backend either works or reports why at probe time, never at call
 *    time.** A capability with no viable backend is UNSUPPORTED with a reason.
 *  - **Backends we cannot test here are UNVERIFIED, not OK.** The dev machine is
 *    Arch + Hyprland; KDE/GNOME/X11 paths are written against documentation and
 *    stay labelled until a human confirms them in a VM (see TESTING.md).
 */

export const CAPABILITIES = [
  'hotkey',
  'windowPlacement',
  'clipboard',
  'paste',
  'selection',
  'windows',
  'apps',
  'files',
  'appearance',
  'tray',
  'windowEffects',
  'autostart'
] as const

export type Capability = (typeof CAPABILITIES)[number]

/**
 * `PLANNED` is separate from `UNSUPPORTED` on purpose. "Your machine cannot do
 * this" and "we have not written it yet" are different answers to the user, and
 * collapsing them means `doctor` claims a platform limitation whenever we are
 * simply behind — the exact dishonesty the UNVERIFIED label exists to prevent.
 */
export type Status = 'OK' | 'DEGRADED' | 'UNSUPPORTED' | 'UNVERIFIED' | 'PLANNED'

export interface ProbeVerdict {
  /** Whether this backend can be used at all on this machine. */
  readonly usable: boolean
  /**
   * Set when the backend works but not fully — a portal bind that may need
   * re-requesting, a poll-based fallback instead of real change events.
   */
  readonly degraded?: boolean
  /** Why it is unusable or degraded, phrased for a user reading `doctor`. */
  readonly detail: string
}

export interface Backend {
  readonly id: string
  /** One line describing the mechanism, shown by `doctor`. */
  readonly summary: string
  /**
   * Platform labels (`describePlatform`) this backend has actually been observed
   * working on. Anything else reports UNVERIFIED even when its probe passes.
   * Empty means "never verified anywhere yet".
   */
  readonly verifiedOn: readonly string[]
  /**
   * Whether an implementation exists behind this id. Defaults to true.
   *
   * A backend whose probe passes but which nothing can construct is worse than
   * one that is absent: selection would hand the runtime an id it cannot build,
   * and the failure would surface at call time — which the rule above forbids.
   * Marked backends are skipped by selection and reported as `PLANNED`, so the
   * chain falls through to something that actually runs.
   */
  readonly implemented?: boolean
  probe(profile: PlatformProfile): ProbeVerdict
}

export interface BackendReport {
  readonly id: string
  readonly summary: string
  readonly usable: boolean
  readonly status: Status
  readonly detail: string
}

export interface CapabilityReport {
  readonly capability: Capability
  /** `null` when nothing is viable. */
  readonly chosen: string | null
  readonly status: Status
  readonly detail: string
  /** Every candidate in priority order, so `doctor --json` shows the full chain. */
  readonly candidates: readonly BackendReport[]
}

function statusFor(backend: Backend, verdict: ProbeVerdict, platform: string): Status {
  if (!verdict.usable) return 'UNSUPPORTED'
  // Checked before the verified/degraded distinction: whether we have written it
  // yet is a stronger fact than how well it would work if we had.
  if (backend.implemented === false) return 'PLANNED'
  if (!backend.verifiedOn.includes(platform)) return 'UNVERIFIED'
  return verdict.degraded === true ? 'DEGRADED' : 'OK'
}

/**
 * Evaluate a capability's backends in priority order and pick the first usable
 * one. Every candidate is still reported: "why did it not pick the one I wanted"
 * is the question `doctor` exists to answer.
 */
export function selectBackend(
  capability: Capability,
  backends: readonly Backend[],
  profile: PlatformProfile
): CapabilityReport {
  const platform = describePlatform(profile)
  const candidates: BackendReport[] = []
  let chosen: BackendReport | null = null

  for (const backend of backends) {
    const verdict = backend.probe(profile)
    const report: BackendReport = {
      id: backend.id,
      summary: backend.summary,
      usable: verdict.usable,
      status: statusFor(backend, verdict, platform),
      detail: verdict.detail
    }
    candidates.push(report)
    if (chosen === null && verdict.usable && backend.implemented !== false) chosen = report
  }

  if (chosen === null) {
    const planned = candidates.filter((c) => c.status === 'PLANNED')
    return {
      capability,
      chosen: null,
      // Nothing runs either way, but the reason matters: a capability waiting on
      // us must not be reported as one the machine cannot support.
      status: planned.length > 0 ? 'PLANNED' : 'UNSUPPORTED',
      detail:
        candidates.length === 0
          ? 'no backends are defined for this capability yet'
          : planned.length > 0
            ? `this machine can support ${planned.map((c) => c.id).join(', ')}, but it is not implemented yet`
            : `no usable backend: ${candidates.map((c) => `${c.id} (${c.detail})`).join('; ')}`,
      candidates
    }
  }

  return {
    capability,
    chosen: chosen.id,
    status: chosen.status,
    detail: chosen.detail,
    candidates
  }
}
