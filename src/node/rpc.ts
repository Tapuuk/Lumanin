/**
 * JSON-RPC 2.0 over any message-passing transport.
 *
 * In `node/` rather than `shared/`, and that is not filing: it schedules with
 * `setTimeout().unref()` and types its handles as `NodeJS.Timeout`, and `shared/`
 * is compiled by `tsconfig.web.json` where a Node type is a build error by
 * design. Nothing in the renderer speaks JSON-RPC anyway — it talks to main over
 * the preload bridge, and main holds both ends of this.
 *
 * Three hops use this: main ↔ extension host (`utilityProcess.postMessage`),
 * host ↔ worker (`worker_threads` parentPort), and — in tests — two peers over a
 * pair of arrays. Writing it once against an abstract `send` is what makes those
 * testable without an Electron window or a real thread.
 *
 * **Only registered methods.** This is a rule rather than a
 * default, and the reason is the same one behind the socket's verb allow-list:
 * the code on the far side of a worker boundary is a stranger's, and a router
 * that dispatches by looking a string up in the object it happens to be holding
 * is one refactor away from exposing something it should not.
 */

export const RPC_VERSION = '2.0'

export interface RpcRequest {
  readonly jsonrpc: typeof RPC_VERSION
  readonly id: number
  readonly method: string
  readonly params?: unknown
}

export interface RpcNotification {
  readonly jsonrpc: typeof RPC_VERSION
  readonly method: string
  readonly params?: unknown
}

export interface RpcSuccess {
  readonly jsonrpc: typeof RPC_VERSION
  readonly id: number
  readonly result: unknown
}

export interface RpcFailure {
  readonly jsonrpc: typeof RPC_VERSION
  readonly id: number
  readonly error: RpcErrorBody
}

export interface RpcErrorBody {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export type RpcMessage = RpcRequest | RpcNotification | RpcSuccess | RpcFailure

/** The subset of JSON-RPC's reserved range we actually produce. */
export const RPC_ERRORS = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** Application range: the peer went away before it answered. */
  DISCONNECTED: -32000,
  TIMEOUT: -32001
} as const

/** An error carrying a JSON-RPC code, so a caller can tell "unsupported" from "crashed". */
export class RpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

export type RpcHandler = (params: unknown) => unknown | Promise<unknown>
export type RpcMethods = Readonly<Record<string, RpcHandler>>

export interface PeerOptions {
  /** Hand one message to the transport. Must not throw for a dead transport — return quietly. */
  readonly send: (message: RpcMessage) => void
  /** The allow-list. A method that is not a key here is answered `METHOD_NOT_FOUND`. */
  readonly methods: RpcMethods
  /** Notifications (no id, no reply). Unknown ones are dropped, not answered. */
  readonly onNotification?: (method: string, params: unknown) => void
  /** How long an outbound call waits. `0` disables the timer. */
  readonly timeoutMs?: number
  readonly onError?: (context: string, error: unknown) => void
}

export interface RpcPeer {
  /** Feed one inbound message. Anything malformed is reported and dropped. */
  handle(message: unknown): void
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  notify(method: string, params?: unknown): void
  /** Reject every in-flight call. Called when the transport dies. */
  dispose(reason?: string): void
  /** In-flight call count — used by tests and by the host's idle check. */
  readonly pending: number
}

const DEFAULT_TIMEOUT_MS = 30_000

interface Waiting {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout | null
}

export function createPeer(options: PeerOptions): RpcPeer {
  const waiting = new Map<number, Waiting>()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let nextId = 1
  let disposed = false

  const report = (context: string, error: unknown): void => options.onError?.(context, error)

  function settle(id: number, settleWith: (w: Waiting) => void): void {
    const pending = waiting.get(id)
    if (pending === undefined) return // A late reply to a call we already gave up on.
    waiting.delete(id)
    if (pending.timer !== null) clearTimeout(pending.timer)
    settleWith(pending)
  }

  function reply(message: RpcMessage): void {
    try {
      options.send(message)
    } catch (error) {
      // A send that throws is a dead transport, which `dispose` handles. It must
      // not propagate into whichever handler happened to be finishing.
      report('send', error)
    }
  }

  async function dispatch(request: RpcRequest): Promise<void> {
    const handler = Object.hasOwn(options.methods, request.method)
      ? options.methods[request.method]
      : undefined

    if (handler === undefined) {
      reply({
        jsonrpc: RPC_VERSION,
        id: request.id,
        error: { code: RPC_ERRORS.METHOD_NOT_FOUND, message: `unknown method: ${request.method}` }
      })
      return
    }

    try {
      const result = await handler(request.params)
      // `undefined` is not JSON, and a result field is required on success.
      reply({ jsonrpc: RPC_VERSION, id: request.id, result: result === undefined ? null : result })
    } catch (error) {
      reply({
        jsonrpc: RPC_VERSION,
        id: request.id,
        error: toErrorBody(error)
      })
    }
  }

  return {
    get pending(): number {
      return waiting.size
    },

    handle(message: unknown): void {
      if (!isMessage(message)) {
        report('handle', new Error('malformed JSON-RPC message'))
        return
      }

      if ('method' in message) {
        if ('id' in message) {
          void dispatch(message)
          return
        }
        try {
          options.onNotification?.(message.method, message.params)
        } catch (error) {
          report(`notification:${message.method}`, error)
        }
        return
      }

      if ('error' in message) {
        const body = message.error
        settle(message.id, (w) => w.reject(new RpcError(body.code, body.message, body.data)))
        return
      }
      settle(message.id, (w) => w.resolve(message.result))
    },

    call<T>(method: string, params?: unknown): Promise<T> {
      if (disposed) {
        return Promise.reject(new RpcError(RPC_ERRORS.DISCONNECTED, 'the peer is gone'))
      }

      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                settle(id, (w) =>
                  w.reject(new RpcError(RPC_ERRORS.TIMEOUT, `${method} did not answer in ${timeoutMs}ms`))
                )
              }, timeoutMs)
            : null
        timer?.unref?.()

        waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
        reply({ jsonrpc: RPC_VERSION, id, method, ...(params === undefined ? {} : { params }) })
      })
    },

    notify(method: string, params?: unknown): void {
      if (disposed) return
      reply({ jsonrpc: RPC_VERSION, method, ...(params === undefined ? {} : { params }) })
    },

    dispose(reason = 'the peer is gone'): void {
      disposed = true
      for (const id of [...waiting.keys()]) {
        settle(id, (w) => w.reject(new RpcError(RPC_ERRORS.DISCONNECTED, reason)))
      }
    }
  }
}

/**
 * Give a promise a deadline, and a value to settle with when it passes.
 *
 * Two hops build their peer with `timeoutMs: 0` on purpose — a relayed call has
 * to carry the far side's own answer, however long that takes, and an extension
 * may legitimately sit in a confirmation dialog for minutes. So the bound
 * belongs to the caller that actually needs one, and this is where it lives:
 * next to the peer whose missing timeout is the reason it is needed.
 *
 * Racing rather than ignoring is the important part. `Promise.race` attaches
 * handlers to `work`, so a failure that arrives *after* the deadline is already
 * handled and cannot become an unhandled rejection — which, in a process with no
 * `unhandledRejection` listener, would take every extension down with it.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms)
    timer.unref?.()
  })
  return Promise.race([work, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * Turn a thrown value into a wire error.
 *
 * The message is preserved verbatim because it is the only thing the user will
 * see when an extension fails, and a generic "internal error" turns a fixable
 * mistake into a mystery. The stack rides along in `data` for the log and the
 * error card — it never reaches a toast.
 */
export function toErrorBody(error: unknown): RpcErrorBody {
  if (error instanceof RpcError) {
    return { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
  }
  if (error instanceof Error) {
    return {
      code: RPC_ERRORS.INTERNAL,
      message: error.message.length > 0 ? error.message : error.name,
      data: { name: error.name, stack: error.stack ?? null }
    }
  }
  return { code: RPC_ERRORS.INTERNAL, message: String(error) }
}

function isMessage(value: unknown): value is RpcMessage {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (candidate['jsonrpc'] !== RPC_VERSION) return false

  if (typeof candidate['method'] === 'string') {
    return candidate['id'] === undefined || typeof candidate['id'] === 'number'
  }
  if (typeof candidate['id'] !== 'number') return false
  if ('error' in candidate) {
    const body = candidate['error'] as Record<string, unknown> | null
    return typeof body === 'object' && body !== null && typeof body['code'] === 'number' && typeof body['message'] === 'string'
  }
  return 'result' in candidate
}
