/**
 * Ambient types for `react-reconciler` 0.33.0.
 *
 * The package ships no types, and DefinitelyTyped's `@types/react-reconciler`
 * describes an older host-config shape — React 19 dropped `prepareUpdate` and
 * changed `commitUpdate`'s signature, so installing it would type-check our
 * renderer against a contract the runtime no longer has. That is worse than no
 * types: it would be wrong with confidence.
 *
 * So this declares exactly the surface we use, and nothing else. The host config
 * is intentionally loose about the methods React only calls behind feature flags
 * we turn off (persistence, hydration, resources) — they are declared optional
 * rather than described, because we do not implement them and a description we
 * cannot verify is a guess.
 *
 * ARCHITECTURE.md pins the version exactly for this reason: the reconciler has no
 * semver contract and its host config changes between patch releases.
 */
declare module 'react-reconciler' {
  import type { ReactNode } from 'react'

  export interface HostConfig<Instance, TextInstance, Container, HostContext, PublicInstance> {
    supportsMutation: boolean
    supportsPersistence: boolean
    supportsHydration: boolean
    isPrimaryRenderer: boolean
    noTimeout: -1

    createInstance(
      type: string,
      props: Record<string, unknown>,
      rootContainer: Container,
      hostContext: HostContext,
      internalHandle: unknown
    ): Instance
    createTextInstance(
      text: string,
      rootContainer: Container,
      hostContext: HostContext,
      internalHandle: unknown
    ): TextInstance
    appendInitialChild(parent: Instance, child: Instance | TextInstance): void
    finalizeInitialChildren(
      instance: Instance,
      type: string,
      props: Record<string, unknown>,
      rootContainer: Container,
      hostContext: HostContext
    ): boolean
    shouldSetTextContent(type: string, props: Record<string, unknown>): boolean
    /** Must not be `null`: React treats a falsy context as a bug in itself. */
    getRootHostContext(rootContainer: Container): HostContext
    getChildHostContext(parentContext: HostContext, type: string, rootContainer: Container): HostContext
    getPublicInstance(instance: Instance | TextInstance): PublicInstance
    prepareForCommit(containerInfo: Container): Record<string, unknown> | null
    resetAfterCommit(containerInfo: Container): void
    preparePortalMount(containerInfo: Container): void
    scheduleTimeout(fn: (...args: unknown[]) => void, delay?: number): unknown
    cancelTimeout(id: unknown): void

    getCurrentUpdatePriority(): number
    setCurrentUpdatePriority(priority: number): void
    resolveUpdatePriority(): number

    maySuspendCommit(type: string, props: Record<string, unknown>): boolean
    maySuspendCommitOnUpdate(type: string, oldProps: Record<string, unknown>, newProps: Record<string, unknown>): boolean
    maySuspendCommitInSyncRender(type: string, props: Record<string, unknown>): boolean
    preloadInstance(type: string, props: Record<string, unknown>): boolean
    startSuspendingCommit(): void
    suspendInstance(type: string, props: Record<string, unknown>): void
    getSuspendedCommitReason(): number
    waitForCommitToBeReady(): null
    shouldAttemptEagerTransition(): boolean

    supportsMicrotasks: boolean
    scheduleMicrotask(fn: () => void): void
    /** React's profiler/DevTools timeline hooks. Called on every scheduled pass. */
    trackSchedulerEvent(): void
    resolveEventType(): string | null
    resolveEventTimeStamp(): number
    supportsTestSelectors: boolean
    warnsIfNotActing: boolean
    rendererVersion: string
    rendererPackageName: string
    extraDevToolsConfig: unknown
    requestPostPaintCallback(callback: (time: number) => void): void
    detachDeletedInstance(node: Instance): void
    beforeActiveInstanceBlur(): void
    afterActiveInstanceBlur(): void
    prepareScopeUpdate(scopeInstance: unknown, instance: unknown): void
    getInstanceFromScope(scopeInstance: unknown): null
    getInstanceFromNode(node: unknown): null
    clearContainer(container: Container): void
    resetFormInstance(form: Instance): void
    bindToConsole(
      methodName: string,
      args: unknown[],
      badgeName: string
    ): (...args: unknown[]) => void

    NotPendingTransition: null
    HostTransitionContext: unknown

    // Mutation mode.
    appendChild(parent: Instance, child: Instance | TextInstance): void
    appendChildToContainer(container: Container, child: Instance | TextInstance): void
    insertBefore(
      parent: Instance,
      child: Instance | TextInstance,
      before: Instance | TextInstance
    ): void
    insertInContainerBefore(
      container: Container,
      child: Instance | TextInstance,
      before: Instance | TextInstance
    ): void
    removeChild(parent: Instance, child: Instance | TextInstance): void
    removeChildFromContainer(container: Container, child: Instance | TextInstance): void
    commitUpdate(
      instance: Instance,
      type: string,
      prevProps: Record<string, unknown>,
      nextProps: Record<string, unknown>,
      internalHandle: unknown
    ): void
    commitTextUpdate(textInstance: TextInstance, oldText: string, newText: string): void
    commitMount(
      instance: Instance,
      type: string,
      props: Record<string, unknown>,
      internalHandle: unknown
    ): void
    resetTextContent(instance: Instance): void
    hideInstance(instance: Instance): void
    hideTextInstance(textInstance: TextInstance): void
    unhideInstance(instance: Instance, props: Record<string, unknown>): void
    unhideTextInstance(textInstance: TextInstance, text: string): void
  }

  export interface OpaqueRoot {
    readonly _reactInternal?: unknown
  }

  export interface Reconciler<Container> {
    createContainer(
      containerInfo: Container,
      tag: number,
      hydrationCallbacks: null,
      isStrictMode: boolean,
      concurrentUpdatesByDefaultOverride: null,
      identifierPrefix: string,
      onUncaughtError: (error: unknown) => void,
      onCaughtError: (error: unknown) => void,
      onRecoverableError: (error: unknown) => void,
      onDefaultTransitionIndicator: null
    ): OpaqueRoot
    updateContainer(element: ReactNode, container: OpaqueRoot, parentComponent?: null, callback?: null): void
    /** The same, on the sync lane, so the caller can flush it immediately. */
    updateContainerSync(
      element: ReactNode,
      container: OpaqueRoot,
      parentComponent?: null,
      callback?: null
    ): void
    /** Drain scheduled work now. Named `flushSyncWork` upstream, not `flushSync`. */
    flushSyncWork(): boolean
    flushPassiveEffects(): boolean
  }

  export default function ReactReconciler<
    Instance,
    TextInstance,
    Container,
    HostContext,
    PublicInstance
  >(
    config: HostConfig<Instance, TextInstance, Container, HostContext, PublicInstance>
  ): Reconciler<Container>
}

declare module 'react-reconciler/constants' {
  export const NoEventPriority: number
  export const DefaultEventPriority: number
  export const DiscreteEventPriority: number
  export const ContinuousEventPriority: number
  export const IdleEventPriority: number
  export const ConcurrentRoot: number
  export const LegacyRoot: number
}
