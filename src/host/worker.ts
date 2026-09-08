import Module from 'node:module'
import { createElement, type FunctionComponent, type ReactNode } from 'react'
import { parentPort, workerData } from 'node:worker_threads'
import { compare } from 'fast-json-patch'
import {
  APP_METHODS,
  WORKER_METHODS,
  WORKER_NOTIFICATIONS,
  type EventParams,
  type SessionSpec,
  ACTION_DRAIN_CEILING_MS
} from '../shared/ext-protocol'
import { createPeer, toErrorBody, type RpcMessage } from '../node/rpc'
import { emptyTree, isDateRef, type RenderNode } from '../shared/render-tree'
import { createRenderer, type Renderer } from './reconciler'
import { handlerId, serializeTree, type Instance } from './tree'
import type { HandlerFn, ShimRuntime } from '../api-shim/runtime'

/**
 * One command, in one v8 isolate.
 *
 * Be blunt about what this is and is not: a Worker is a **fault**
 * boundary, not a security one. The extension gets full Node — filesystem,
 * network, `child_process` — and what the isolate buys is that its crash, its
 * infinite loop and its 600 MB array take down one command instead of the
 * launcher.
 *
 * **One worker per command, not per extension** — a deliberate departure from
 * the original design, for a reason that only shows up once the shim exists. Half
 * the API surface is module-level state that belongs to *one* running command:
 * `environment.commandName`, the navigation stack, and the legacy `render()`
 * root. Two commands sharing an isolate would mean every one of those has to
 * resolve which command is asking — and since extension code awaits, that means
 * threading an async context through third-party promise chains we do not
 * control. Getting it wrong is not a crash; it is command A reading command B's
 * preferences.
 *
 * What the shared isolate was for — a warm start — is bought instead by the host
 * keeping a **spare worker** that has already loaded React, the reconciler and
 * the shim and is waiting for a command (see `index.ts`). That is warmer than
 * module-cache reuse would have been, since it also covers the first launch.
 *
 * The order of operations is the part that has to be exactly right: the module
 * hook is installed and the shim is loaded *before any message arrives*, and the
 * extension's own bundle is required only when a session starts. Nothing an
 * extension can do runs before the environment it runs in exists.
 */

interface WorkerBoot {
  /** Absolute path to the built `lumanin` module — the plugin API. */
  readonly modulePath: string
}

const boot = workerData as WorkerBoot
const port = parentPort

if (port === null) {
  throw new Error('the extension worker was started outside a worker thread')
}

// ---------------------------------------------------------------------------
// Module resolution: what an extension's `require` actually finds.
// ---------------------------------------------------------------------------

type ShimModule = typeof import('../api-shim/lumanin')

/**
 * The modules an extension must never bring its own copy of.
 *
 * `react` is the load-bearing one (the single-React-copy
 * rule): `react-reconciler@0.33` peers on `^19.2.0`, so a bundle that inlined
 * its own React would leave two copies in this isolate — and two copies of
 * React means hooks resolve against the wrong dispatcher and fail with
 * "invalid hook call", an error that names nothing about the actual cause.
 * `lumanin` is redirected because the module a plugin imports *is* this app's
 * api-shim; there is nothing else it could resolve to.
 *
 * The extension build marks all of these `external`; this hook is the other
 * half of that bargain, and it is what makes the guarantee hold even for a
 * prebuilt bundle we did not compile.
 */
const REDIRECTS = new Map<string, string>()

function installModuleHook(modulePath: string): void {
  REDIRECTS.set('lumanin', modulePath)
  for (const specifier of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom']) {
    REDIRECTS.set(specifier, require.resolve(specifier))
  }

  const internals = Module as unknown as {
    _resolveFilename(request: string, parent: unknown, isMain: boolean, options?: unknown): string
  }
  const original = internals._resolveFilename.bind(internals)

  internals._resolveFilename = (request, parent, isMain, options): string => {
    const redirect = REDIRECTS.get(request)
    if (redirect !== undefined) return redirect

    return original(request, parent, isMain, options)
  }
}

// ---------------------------------------------------------------------------
// Session state.
// ---------------------------------------------------------------------------

/**
 * Callbacks the renderer can name.
 *
 * Two maps rather than one, because they have different lifetimes. A tree
 * handler belongs to a node and dies with it — which is decided by looking at
 * what the last commit contained, not by a lifecycle callback. A detached one
 * (a toast action) belongs to an object the extension holds, and is freed when
 * that object says so. Keeping them in one map meant deciding ownership by
 * looking at the shape of the id, which is the kind of rule that is true until
 * someone renames something.
 */
const treeHandlers = new Map<string, HandlerFn>()
const detachedHandlers = new Map<string, HandlerFn>()
let handlerCounter = 0
let spec: SessionSpec | null = null
let renderer: Renderer | null = null
let shim: ShimModule | null = null
let commandElement: ReactNode = null
let previous: RenderNode = emptyTree()
let revision = 0
/** Set while a commit is being serialized, so a re-entrant render cannot interleave. */
let committing = false

const peer = createPeer({
  send: (message) => port.postMessage(message),
  onError: (context, error) => log('error', `worker rpc ${context}: ${describe(error)}`),
  methods: {
    [WORKER_METHODS.CREATE]: (params) => start(params as SessionSpec),
    [WORKER_METHODS.EVENT]: (params) => dispatch(params as EventParams),
    [WORKER_METHODS.POP]: () => {
      shim?.__lumaninInternals.popNavigation()
      return null
    },
    [WORKER_METHODS.DESTROY]: () => {
      // Nothing in flight: answered synchronously, as before. A started action
      // is awaited up to the ceiling first, so a hide or a headless dispatch
      // does not cut off work the user asked for.
      if (inFlight.size === 0) {
        teardown()
        return null
      }
      return drainThenTeardown()
    }
  }
})

port.on('message', (message: RpcMessage) => peer.handle(message))

const runtime: ShimRuntime = {
  get spec(): SessionSpec {
    if (spec === null) throw new Error('the extension session has not started')
    return spec
  },
  call: <T,>(method: string, params?: unknown): Promise<T> =>
    peer.call<T>(method, withSession(params)),
  notify: (method, params) => peer.notify(method, withSession(params)),
  setHandler: (id, handler) => {
    if (handler === null) detachedHandlers.delete(id)
    else detachedHandlers.set(id, handler)
    return id
  },
  nextHandlerId: () => `h${++handlerCounter}`,
  scheduleRender: () => renderRoot()
}

/**
 * What a `ref` on a form field receives — the spec's `Form.ItemReference`.
 *
 * Only form fields get a façade; every other host component's ref keeps giving
 * back the instance, which is what the tree tests read. The field is addressed by
 * its `id` prop rather than its node id, because `id` is what the *extension*
 * chose and what the field submits under — a node id is ours and means nothing
 * on the other side of a reload.
 *
 * A field with no `id` gets a ref whose methods do nothing, deliberately: it has
 * no name to be focused by, and the spec already requires `id` for the value to
 * be submitted at all. Throwing here would turn a missing prop into a crash in
 * the extension's own render.
 */
const formRefs = new WeakMap<Instance, { focus: () => void; reset: () => void }>()

function formItemRef(instance: Instance): unknown {
  if (!instance.type.startsWith('Form.')) return instance

  const existing = formRefs.get(instance)
  if (existing !== undefined) return existing

  const send = (method: string): void => {
    const id = instance.props['id']
    if (typeof id !== 'string' || id.length === 0) return
    // A call, not a notification. Main routes notifications through a switch of
    // things it already knows (renders, toasts, HUDs) and drops anything else on
    // the floor; only calls reach the service table. `focus()` returns `void` in
    // the spec, so the promise is nobody's to await — and an unawaited rejection
    // in a worker is a dead command, hence the explicit catch.
    peer
      .call(method, withSession({ value: id }))
      .catch((error: unknown) => log('debug', `a form ref call failed: ${describe(error)}`))
  }
  // Built once per instance and cached: React compares the ref value it stored
  // against what it gets back, and a fresh object every commit would detach and
  // reattach the ref on every render.
  const façade = {
    focus: () => send(APP_METHODS.FORM_FOCUS),
    reset: () => send(APP_METHODS.FORM_RESET)
  }
  formRefs.set(instance, façade)
  return façade
}

/**
 * Stamp the session id onto every outbound call.
 *
 * Added here rather than trusted from the caller: a worker hosts one session, so
 * there is exactly one right answer, and taking it from the API surface would
 * make the id something extension code could influence.
 */
function withSession(params: unknown): unknown {
  const sessionId = spec?.sessionId ?? ''
  if (params === undefined) return { sessionId }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return { sessionId, value: params }
  }
  return { ...(params as Record<string, unknown>), sessionId }
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  peer.notify(APP_METHODS.LOG, { sessionId: spec?.sessionId ?? '', level, message })
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Route the extension's `console` into its own log.
 *
 * Extensions log; that is how their authors debug them, and swallowing it makes
 * ours the launcher you cannot develop against. `lumanin ext log <name>` tails
 * these, tagged with the session.
 */
function captureConsole(): void {
  const levels = { debug: 'debug', log: 'info', info: 'info', warn: 'warn', error: 'error' } as const
  for (const [method, level] of Object.entries(levels)) {
    ;(console as unknown as Record<string, unknown>)[method] = (...args: unknown[]): void => {
      log(level, args.map((arg) => stringify(arg)).join(' '))
    }
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// Starting a command.
// ---------------------------------------------------------------------------

/**
 * Warm up: everything that does not depend on which command this will run.
 *
 * Done at module scope rather than on the first message, because that is what
 * makes a spare worker a *warm* one. React, the reconciler and the whole shim
 * are loaded here; by the time `session.create` arrives the only thing left to
 * do is require the extension's own bundle and render it.
 */
function warmUp(): ShimModule {
  installModuleHook(boot.modulePath)
  const loaded = require(boot.modulePath) as ShimModule
  loaded.__lumaninInstallRuntime(runtime)
  return loaded
}

function start(session: SessionSpec): null {
  spec = session
  captureConsole()

  // The bundle is the first third-party code to run in this isolate, so the
  // single-React check happens on the far side of requiring it — before that
  // there is nothing that could have brought a second copy.
  const entry = require(session.entryPath) as { default?: unknown }
  assertSingleReact()
  if (shim === null) throw new Error('the worker was not warmed up')
  const command = entry.default

  if (typeof command === 'function') {
    // `LaunchProps`: arguments the user typed at the root, plus the launch type.
    // `LaunchProps` is an open bag rather than a fixed props type, so the
    // component is typed by what it receives rather than by what it declares.
    const view = command as FunctionComponent<Record<string, unknown>>
    commandElement = createElement(view, {
      arguments: session.launchArguments,
      launchType: session.environment.launchType,
      launchContext: session.launchContext ?? {}
    })
  } else {
    // The pre-hooks entry point: no default export, `render(<Command/>)` was
    // called while the module body ran. Nothing to construct — it is already
    // sitting in the shim.
    commandElement = shim.__lumaninInternals.legacyRoot()
    if (commandElement === null) {
      throw new Error(
        `"${session.commandName}" has no default export and did not call render() - there is nothing to display`
      )
    }
  }

  if (session.commandMode === 'view' || session.commandMode === 'menu-bar') {
    renderer = createRenderer({
      onCommit: commit,
      onError: onRenderError,
      publicInstance: formItemRef,
      // A commit the reconciler decides not to publish is never serialized, and
      // serializing is what usually refreshes this table. Without it, an action
      // on a row whose only change was a rebuilt arrow function would run the
      // previous render's closure.
      onHandler: (nodeId, prop, fn) => treeHandlers.set(handlerId(nodeId, prop), fn)
    })
    renderRoot()
  }

  // A `no-view` command is a function with a side effect and no UI. It has
  // already run — requiring the module ran it — and there is nothing to render,
  // so the session ends as soon as its promise settles.
  if (session.commandMode === 'no-view') {
    void Promise.resolve(typeof command === 'function' ? (command as () => unknown)() : undefined)
      .then(() => peer.notify(APP_METHODS.SESSION_FINISHED, { sessionId: session.sessionId }))
      .catch((error: unknown) => fail(error, false))
  }

  return null
}

/**
 * Fail loudly if two Reacts ended up here anyway.
 *
 * This check is deliberate, and the reason is the error it
 * replaces: two copies of React produce "invalid hook call" from inside the
 * extension's own component, which sends its author looking at their hooks. The
 * cache scan is the honest check — the module hook makes this near-impossible,
 * but "near" is doing work in a system that loads bundles we did not build.
 */
function assertSingleReact(): void {
  const loaded = Object.keys(require.cache).filter((path) =>
    /(^|[/\\])node_modules[/\\]react[/\\]index\.js$/.test(path)
  )
  if (loaded.length > 1) {
    throw new Error(
      `this extension bundled its own copy of React (${loaded.length} found). Rebuild it with react marked external; two copies in one worker break every hook.`
    )
  }
}

function renderRoot(): void {
  if (renderer === null || shim === null || commandElement === null) return
  renderer.render(createElement(shim.__lumaninInternals.CommandRoot, { children: commandElement }))
}

// ---------------------------------------------------------------------------
// Commit → patches.
// ---------------------------------------------------------------------------

const rejected = new Set<string>()

function commit(): void {
  if (renderer === null || committing) return
  committing = true
  try {
    const { node, handlers: live } = serializeTree(renderer.root, {
      handler: (id, fn) => treeHandlers.set(id, fn),
      reject: (nodeId, prop, reason) => {
        // Once per prop, not once per render: a rejected prop is rejected again
        // on every commit, and an extension that renders sixty times a second
        // would otherwise write sixty identical lines a second into the log.
        const key = `${nodeId}:${prop}`
        if (rejected.has(key)) return
        rejected.add(key)
        log('warn', `dropped prop "${prop}": ${reason}`)
      }
    })

    for (const id of treeHandlers.keys()) if (!live.has(id)) treeHandlers.delete(id)

    const patches = compare(previous as unknown as object, node as unknown as object)
    previous = node
    if (patches.length === 0) return

    peer.notify(APP_METHODS.RENDER, {
      sessionId: spec?.sessionId ?? '',
      revision: ++revision,
      patches
    })
  } finally {
    committing = false
  }
}

function onRenderError(error: unknown, phase: 'render' | 'recoverable'): void {
  // A recoverable error is one React retried and survived; it is worth a log
  // line and nothing more. An uncaught render error means the view is gone.
  if (phase === 'recoverable') {
    log('warn', `recovered from a render error: ${describe(error)}`)
    return
  }
  fail(error, true)
}

function fail(error: unknown, fatal: boolean): void {
  const body = toErrorBody(error)
  peer.notify(APP_METHODS.SESSION_FAILED, {
    sessionId: spec?.sessionId ?? '',
    message: body.message,
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    fatal
  })
}

// ---------------------------------------------------------------------------
// Events.
// ---------------------------------------------------------------------------

/** Handlers still running. Reported to the host on every change, so teardown can wait. */
const inFlight = new Set<Promise<unknown>>()
/** Handlers between "about to run" and "known to be sync or async", counted as busy. */
let starting = 0

function reportBusy(): void {
  peer.notify(WORKER_NOTIFICATIONS.BUSY, { sessionId: spec?.sessionId ?? '', count: inFlight.size + starting })
}

async function drainThenTeardown(): Promise<null> {
  const started = inFlight.size
  let timer: NodeJS.Timeout | null = null
  const ceiling = new Promise<'ceiling'>((resolve) => {
    timer = setTimeout(() => resolve('ceiling'), ACTION_DRAIN_CEILING_MS)
  })
  const settled = Promise.allSettled([...inFlight]).then(() => 'settled' as const)
  const outcome = await Promise.race([settled, ceiling])
  if (timer !== null) clearTimeout(timer)
  if (outcome === 'ceiling') {
    log('warn', `${String(inFlight.size)} of ${String(started)} actions still running after ${String(ACTION_DRAIN_CEILING_MS)}ms; tearing down anyway`)
  }
  teardown()
  return null
}

function dispatch(params: EventParams): null {
  const handler = treeHandlers.get(params.handlerId) ?? detachedHandlers.get(params.handlerId)
  if (handler === undefined) {
    // The tree moved on between the render the user pressed and this message.
    // Normal, not an error — and never silent, because "my action does nothing"
    // is otherwise unexplainable.
    log('debug', `ignored an event for a handler that is no longer mounted: ${params.handlerId}`)
    return null
  }

  // Reported *before* the handler runs, on the same ordered port the handler's
  // own calls leave by: an action that starts with `await closeMainWindow()`
  // (which `showHUD` does) would otherwise have its session closed as idle
  // before main heard it was busy, and the work after the await refused.
  starting += 1
  reportBusy()
  let tracked = false
  try {
    const result = handler(reviveDates(params.payload)) as unknown
    // An `async onAction` rejects long after this returns; without this the
    // rejection is unhandled and takes the worker down with it. The promise is
    // also what teardown waits on, so it is tracked until it settles.
    if (result instanceof Promise) {
      const settled = result.catch((error: unknown) => fail(error, false))
      inFlight.add(settled)
      tracked = true
      void settled.finally(() => {
        inFlight.delete(settled)
        reportBusy()
      })
    }
  } catch (error) {
    fail(error, false)
  } finally {
    starting -= 1
    // A tracked promise leaves the count where it was; a sync handler drops it.
    if (!tracked) reportBusy()
  }
  return null
}

/**
 * Turn `{__date}` back into a `Date` on the way in.
 *
 * A `Date` prop leaves as `{__date: iso}` (`shared/render-tree.ts`), and the
 * renderer sends the same shape back for `Form.DatePicker` — one encoding rather
 * than two. It has to be revived here, in the one place every event passes
 * through, because the alternative is `onChange` handing an extension an object
 * where its own types promise a `Date` and it calls `.getTime()` on it.
 *
 * Recursive because a submit is a whole map of values, and a `Form.Event` nests
 * its value one level down inside `target`.
 */
function reviveDates(value: unknown, depth = 6): unknown {
  if (depth === 0 || value === null || typeof value !== 'object') return value
  if (isDateRef(value)) {
    const parsed = new Date(value.__date)
    // An unparseable date is left as it arrived: inventing an Invalid Date would
    // travel further before failing, and further from what caused it.
    return Number.isNaN(parsed.getTime()) ? value : parsed
  }
  if (Array.isArray(value)) return value.map((entry) => reviveDates(entry, depth - 1))

  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) out[key] = reviveDates(entry, depth - 1)
  return out
}

function teardown(): void {
  try {
    renderer?.unmount()
  } catch (error) {
    log('warn', `an extension threw while unmounting: ${describe(error)}`)
  }
  try {
    shim?.__lumaninInternals.flushCaches()
  } catch (error) {
    log('warn', `cache could not be written on teardown: ${describe(error)}`)
  }
  treeHandlers.clear()
  detachedHandlers.clear()
  renderer = null
  commandElement = null
  previous = emptyTree()
}

// Node's own deprecation and experimental warnings arrive through `console.error`
// by default, which would file them as extension errors. They are neither the
// extension's fault nor errors.
process.on('warning', (warning: Error) => log('warn', `${warning.name}: ${warning.message}`))

process.on('uncaughtException', (error: Error) => fail(error, true))
process.on('unhandledRejection', (reason: unknown) => fail(reason, false))

shim = warmUp()
peer.notify(WORKER_NOTIFICATIONS.READY)
