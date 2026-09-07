/**
 * When the extension host may be forked again after it died.
 *
 * Three rules, kept apart from the supervisor that applies them because the
 * supervisor imports Electron and so cannot be loaded by a test runner, while
 * every one of these is arithmetic that is easy to get subtly wrong. An
 * out-of-range read of the delay table would put `NaN` into the next-fork
 * deadline, and `now >= NaN` is false forever: every plugin launch for the rest
 * of the daemon's life would be refused.
 */

/** How long to wait before forking a host that died, per consecutive death. */
export const RESTART_DELAYS_MS: readonly [number, ...number[]] = [200, 1000, 5000]

/**
 * How long a host has to live for its death to count as a fresh incident.
 *
 * The counter is reset by uptime rather than by a successful probe. A host that
 * dies on every render would otherwise fork, answer a probe, reset to zero, die
 * and repeat at the shortest delay for good.
 */
export const HEALTHY_UPTIME_MS = 30_000

/** The delay for a given number of consecutive deaths, clamped into the table. */
export function restartDelay(restarts: number): number {
  const last = RESTART_DELAYS_MS.length - 1
  const index = Math.min(Math.max(Math.trunc(restarts), 0), last)
  // The clamp makes the fallback unreachable; it is there because an indexed
  // read of a tuple's tail is `number | undefined` to the compiler.
  return RESTART_DELAYS_MS[index] ?? RESTART_DELAYS_MS[0]
}

export function canFork(now: number, nextForkAt: number): boolean {
  return now >= nextForkAt
}

export function isNewIncident(livedMs: number): boolean {
  return livedMs >= HEALTHY_UPTIME_MS
}

/** The remaining wait, for a sentence a person reads. Rounded up so it never says zero. */
export function waitSeconds(now: number, nextForkAt: number): number {
  return Math.max(1, Math.ceil((nextForkAt - now) / 1000))
}
