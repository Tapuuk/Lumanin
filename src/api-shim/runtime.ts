import type { SessionSpec } from '../shared/ext-protocol'

/**
 * The seam between the shim and the worker that hosts it.
 *
 * The shim is `@raycast/api` as far as an extension is concerned: it is loaded
 * through the worker's module-resolution hook, exactly once, and every call it
 * makes to the desktop goes through this object. Keeping that as an injected
 * interface rather than a direct import of the worker is what lets the whole
 * surface be unit-tested with a fake — no thread, no utilityProcess, no Electron.
 *
 * Installed by the worker before the extension's bundle is loaded, so nothing an
 * extension can do runs before it exists.
 */
export interface ShimRuntime {
  readonly spec: SessionSpec
  /** A request that expects an answer — clipboard reads, storage, alerts. */
  call<T>(method: string, params?: unknown): Promise<T>
  /** Fire and forget — logs, HUDs, render patches. */
  notify(method: string, params?: unknown): void
  /**
   * Register a callback the renderer can name later. Passing `null` forgets it,
   * which is what unmounting a node does to its handlers.
   */
  setHandler(id: string, handler: HandlerFn | null): string
  /** An id for a handler with no node to hang off — a toast action, say. */
  nextHandlerId(): string
  /** Ask for another render pass. Used by the imperative APIs that mutate state. */
  scheduleRender(): void
}

export type HandlerFn = (payload: unknown) => void

let runtime: ShimRuntime | null = null

/** Called by the worker, once, before the extension is loaded. */
export function installRuntime(next: ShimRuntime): void {
  runtime = next
}

/**
 * The runtime, or a clear error.
 *
 * The failure this guards against is real and otherwise baffling: an extension
 * bundle that was built for Node and is being required from a plain script (a
 * test, a `node -e`) reaches this and would otherwise get `undefined.call` — a
 * TypeError naming none of the actual problem.
 */
export function requireRuntime(): ShimRuntime {
  if (runtime === null) {
    throw new Error(
      'the Lumanin API was used outside an extension worker - an extension bundle can only run inside the extension host'
    )
  }
  return runtime
}

/** Whether the shim is live. Only the shim's own guards should need this. */
export function hasRuntime(): boolean {
  return runtime !== null
}
