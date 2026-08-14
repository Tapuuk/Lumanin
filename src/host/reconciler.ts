import type { ReactNode } from 'react'
import ReactReconciler, { type HostConfig, type OpaqueRoot } from 'react-reconciler'
import { ConcurrentRoot, DiscreteEventPriority, NoEventPriority } from 'react-reconciler/constants'
import { INTERNAL_TYPES } from '../shared/render-tree'
import { createIdFactory, isText, type Child, type Instance, type TextInstance } from './tree'

/**
 * The custom renderer.
 *
 * ARCHITECTURE.md calls this the heart, and the thing to understand about it is
 * how *little* it does: React does the work, and a host config's job is only to
 * say what an "instance" is and how instances are attached to each other. Ours
 * are plain objects, so every method here is two lines.
 *
 * Mutation mode, not persistence. Persistence would rebuild the tree on every
 * commit, which sounds like a better fit for something that serializes to JSON —
 * and is exactly wrong: we serialize the whole tree in `resetAfterCommit`
 * anyway, and mutation mode keeps object identity stable so ids survive, which
 * is what makes the JSON Patch small.
 *
 * The version is pinned exactly (0.33.0). This package has no semver contract and
 * its host config gains and loses methods between patch releases; React 19
 * removed `prepareUpdate` and changed `commitUpdate`'s arguments.
 */

export interface Container {
  readonly root: Instance
  /** Called after every commit, once the tree is settled. */
  onCommit(): void
  onError(error: unknown, phase: 'render' | 'recoverable'): void
}

/**
 * React 19 asks the host for the current update priority through three methods
 * that must share one variable. Keeping it module-scoped is what upstream's own
 * DOM renderer does; there is one reconciler per worker and one worker per
 * extension, so there is nothing to collide with.
 */
let currentUpdatePriority: number = NoEventPriority

/** Set by {@link createRenderer} when the caller wants refs to receive a façade. */
let publicInstanceOf: ((instance: Instance) => unknown) | null = null

const nextId = createIdFactory()

/**
 * The host context, which for us carries nothing.
 *
 * It still has to be an object. React checks the *context itself* for
 * truthiness and reports "Expected host context to exist. This error is likely
 * caused by a bug in React" when a host returns `null` — a message that sends
 * you looking in exactly the wrong place, since the bug is here.
 */
const HOST_CONTEXT: HostContext = Object.freeze({})
type HostContext = Readonly<Record<string, never>>

const config: HostConfig<Instance, TextInstance, Container, HostContext, Instance | TextInstance> = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1,

  createInstance(type, props) {
    return { id: nextId(), type, props: { ...props }, children: [] }
  },

  createTextInstance(text) {
    return { id: nextId(), text }
  },

  appendInitialChild(parent, child) {
    parent.children.push(child)
  },

  finalizeInitialChildren() {
    // `true` would ask React to call `commitMount` after the node is attached,
    // which is for renderers that need to touch a real widget (autofocus, media
    // playback). Ours has nothing to do there.
    return false
  },

  /**
   * Whether a component's children are just text.
   *
   * Always `false`, deliberately. Returning `true` for text-only children is a
   * DOM optimisation — set `textContent` and skip creating child nodes — and
   * taking it would make a text child vanish from the serialized tree instead of
   * appearing as a node. ARCHITECTURE.md requires text nodes to round-trip
   * exactly, and this is the switch that decides whether they exist at all.
   */
  shouldSetTextContent() {
    return false
  },

  getRootHostContext() {
    return HOST_CONTEXT
  },

  getChildHostContext(parentContext) {
    return parentContext
  },

  /**
   * What a `ref` on a host component receives.
   *
   * The instance itself, unless something asked for a façade. `Form` needs one:
   * the spec's `Form.ItemReference` has `focus()` and `reset()`, and a plain
   * `{id, type, props, children}` has neither — an extension calling
   * `ref.current.focus()` would get a TypeError from inside its own code with no
   * hint that the ref was never going to work.
   *
   * Module-scoped for the same reason `currentUpdatePriority` is: the host config
   * is one frozen object shared by every renderer, there is one renderer per
   * worker and one worker per command, so there is nothing to collide with.
   */
  getPublicInstance(instance) {
    // A text node has no props and cannot be addressed by a ref, so it is never
    // a candidate for a façade.
    if (publicInstanceOf === null || isText(instance)) return instance
    return publicInstanceOf(instance) as Instance
  },

  prepareForCommit() {
    return null
  },

  /**
   * The commit hook: the tree is now final for this pass.
   *
   * Serializing here rather than in each mutation method is the whole reason the
   * patches are coherent — a single React render can append, reorder and update
   * a dozen nodes, and a diff taken between any two of those is of a tree that
   * never existed on screen.
   */
  resetAfterCommit(container) {
    container.onCommit()
  },

  preparePortalMount() {},

  scheduleTimeout(fn, delay) {
    return setTimeout(fn, delay)
  },

  cancelTimeout(id) {
    clearTimeout(id as NodeJS.Timeout)
  },

  getCurrentUpdatePriority() {
    return currentUpdatePriority
  },

  setCurrentUpdatePriority(priority) {
    currentUpdatePriority = priority
  },

  /**
   * Everything is a **discrete** (synchronous) update.
   *
   * A DOM renderer returns `DefaultEventPriority` here so React can slice long
   * renders and keep the browser responsive. There is nothing to keep responsive
   * in this process: the worker's entire output is a JSON diff taken at
   * `resetAfterCommit`, and time-slicing only buys the chance to take that diff
   * of a half-updated tree.
   *
   * It also makes the pipeline deterministic — `setState` → commit → patch, in
   * one turn — which is what lets the golden tests assert on a tree instead of
   * waiting for the scheduler's macrotask and hoping.
   */
  resolveUpdatePriority() {
    return currentUpdatePriority === NoEventPriority ? DiscreteEventPriority : currentUpdatePriority
  },

  /**
   * Suspending a *commit* — the mechanism a DOM renderer uses to hold a paint
   * until an image or a stylesheet has loaded. We have no such resource, so all
   * four say no and the commit goes through immediately.
   */
  maySuspendCommit() {
    return false
  },
  maySuspendCommitOnUpdate() {
    return false
  },
  maySuspendCommitInSyncRender() {
    return false
  },
  preloadInstance() {
    return true
  },
  startSuspendingCommit() {},
  suspendInstance() {},
  getSuspendedCommitReason() {
    return 0
  },
  waitForCommitToBeReady() {
    return null
  },
  shouldAttemptEagerTransition() {
    return false
  },

  /**
   * Scheduling and profiling hooks React 19 destructures unconditionally.
   *
   * `supportsMicrotasks` is `true` on purpose rather than by default: without it
   * React falls back to a `setImmediate`-driven task per flush, and every commit
   * would wait a full macrotask. In a worker whose only job is to render, a
   * microtask is exactly the right granularity.
   *
   * The three `*Event*` hooks feed React's own profiler and DevTools timeline.
   * They must exist — the reconciler calls `trackSchedulerEvent()` on every
   * scheduled pass, and a missing one is a `TypeError` inside React's scheduler
   * rather than anything that names the host config.
   */
  supportsMicrotasks: true,
  scheduleMicrotask(fn) {
    queueMicrotask(fn)
  },
  trackSchedulerEvent() {},
  resolveEventType() {
    return null
  },
  resolveEventTimeStamp() {
    return -1.1
  },
  supportsTestSelectors: false,
  warnsIfNotActing: false,
  rendererVersion: '0.33.0',
  rendererPackageName: 'lumanin',
  extraDevToolsConfig: null,
  requestPostPaintCallback() {},
  detachDeletedInstance() {},
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  prepareScopeUpdate() {},
  getInstanceFromScope() {
    return null
  },
  getInstanceFromNode() {
    return null
  },

  clearContainer(container) {
    container.root.children = []
  },

  resetFormInstance() {},

  /**
   * Where an extension's `console.log` goes.
   *
   * React uses this to re-emit logs it replayed during a double render. Returning
   * the bound console method keeps them; the worker has already redirected
   * `console` into the extension's log file, so this needs no policy of its own.
   */
  bindToConsole(methodName, args) {
    const method = (console as unknown as Record<string, unknown>)[methodName]
    return typeof method === 'function'
      ? (method as (...rest: unknown[]) => void).bind(console, ...args)
      : () => {}
  },

  NotPendingTransition: null,
  HostTransitionContext: {
    $$typeof: Symbol.for('react.context'),
    Provider: null,
    Consumer: null,
    _currentValue: null,
    _currentValue2: null,
    _threadCount: 0
  },

  // --- mutation ---

  appendChild(parent, child) {
    remove(parent.children, child)
    parent.children.push(child)
  },

  appendChildToContainer(container, child) {
    remove(container.root.children, child)
    container.root.children.push(child)
  },

  insertBefore(parent, child, before) {
    remove(parent.children, child)
    parent.children.splice(indexOf(parent.children, before), 0, child)
  },

  insertInContainerBefore(container, child, before) {
    remove(container.root.children, child)
    container.root.children.splice(indexOf(container.root.children, before), 0, child)
  },

  removeChild(parent, child) {
    remove(parent.children, child)
  },

  removeChildFromContainer(container, child) {
    remove(container.root.children, child)
  },

  /**
   * A props update.
   *
   * The whole object is replaced rather than merged: React hands us the complete
   * next props, and merging would leave a prop that was *removed* this render
   * still on the node — the bug where an item that stops being `isLoading` never
   * stops spinning.
   */
  commitUpdate(instance, _type, _prevProps, nextProps) {
    instance.props = { ...nextProps }
  },

  commitTextUpdate(textInstance, _oldText, newText) {
    textInstance.text = newText
  },

  commitMount() {},
  resetTextContent() {},

  /**
   * `hideInstance` / `unhideInstance` — Suspense.
   *
   * A hidden node keeps its place in the tree and its state; only its visibility
   * changes. Encoding that as a prop the renderer honours is the smallest thing
   * that is also correct — dropping the node instead would unmount it, which is
   * what Suspense exists to avoid.
   */
  hideInstance(instance) {
    instance.props = { ...instance.props, __hidden: true }
  },

  hideTextInstance(textInstance) {
    textInstance.text = ''
  },

  unhideInstance(instance, props) {
    const { __hidden: _hidden, ...visible } = { ...props, ...instance.props }
    instance.props = visible
  },

  unhideTextInstance(textInstance, text) {
    textInstance.text = text
  }
}

function indexOf(children: Child[], target: Child): number {
  const index = children.indexOf(target)
  return index === -1 ? children.length : index
}

function remove(children: Child[], target: Child): void {
  const index = children.indexOf(target)
  if (index !== -1) children.splice(index, 1)
}

const reconciler = ReactReconciler(config)

/**
 * How many render/effect passes one flush will chase before giving up.
 *
 * Generous: a data-loading view is two or three, and a deeply nested set of
 * effects that each set state is maybe five. Reaching this number means an
 * extension is in a render loop, and stopping leaves it visibly stuck on one
 * frame rather than freezing the worker — which is a bug report we can act on.
 */
const MAX_FLUSH_PASSES = 50

export interface Renderer {
  render(element: ReactNode): void
  /** Drain React's scheduled work now, so a caller can observe the result. */
  flush(): void
  unmount(): void
  readonly root: Instance
}

/**
 * Create a renderer for one session.
 *
 * Errors are routed rather than thrown: an extension that throws during render
 * must become a card in the panel, not an unhandled rejection that takes the
 * worker with it. `onUncaughtError` and `onCaughtError` are separate in React 19
 * — the second means an error boundary already handled it — and both are
 * reported, because ours is the only error boundary there is.
 */
export function createRenderer(options: {
  onCommit: (root: Instance) => void
  onError: (error: unknown, phase: 'render' | 'recoverable') => void
  /**
   * What a `ref` on a host component gets, if not the instance.
   *
   * The worker supplies this so the reconciler stays ignorant of the API it is
   * rendering: knowing that `Form.TextField` refs need `focus()` and `reset()` is
   * the shim's business, not the tree builder's.
   */
  publicInstance?: (instance: Instance) => unknown
}): Renderer {
  publicInstanceOf = options.publicInstance ?? null
  const root: Instance = { id: 'root', type: INTERNAL_TYPES.ROOT, props: {}, children: [] }

  const container: Container = {
    root,
    onCommit: () => options.onCommit(root),
    onError: options.onError
  }

  const opaque: OpaqueRoot = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    'lumanin',
    (error) => options.onError(error, 'render'),
    (error) => options.onError(error, 'render'),
    (error) => options.onError(error, 'recoverable'),
    null
  )

  return {
    root,
    render(element) {
      reconciler.updateContainerSync(element, opaque, null, null)
      this.flush()
    },
    /**
     * Drain everything React has queued, including the work that effects
     * scheduled while we were draining.
     *
     * The loop is the part that matters: `useEffect` firing `setState` is the
     * normal shape of a data-loading extension, and one pass would commit the
     * render but not the state it produced — so the first patch batch would show
     * a list that is still empty. Bounded rather than `while (true)`, because an
     * extension whose effect sets state unconditionally would otherwise hang the
     * worker instead of rendering once and being visibly wrong.
     */
    flush() {
      for (let pass = 0; pass < MAX_FLUSH_PASSES; pass++) {
        const flushedWork = reconciler.flushSyncWork()
        const flushedEffects = reconciler.flushPassiveEffects()
        if (!flushedWork && !flushedEffects) return
      }
    },
    unmount() {
      reconciler.updateContainerSync(null, opaque, null, null)
      reconciler.flushSyncWork()
    }
  }
}

export { isText }
