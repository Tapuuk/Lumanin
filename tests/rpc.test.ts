import { describe, expect, it, vi } from 'vitest'
import { createPeer, RpcError, RPC_ERRORS, toErrorBody, type RpcMessage } from '../src/node/rpc'

/**
 * The JSON-RPC peer.
 *
 * Three real transports use this and none of them are easy to stand up in a
 * test — a utilityProcess, a worker thread, and a pair of them at once. Writing
 * it against an abstract `send` is what makes the routing, the allow-list and
 * the failure paths testable at all, so this suite is the reason that seam
 * exists rather than a consequence of it.
 */

/** Two peers wired to each other, delivering messages synchronously. */
function pair(
  aMethods: Record<string, (params: unknown) => unknown>,
  bMethods: Record<string, (params: unknown) => unknown> = {}
): {
  a: ReturnType<typeof createPeer>
  b: ReturnType<typeof createPeer>
  notifications: { method: string; params: unknown }[]
} {
  const notifications: { method: string; params: unknown }[] = []

  const a = createPeer({
    send: (message) => {
      queueMicrotask(() => b.handle(message))
    },
    methods: aMethods
  })

  const b = createPeer({
    send: (message) => {
      queueMicrotask(() => a.handle(message))
    },
    methods: bMethods,
    onNotification: (method, params) => notifications.push({ method, params })
  })

  return { a, b, notifications }
}

describe('the JSON-RPC peer', () => {
  it('calls a registered method and resolves with its result', async () => {
    const { b } = pair({ add: (params) => (params as { n: number }).n + 1 })
    await expect(b.call('add', { n: 41 })).resolves.toBe(42)
  })

  it('answers an unregistered method with METHOD_NOT_FOUND rather than crashing', async () => {
    const { b } = pair({ known: () => 'ok' })
    await expect(b.call('unknown')).rejects.toMatchObject({ code: RPC_ERRORS.METHOD_NOT_FOUND })
  })

  /**
   * The allow-list is the point, not an implementation detail: the far side of a
   * worker boundary is a stranger's code, and a router that dispatches by looking
   * a string up in whatever object it holds is one refactor from exposing
   * something it should not.
   */
  it('does not dispatch to inherited properties', async () => {
    const { b } = pair({ safe: () => 'ok' })
    await expect(b.call('toString')).rejects.toMatchObject({ code: RPC_ERRORS.METHOD_NOT_FOUND })
    await expect(b.call('constructor')).rejects.toMatchObject({
      code: RPC_ERRORS.METHOD_NOT_FOUND
    })
  })

  it('propagates a handler’s error message verbatim', async () => {
    const { b } = pair({
      explode: () => {
        throw new Error('the API key is missing')
      }
    })
    await expect(b.call('explode')).rejects.toThrow('the API key is missing')
  })

  it('preserves an RpcError’s code across the wire', async () => {
    const { b } = pair({
      refuse: () => {
        throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'needs a key')
      }
    })
    await expect(b.call('refuse')).rejects.toMatchObject({
      code: RPC_ERRORS.INVALID_PARAMS,
      message: 'needs a key'
    })
  })

  it('awaits an async handler', async () => {
    const { b } = pair({ slow: async () => Promise.resolve('eventually') })
    await expect(b.call('slow')).resolves.toBe('eventually')
  })

  it('delivers notifications without a reply', async () => {
    const { a, notifications } = pair({})
    a.notify('log', { message: 'hello' })
    await Promise.resolve()
    expect(notifications).toEqual([{ method: 'log', params: { message: 'hello' } }])
  })

  it('rejects every in-flight call when the peer goes away', async () => {
    const { b } = pair({ never: () => new Promise(() => {}) })
    const pending = b.call('never')
    expect(b.pending).toBe(1)
    b.dispose('the worker died')
    await expect(pending).rejects.toMatchObject({ code: RPC_ERRORS.DISCONNECTED })
  })

  it('times out a call that is never answered', async () => {
    vi.useFakeTimers()
    const peer = createPeer({ send: () => {}, methods: {}, timeoutMs: 50 })
    const pending = peer.call('quiet')
    vi.advanceTimersByTime(60)
    await expect(pending).rejects.toMatchObject({ code: RPC_ERRORS.TIMEOUT })
    vi.useRealTimers()
  })

  it('drops a malformed message instead of throwing', () => {
    const errors: string[] = []
    const peer = createPeer({
      send: () => {},
      methods: {},
      onError: (context) => errors.push(context)
    })

    expect(() => peer.handle(null)).not.toThrow()
    expect(() => peer.handle({ nonsense: true })).not.toThrow()
    expect(() => peer.handle({ jsonrpc: '1.0', id: 1, method: 'x' } as unknown as RpcMessage)).not.toThrow()
    expect(errors).toEqual(['handle', 'handle', 'handle'])
  })

  /**
   * A reply to a call that already timed out. It has to be ignored rather than
   * resolve something — the `Promise` it belonged to is settled, and settling it
   * again is silent in JavaScript, which is how a late answer becomes a result
   * nobody can trace.
   */
  it('ignores a reply to a call it has given up on', () => {
    const peer = createPeer({ send: () => {}, methods: {} })
    expect(() => peer.handle({ jsonrpc: '2.0', id: 999, result: 'late' })).not.toThrow()
  })

  it('turns a thrown value into an error body with the stack in data', () => {
    const body = toErrorBody(new TypeError('bad shape'))
    expect(body).toMatchObject({ code: RPC_ERRORS.INTERNAL, message: 'bad shape' })
    expect((body.data as { name: string }).name).toBe('TypeError')
  })

  it('never sends `undefined` as a result, which is not JSON', async () => {
    const sent: RpcMessage[] = []
    const peer = createPeer({ send: (message) => sent.push(message), methods: { nothing: () => undefined } })
    peer.handle({ jsonrpc: '2.0', id: 1, method: 'nothing' })
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 1, result: null }])
  })
})
