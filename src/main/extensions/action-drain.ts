/**
 * How long a headless action keeps its worker after it was dispatched.
 *
 * A dispatch is fire-and-forget, so the only signals are the session ending
 * itself and the worker reporting whether a handler is still running. The wait
 * returns the moment the session is gone and nothing is running; it waits at
 * least the floor for a handler that has not reported yet (busy can arrive a
 * tick after the dispatch); and it gives up at the ceiling, which is the one
 * stated bound on a started action.
 */
export interface ReleaseDeps {
  /** The session has ended on its own (`popToRoot`, a finished command). */
  readonly gone: () => boolean
  /** The worker reports an action handler still running. */
  readonly busy: () => boolean
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

export type ReleaseOutcome = 'released' | 'floor' | 'ceiling'

export async function waitForRelease(
  deps: ReleaseDeps,
  bounds: { readonly floorMs: number; readonly ceilingMs: number; readonly tickMs?: number }
): Promise<ReleaseOutcome> {
  const started = deps.now()
  const tick = bounds.tickMs ?? 100
  for (;;) {
    const busy = deps.busy()
    if (deps.gone() && !busy) return 'released'
    const elapsed = deps.now() - started
    if (elapsed >= bounds.ceilingMs) return 'ceiling'
    if (elapsed >= bounds.floorMs && !busy) return 'floor'
    await deps.sleep(tick)
  }
}
