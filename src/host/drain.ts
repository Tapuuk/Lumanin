import { ACTION_DRAIN_CEILING_MS } from '../shared/ext-protocol'

/**
 * How long a worker gets to acknowledge that its session is over.
 *
 * A worker that has not answered by then is not going to: the thread is inside a
 * loop of the extension's own making, and the call it was sent is queued behind
 * work that never yields. Waiting on it is what leaked a spinning thread and its
 * heap ceiling per launch, so the wait is bounded and the thread is stopped
 * either way.
 */
export const DESTROY_GRACE_MS = 1500

/**
 * How many sessions may be draining an action at once. `destroy()` removes a
 * session from the host's map before it waits, so the session cap cannot see a
 * draining thread; past this many, a busy session gets the idle bound instead.
 */
export const MAX_DRAINING = 4

/** The deadline a destroy waits on: the idle bound, or the action ceiling for a busy worker. */
export function destroyDeadlineMs(state: { readonly busy: boolean; readonly draining: number }): number {
  if (!state.busy) return DESTROY_GRACE_MS
  return state.draining >= MAX_DRAINING ? DESTROY_GRACE_MS : ACTION_DRAIN_CEILING_MS
}
