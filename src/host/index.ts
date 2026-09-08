import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { DESTROY_GRACE_MS, destroyDeadlineMs } from './drain'
import {
  APP_METHODS,
  HOST_METHODS,
  WORKER_METHODS,
  WORKER_NOTIFICATIONS,
  type EventParams,
  type HostPing,
  type SessionRef,
  type SessionSpec
} from '../shared/ext-protocol'
import {
  createPeer,
  RPC_ERRORS,
  RpcError,
  withDeadline,
  type RpcMessage,
  type RpcPeer
} from '../node/rpc'

/**
 * The extension host: the `utilityProcess` between main and the workers.
 *
 * It owns worker lifetimes and nothing else. Deliberately thin — every message
 * it forwards is one it could have handled, and each one it *did* handle would
 * be a second place where session state lives. What it adds is exactly two
 * things a worker cannot be trusted with: which session a message belongs to,
 * and the fact that a dead worker has to be reported as a failed session rather
 * than as silence.
 *
 * This process has `process.parentPort`, not `electron`. Importing Electron here
 * would resolve to a path string rather than the API, which fails in a way that
 * names nothing.
 */

const parent = process.parentPort

if (parent === undefined) {
  throw new Error('the extension host was started outside a utilityProcess')
}

const WORKER_PATH = join(__dirname, 'worker.js')
const MODULE_PATH = join(__dirname, 'lumanin.js')

/**
 * The per-worker memory ceiling.
 *
 * A hard limit, not a warning: an extension that allocates past it gets an OOM
 * inside its own isolate, which arrives here as an `error` event and becomes an
 * error card. Without it the same allocation takes down the host process and
 * every other extension with it.
 */
const WORKER_MEMORY_MB = 512

interface Session {
  readonly spec: SessionSpec
  readonly worker: Worker
  readonly peer: RpcPeer
  /** True once the session has been told to stop, so a death is not reported twice. */
  ended: boolean
  /** True while the worker reports an action handler still running. */
  busy: boolean
}

/** Sessions past their destroy that are waiting on an in-flight action. */
let draining = 0

const sessions = new Map<string, Session>()

/** A started worker, warm or still warming. */
interface PooledWorker {
  readonly worker: Worker
  readonly peer: RpcPeer
  /** True once the worker has said that React, the reconciler and the shim are loaded. */
  readonly ready: boolean
}

/** The worker held for the next launch. Warm once it has announced itself. */
let spare: PooledWorker | null = null

/**
 * How many spares may fail to start before the pool gives up.
 *
 * A worker that cannot start will not start on the fourth attempt either, and a
 * retry loop inside the host process is worse than a slow launch: nothing would
 * ever say why, and the failures would keep costing a thread each.
 */
const MAX_SPARE_FAILURES = 3

/** Long enough that a replacement is not spawned into whatever killed the last one. */
const SPARE_RETRY_MS = 200

/** Consecutive spares that died before they were used. Reset by any worker warming up. */
let spareFailures = 0

const host = createPeer({
  send: (message) => parent.postMessage(message),
  onError: (context, error) => report('debug', `host rpc ${context}: ${String(error)}`),
  methods: {
    [HOST_METHODS.PING]: (): HostPing => ({
      sessions: sessions.size,
      spare: spare === null ? 'none' : spare.ready ? 'ready' : 'warming',
      workers: live.size
    }),
    [HOST_METHODS.CREATE]: (params) => create(params as SessionSpec),
    [HOST_METHODS.EVENT]: (params) => forward(params as EventParams, WORKER_METHODS.EVENT),
    [HOST_METHODS.POP]: (params) => forward(params as SessionRef, WORKER_METHODS.POP),
    [HOST_METHODS.DESTROY]: (params) => destroy((params as SessionRef).sessionId),
    [HOST_METHODS.RELOAD]: (params) => reload(params as SessionRef)
  }
})

parent.on('message', (event: { data: RpcMessage }) => host.handle(event.data))

function report(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  host.notify(APP_METHODS.LOG, { sessionId: '', level, message })
}

// ---------------------------------------------------------------------------
// Workers.
// ---------------------------------------------------------------------------

/**
 * Every thread started here that has not been seen to exit.
 *
 * The count is reported on the ping, and it is the only place a worker that
 * outlived its session is visible: a session is dropped from {@link sessions}
 * before its worker is asked to stop, so that map reads the same whether the
 * thread went away or is still spinning.
 */
const live = new Set<Worker>()

/**
 * Start a worker and wire it to main.
 *
 * The worker's outbound calls are relayed rather than answered: a worker asking
 * for the clipboard is really the extension asking the desktop, and the desktop
 * is in main. Relaying keeps the round trip honest — the worker's promise
 * settles when main actually did the thing, not when the host said it would.
 */
function spawn(): PooledWorker {
  // No `env` here on purpose: a thread inherits a copy of this process's
  // environment, which is how the compiled-bytecode cache the daemon points us
  // at reaches the worker's own modules as well as ours.
  const worker = new Worker(WORKER_PATH, {
    workerData: { modulePath: MODULE_PATH },
    resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB },
    // An extension's stdout is its own business and must not interleave with the
    // daemon's; `captureConsole` in the worker routes `console` to the log, and
    // the two streams below catch anything written to the file descriptors
    // directly. Draining them is not optional: an undrained pipe fills up and
    // blocks the thread that wrote to it, which looks exactly like a hang.
    stdout: true,
    stderr: true
  })

  live.add(worker)
  // Its own handler rather than a line in the one below, which returns early for
  // any worker that is not the current spare; this deletion is unconditional.
  worker.on('exit', () => {
    live.delete(worker)
  })

  worker.stdout.on('data', (chunk: Buffer) => report('debug', chunk.toString().trimEnd()))
  worker.stderr.on('data', (chunk: Buffer) => report('warn', chunk.toString().trimEnd()))

  /**
   * The spare's own death, which nothing else was watching.
   *
   * A session's worker gets `error` and `exit` handlers when {@link create}
   * adopts it — but a spare is warmed *before* there is a session, and in that
   * window it had neither. Two things followed. A spare that failed to start at
   * all (a missing `lumanin.js`, an OOM while loading React) raised an `error`
   * event with no listener, which Node rethrows: the host process died and took
   * every running extension with it. And a spare that merely exited stayed in
   * the slot as a dead handle, so the next launch posted `create` to a thread
   * that was gone — and the worker peer has no call timeout by design, so that
   * launch never settled and the panel simply never opened.
   *
   * Both become "there is no spare", which is a state the pool already knows
   * how to be in. The guard is what makes this a *spare* handler: once adopted,
   * the session's own handlers own the failure.
   *
   * "There is no spare" used to be where it ended, and the pool was topped up
   * only when a session was closed: until somebody closed one, every launch
   * paid the cold path. So a replacement is scheduled here too, and a failure
   * that keeps repeating stops at {@link MAX_SPARE_FAILURES} with a line at
   * error level rather than spawning threads forever.
   */
  const forget = (why: string): void => {
    if (spare?.worker !== worker) return
    spare = null
    spareFailures += 1
    if (spareFailures >= MAX_SPARE_FAILURES) {
      report(
        'error',
        `the warm spare worker ${why}, ${spareFailures} times running; not warming another`
      )
      return
    }
    report('warn', `the warm spare worker ${why}`)
    topUpSpare(SPARE_RETRY_MS)
  }
  worker.on('error', (error: Error) => forget(`could not start: ${error.message}`))
  worker.on('exit', () => forget('exited before it was used'))

  let ready = false

  const peer = createPeer({
    send: (message) => worker.postMessage(message),
    onError: (context, error) => report('debug', `worker rpc ${context}: ${String(error)}`),
    methods: {},
    onNotification: (method, params) => {
      if (method === WORKER_NOTIFICATIONS.READY) {
        ready = true
        // A worker got all the way up in this process, so whatever the last
        // failures were, they were not "no worker can ever start here".
        spareFailures = 0
        report('debug', 'worker warm')
        return
      }
      if (method === WORKER_NOTIFICATIONS.BUSY) {
        // Recorded here so `destroy` knows which bound to wait on, then relayed
        // so main can keep a draining session addressable until it settles.
        const busy = params as { sessionId?: unknown; count?: unknown }
        const session = typeof busy.sessionId === 'string' ? sessions.get(busy.sessionId) : undefined
        if (session !== undefined) session.busy = typeof busy.count === 'number' && busy.count > 0
        host.notify(APP_METHODS.SESSION_BUSY, params)
        return
      }
      host.notify(method, params)
    },
    // A worker call is really a call on main, so it is relayed with main's own
    // answer — including main's error, which is what the extension should see.
    timeoutMs: 0
  })

  // Relaying requests needs a handler for *any* method, which the allow-list
  // deliberately does not provide. So requests are intercepted before the peer
  // sees them: anything with an id and a method is a service request for main.
  worker.on('message', (message: RpcMessage) => {
    if ('method' in message && 'id' in message) {
      relay(worker, message.id, message.method, message.params)
      return
    }
    peer.handle(message)
  })

  return {
    worker,
    peer,
    get ready(): boolean {
      return ready
    }
  }
}

/** Pass one worker request to main and post the answer back to that worker. */
function relay(worker: Worker, id: number, method: string, params: unknown): void {
  host
    .call(method, params)
    .then((result) => worker.postMessage({ jsonrpc: '2.0', id, result: result ?? null }))
    .catch((error: unknown) => {
      const body =
        error instanceof RpcError
          ? { code: error.code, message: error.message }
          : { code: RPC_ERRORS.INTERNAL, message: String(error) }
      worker.postMessage({ jsonrpc: '2.0', id, error: body })
    })
}

/**
 * Take the warm spare and start another one.
 *
 * The replacement is spawned *after* the current one is handed over, so the cost
 * of warming it lands while the user is looking at an extension that has already
 * started rendering rather than in front of the launch they just asked for.
 *
 * A spare that has not announced itself yet is handed over anyway: half warm
 * still beats cold, and the launch is about to await `session.create` regardless.
 */
function takeWarm(): PooledWorker {
  const taken = spare ?? spawn()
  spare = null
  topUpSpare()
  return taken
}

/**
 * Put a spare in place, unless there is one already or there should not be.
 *
 * The one place that decides it, because four callers want the same three
 * conditions, and a cap written out four times is a cap that ends up
 * forgotten in one of them. Always deferred through a timer, which also keeps
 * the spawn out of whatever awaited handler asked for it: the reply goes out
 * first and the thread starts after.
 */
function topUpSpare(delayMs = 0): void {
  if (spareFailures >= MAX_SPARE_FAILURES) return
  setTimeout(() => {
    if (spare === null && sessions.size < MAX_SESSIONS) spare = spawn()
  }, delayMs).unref?.()
}

/**
 * A ceiling on live sessions.
 *
 * Each is a v8 isolate with its own heap, so an unbounded number of them is an
 * unbounded amount of memory. Nothing in the UI opens more than a handful; a
 * number this high can only be reached by a bug, and hitting a stated limit is a
 * better failure than the machine swapping.
 */
const MAX_SESSIONS = 8

async function create(spec: SessionSpec): Promise<{ sessionId: string }> {
  if (sessions.has(spec.sessionId)) {
    throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `session ${spec.sessionId} already exists`)
  }
  if (sessions.size >= MAX_SESSIONS) {
    throw new RpcError(
      RPC_ERRORS.INTERNAL,
      `too many extension commands are running at once (${MAX_SESSIONS}). Close one and try again.`
    )
  }

  const { worker, peer } = takeWarm()
  const session: Session = { spec, worker, peer, ended: false, busy: false }
  sessions.set(spec.sessionId, session)

  worker.on('error', (error: Error) => died(session, error))
  worker.on('exit', (code) => {
    if (session.ended) return
    died(session, new Error(`the extension worker exited unexpectedly (code ${code})`))
  })

  try {
    await peer.call(WORKER_METHODS.CREATE, spec)
  } catch (error) {
    sessions.delete(spec.sessionId)
    session.ended = true
    void worker.terminate()
    throw error
  }

  return { sessionId: spec.sessionId }
}

/**
 * A worker that died, which is the case this whole layer exists for.
 *
 * Failure containment: an error card with the stack and a
 * Reload action, and the session garbage-collected. The alternative — a session
 * that simply stops answering — leaves the panel showing the last frame the
 * extension rendered, indistinguishable from one that is merely slow.
 */
function died(session: Session, error: Error): void {
  if (session.ended) return
  session.ended = true
  sessions.delete(session.spec.sessionId)
  session.peer.dispose('the extension worker died')

  host.notify(APP_METHODS.SESSION_FAILED, {
    sessionId: session.spec.sessionId,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    fatal: true
  })

  // A session dying at the session ceiling was the one path that left the pool
  // empty: the replacement `takeWarm` scheduled declined while the map was
  // full, and only a deliberate close ever tried again.
  topUpSpare()
}

async function forward(params: SessionRef, method: string): Promise<null> {
  const session = sessions.get(params.sessionId)
  if (session === undefined) {
    // Not an error worth propagating: the user pressed something a frame after
    // the session ended, which is a race the UI cannot avoid and does not care
    // about.
    return null
  }
  await session.peer.call(method, params)
  return null
}

async function destroy(sessionId: string): Promise<null> {
  const session = sessions.get(sessionId)
  if (session === undefined) return null

  session.ended = true
  sessions.delete(sessionId)

  // A busy worker gets the action ceiling, an idle one the idle bound; either
  // way the thread is stopped at the deadline, which is PLAN-053's rule.
  const deadline = destroyDeadlineMs({ busy: session.busy, draining })
  const isDraining = deadline !== DESTROY_GRACE_MS
  if (isDraining) draining += 1
  try {
    const answered = await withDeadline(
      session.peer.call(WORKER_METHODS.DESTROY, { sessionId }).then(() => true),
      deadline,
      false
    )
    if (!answered) {
      report('warn', `session ${sessionId} did not stop within ${String(deadline)}ms; terminating`)
    }
  } catch {
    // The worker may already be gone, which is the outcome we wanted anyway.
  } finally {
    if (isDraining) draining -= 1
  }
  session.peer.dispose('the session ended')
  // Not awaited, for the same reason the deadline above exists: nothing waits on
  // this reply, and a second unbounded wait would undo the first one's bound.
  void session.worker.terminate()

  // A worker is never reused for a second command — its shim is now full of the
  // last command's state — so the pool is topped up instead.
  topUpSpare()
  return null
}

/**
 * `lumanin ext dev` rebuilt the bundle: throw the isolate away and start again.
 *
 * A fresh worker rather than re-requiring the entry, because Node's module cache
 * would hand back the old bundle and the reload would look like it had no
 * effect — the single most confusing thing a hot reload can do.
 */
async function reload(params: SessionRef): Promise<null> {
  const session = sessions.get(params.sessionId)
  if (session === undefined) return null
  const { spec } = session
  await destroy(params.sessionId)
  await create(spec)
  return null
}

// Warm one up immediately: the first extension launch of a session is the one
// most likely to feel slow, and it is the one a lazy pool would not cover.
spare = spawn()
report('debug', 'extension host ready')
