import type { CommandMode } from './extension'
import type { RenderPatch } from './render-tree'

/**
 * The extension protocol: what main, the host and a worker say to each other.
 *
 * Method names are string constants rather than free-form, because both ends
 * register against the same allow-list (`node/rpc.ts`) and a typo in a method
 * name is otherwise a runtime `METHOD_NOT_FOUND` instead of a compile error.
 *
 * Three participants, two hops:
 *
 * ```
 *   main  ──HOST_METHODS──▶  host  ──WORKER_METHODS──▶  worker
 *         ◀──APP_METHODS──         ◀────APP_METHODS───
 * ```
 *
 * `APP_METHODS` are the services a running extension needs from the desktop —
 * clipboard, storage, opening things, showing a toast. They travel the same path
 * in reverse and the host relays them, adding the `sessionId` it knows so a
 * worker cannot claim to be a session it does not own.
 */

/** main → host. */
export const HOST_METHODS = {
  CREATE: 'session.create',
  EVENT: 'session.event',
  POP: 'session.pop',
  DESTROY: 'session.destroy',
  RELOAD: 'session.reload',
  ALERT_ANSWER: 'session.alertAnswer',
  PING: 'host.ping'
} as const

/** host → worker. Same shapes as {@link HOST_METHODS}, minus the ones the host answers itself. */
export const WORKER_METHODS = {
  CREATE: HOST_METHODS.CREATE,
  EVENT: HOST_METHODS.EVENT,
  POP: HOST_METHODS.POP,
  DESTROY: HOST_METHODS.DESTROY,
  ALERT_ANSWER: HOST_METHODS.ALERT_ANSWER
} as const

/** worker → host → main. The services side of the protocol. */
export const APP_METHODS = {
  RENDER: 'ui.render',
  TOAST_SHOW: 'ui.toast.show',
  TOAST_HIDE: 'ui.toast.hide',
  HUD: 'ui.hud',
  ALERT: 'ui.alert',
  CLOSE_WINDOW: 'ui.closeWindow',
  POP_TO_ROOT: 'ui.popToRoot',
  CLEAR_SEARCH_BAR: 'ui.clearSearchBar',
  SELECT_ITEM: 'ui.selectItem',
  /**
   * `Form.ItemReference.focus()` / `.reset()`.
   *
   * The form's values live in the renderer — that is what keeps typing from
   * being a round trip through two processes per keystroke — so an imperative
   * call on a field ref has to travel there rather than being answered locally.
   * Same shape as `SELECT_ITEM` for the same reason: it names a thing the user
   * can see and asks the view to do something with it.
   */
  FORM_FOCUS: 'ui.form.focus',
  FORM_RESET: 'ui.form.reset',
  OPEN_PREFERENCES: 'ui.openPreferences',
  UPDATE_METADATA: 'ui.updateCommandMetadata',
  SESSION_FAILED: 'session.failed',
  SESSION_FINISHED: 'session.finished',
  CLIPBOARD_COPY: 'clipboard.copy',
  CLIPBOARD_PASTE: 'clipboard.paste',
  CLIPBOARD_READ: 'clipboard.read',
  CLIPBOARD_CLEAR: 'clipboard.clear',
  SELECTION_READ: 'selection.read',
  STORAGE_GET: 'storage.get',
  STORAGE_SET: 'storage.set',
  STORAGE_REMOVE: 'storage.remove',
  STORAGE_CLEAR: 'storage.clear',
  STORAGE_ALL: 'storage.allItems',
  /** `launchCommand` — one command handing off to another, its own or someone else's. */
  LAUNCH_COMMAND: 'system.launchCommand',
  OPEN: 'system.open',
  TRASH: 'system.trash',
  APPLICATIONS: 'system.applications',
  LOG: 'log'
} as const

/**
 * worker -> host, and no further.
 *
 * The host answers this one itself and never relays it. Main's notification
 * switch warns on any method it does not recognise, so forwarding a signal that
 * fires every time the pool is topped up would write a warning to the log on
 * every worker start.
 */
export const WORKER_NOTIFICATIONS = {
  /** React, the reconciler and the shim are loaded; the worker has no command yet. */
  READY: 'worker.ready'
} as const

/**
 * How far along the warm spare is.
 *
 * `'warming'` is a worker that has been started and has not announced itself
 * yet, which is a real state rather than a rounding of `'ready'`: two launches
 * inside that window would otherwise both be told they got a warm worker.
 * `'unknown'` is what a caller reports when the host did not answer in time.
 */
export type SpareState = 'ready' | 'warming' | 'none' | 'unknown'

/** The {@link HOST_METHODS.PING} reply. */
export interface HostPing {
  readonly sessions: number
  readonly spare: SpareState
  /**
   * Every worker thread the host has started and not seen exit, the spare
   * included.
   *
   * A count that stays high after the panel closed is a thread that outlived its
   * session — a wedged command still burning a core and holding its heap. That
   * is invisible from anywhere else, because a session is dropped from the map
   * before its worker is asked to stop.
   *
   * `null` means the host did not answer, the same admission `spare: 'unknown'`
   * makes.
   */
  readonly workers: number | null
}

/** {@link HostPing} plus the one thing only main knows: whether it forked at all. */
export interface ExtensionHostStatus {
  readonly running: boolean
  readonly sessions: number
  readonly spare: SpareState
  /** As {@link HostPing.workers}; `0` when there is no host process. */
  readonly workers: number | null
}

/** The answer when the host process has not been started. Written once. */
export const HOST_NOT_RUNNING: ExtensionHostStatus = {
  running: false,
  sessions: 0,
  spare: 'none',
  workers: 0
}

/** Everything a worker needs to run one command. */
export interface SessionSpec {
  readonly sessionId: string
  readonly extensionName: string
  readonly extensionTitle: string
  /** Absolute path to the installed extension directory. Never crosses to the renderer. */
  readonly extensionDir: string
  readonly commandName: string
  readonly commandTitle: string
  readonly commandMode: CommandMode
  /** Absolute path to the built command entry file. */
  readonly entryPath: string
  readonly preferences: Readonly<Record<string, unknown>>
  readonly launchArguments: Readonly<Record<string, string>>
  /**
   * `LaunchProps.launchContext`, verbatim.
   *
   * For a launch from a pinned category or a hotkey it carries
   * `{ category: string, item?: string }`; the command's contract (skill
   * reference) is to start its dropdown on `category`. `item` is the renderer's
   * business — it preselects the matching row — not the command's.
   */
  readonly launchContext: Readonly<Record<string, unknown>>
  readonly environment: SessionEnvironment
}

/** The subset of `environment` the worker cannot work out for itself. */
export interface SessionEnvironment {
  readonly assetsPath: string
  readonly supportPath: string
  readonly appearance: 'light' | 'dark'
  readonly textSize: 'medium' | 'large'
  readonly isDevelopment: boolean
  readonly launchType: 'userInitiated' | 'background'
  /** Reported by `environment.raycastVersion`: the pinned spec's version, not ours. */
  readonly apiVersion: string
}

export interface RenderParams {
  readonly sessionId: string
  readonly revision: number
  readonly patches: readonly RenderPatch[]
}

export interface EventParams {
  readonly sessionId: string
  readonly handlerId: string
  /** Whatever the component's handler takes: a string, an id, a form value map. */
  readonly payload: unknown
}

export interface SessionRef {
  readonly sessionId: string
}

/** What a toast looks like once it has left the worker. Actions are handler ids. */
export interface ToastPayload {
  readonly id: string
  readonly sessionId: string
  readonly style: 'SUCCESS' | 'FAILURE' | 'ANIMATED'
  readonly title: string
  readonly message?: string
  readonly primaryAction?: ToastActionPayload
  readonly secondaryAction?: ToastActionPayload
}

export interface ToastActionPayload {
  readonly title: string
  readonly handlerId: string
  /** Serialized `Keyboard.Shortcut`, already mapped to our modifiers. */
  readonly shortcut?: string
}

/** What the worker asks for. It blocks on the reply, so this is a call, not a notification. */
export interface AlertRequest {
  readonly title: string
  readonly message?: string
  readonly primaryTitle: string
  readonly dismissTitle: string
  readonly destructive: boolean
}

/**
 * The same alert on its way to the renderer.
 *
 * `token` is minted by **main**, not by the worker: it is what pairs an answer
 * with the call that is blocked on it, and a worker that could choose its own
 * could answer a different session's alert.
 */
export interface AlertPayload extends AlertRequest {
  readonly sessionId: string
  readonly token: string
}

export interface SessionFailure {
  readonly sessionId: string
  readonly message: string
  readonly stack?: string
  /** True when the worker itself died (crash, OOM) rather than the command throwing. */
  readonly fatal: boolean
}

export interface LogParams {
  readonly sessionId: string
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
}
