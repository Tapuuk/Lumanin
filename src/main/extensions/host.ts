import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { applyPatch, type Operation } from 'fast-json-patch'
import {
  APP_METHODS,
  HOST_METHODS,
  type AlertPayload,
  type AlertRequest,
  type LogParams,
  type RenderParams,
  type SessionFailure,
  type SessionSpec,
  type ToastPayload
} from '../../shared/ext-protocol'
import type { SessionInfo } from '../../shared/ipc'
import { emptyTree, type RenderNode } from '../../shared/render-tree'
import { createPeer, RpcError, RPC_ERRORS, type RpcMessage, type RpcPeer } from '../../node/rpc'
import type { Logger } from '../../node/logger'
import { missingRequiredPreferences, resolvePreferences, type InstalledCommand } from './registry'
import type { ExtensionStore, StorageValue } from './storage'

/**
 * Main's side of the extension host.
 *
 * Two jobs that are easy to conflate and must not be: **supervising** the
 * utilityProcess (start it, restart it when it dies, tell the renderer which
 * sessions died with it) and **serving** what a running extension asks for.
 *
 * Serving is where the trust boundary is. Every request arriving here came from
 * a worker running somebody else's code, so the session id is checked against
 * the sessions we started rather than believed, and the namespace an extension's
 * storage is read from comes from that lookup — never from the request.
 */

/** What the supervisor needs from the daemon. Injected so it can be tested without Electron. */
export interface HostDeps {
  readonly logger: Logger
  readonly store: ExtensionStore
  /** Where `out/main/host.js` lives. */
  readonly hostScript: string
  /** Push an event to the renderer. */
  readonly emit: EmitFn
  /** Hide the panel — `closeMainWindow`, `showHUD`, `popToRoot`. */
  readonly closeWindow: (options: { clearRootSearch: boolean }) => void
  readonly clipboard: ClipboardService
  readonly selection: () => Promise<string>
  readonly open: (target: string, application?: string) => Promise<void>
  readonly trash: (paths: readonly string[]) => Promise<void>
  readonly applications: (options: {
    path?: string
    defaultOnly?: boolean
    frontmost?: boolean
  }) => Promise<readonly ApplicationInfo[]>
  /**
   * `launchCommand` — find the command it named, and put the panel on it.
   *
   * Both halves are main's rather than the host's. The command index lives there
   * and is rebuilt when plugins change, and only main can show a window.
   * `find` returning `null` is how "no such command" travels back to the
   * extension as a rejected promise.
   */
  readonly commands: {
    find: (extensionName: string | null, commandName: string) => InstalledCommand | null
    present: (session: SessionInfo) => void
  }
  /** Light or dark, for `environment.appearance`. Read per launch, never cached. */
  readonly appearance: () => 'light' | 'dark'
  readonly apiVersion: string
  readonly isDevelopment: boolean
}

export interface ApplicationInfo {
  readonly name: string
  readonly path: string
  readonly bundleId?: string
}

export interface ClipboardService {
  copy(content: { text?: string; html?: string; file?: string; concealed: boolean }): Promise<void>
  paste(content: { text?: string; html?: string; file?: string }): Promise<void>
  read(offset: number): Promise<{ text: string; html?: string; file?: string }>
  clear(): Promise<void>
}

type EmitFn = <E extends keyof EmitMap>(event: E, payload: EmitMap[E]) => void

/** The events this module can raise. A narrow view of the renderer's `EventMap`. */
export interface EmitMap {
  'ext.render': RenderParams
  'ext.toast': { sessionId: string; toast: ToastPayload | null }
  'ext.hud': { title: string }
  'ext.alert': AlertPayload
  'ext.ended': { sessionId: string; message: string | null; stack: string | null }
  'ext.command': {
    sessionId: string
    action: 'clearSearchBar' | 'selectItem' | 'focusField' | 'resetField'
    value: string | null
  }
}

interface LiveSession {
  info: SessionInfo
  readonly command: InstalledCommand
  /**
   * The tree, materialised here as the patches pass through.
   *
   * Main is not a second renderer and does not draw any of this — it holds the
   * document so it can answer "what does the tree look like right now", which
   * the renderer needs twice: once when a session starts (the command has
   * already rendered by then, so the first batch is history) and again if it
   * ever sees a revision gap. Without it the only honest answer to either
   * question would be "restart the command".
   */
  tree: RenderNode
  revision: number
  /**
   * Recorded before the session is dropped, so `launch` can still see it.
   *
   * `launch` holds this object directly, which is what makes the assignment
   * useful after `onFailure` has removed it from the map: a command that dies
   * during `session.create` sets this, and `launch` reads it on the way out.
   */
  failure: { message: string; stack: string | null } | null
}

/** How long to wait before restarting a host that died. Backed off, then given up on. */
const RESTART_DELAYS_MS = [200, 1000, 5000]

let sessionCounter = 0
let alertCounter = 0

export class ExtensionHost {
  private child: UtilityProcess | null = null
  private peer: RpcPeer | null = null
  private restarts = 0
  private readonly sessions = new Map<string, LiveSession>()
  private readonly alerts = new Map<string, (confirmed: boolean) => void>()

  constructor(private readonly deps: HostDeps) {}

  get liveSessions(): number {
    return this.sessions.size
  }

  /**
   * Start the host process.
   *
   * Called lazily, on the first extension launch, rather than at daemon startup.
   * A user with no extensions installed should not be paying for a Node process
   * and a warm worker they will never use — and the cost of starting it is
   * measured against the launch that asked for it, which is the honest place for
   * it to land.
   */
  private ensure(): RpcPeer {
    if (this.peer !== null) return this.peer

    const child = utilityProcess.fork(this.deps.hostScript, [], {
      serviceName: 'lumanin-extensions',
      // Inherited, so an extension's stray `process.stdout.write` reaches our
      // stderr rather than a pipe nobody drains — a full pipe would block the
      // worker that wrote to it, which looks exactly like a hang.
      stdio: 'inherit'
    })

    const peer = createPeer({
      send: (message) => child.postMessage(message),
      onError: (context, error) => this.deps.logger.debug('extension host rpc', { context, error }),
      methods: this.services(),
      onNotification: (method, params) => this.onNotification(method, params),
      // No timeout on this hop: an extension may legitimately sit in an awaited
      // `confirmAlert` for as long as the user takes to read it.
      timeoutMs: 0
    })

    child.on('message', (message: RpcMessage) => peer.handle(message))
    child.on('exit', (code) => this.onHostExit(code))

    this.child = child
    this.peer = peer
    this.deps.logger.info('extension host started')
    return peer
  }

  /**
   * The host process died.
   *
   * Every live session died with it, and each one has a panel showing its last
   * frame. Reporting them individually is what turns a frozen view into an error
   * card with a Reload action (ARCHITECTURE.md §"Failure containment").
   */
  private onHostExit(code: number): void {
    const wasRunning = this.peer !== null
    this.peer?.dispose('the extension host exited')
    this.peer = null
    this.child = null

    for (const [sessionId] of this.sessions) {
      this.deps.emit('ext.ended', {
        sessionId,
        message: `the extension host stopped unexpectedly (exit code ${code})`,
        stack: null
      })
    }
    this.sessions.clear()

    // Every pending alert is answered "no". Leaving them unanswered would leave
    // a modal on screen with no process behind it, and answering "yes" would
    // confirm a destructive action nobody agreed to.
    for (const [token, resolve] of this.alerts) {
      resolve(false)
      this.alerts.delete(token)
    }

    if (!wasRunning) return
    const delay = RESTART_DELAYS_MS[Math.min(this.restarts, RESTART_DELAYS_MS.length - 1)]
    this.restarts += 1
    this.deps.logger.error('extension host exited', { code, restartInMs: delay })
    // Restarted lazily rather than on a timer: the next launch calls `ensure()`,
    // and a host with no sessions costs nothing to not have.
  }

  // --- launching ------------------------------------------------------------

  /**
   * Start a command.
   *
   * Preferences are resolved here and handed over whole, so `getPreferenceValues()`
   * in the worker is a read rather than a merge — and so the required-preference
   * gate below is decided in the one place that knows both the manifest and what
   * the user has stored.
   */
  async launch(
    command: InstalledCommand,
    context: Readonly<Record<string, unknown>> = {},
    options: {
      readonly launchArguments?: Readonly<Record<string, string>>
      readonly launchType?: 'userInitiated' | 'background'
    } = {}
  ): Promise<SessionInfo> {
    const stored = this.deps.store.preferences(
      command.extension.manifest.name,
      command.spec.name
    )
    const preferences = resolvePreferences(command, stored)

    const missing = missingRequiredPreferences(command, preferences)
    if (missing.length > 0) {
      // Raycast blocks the command until required preferences are set, and
      // mirroring that is not pedantry: an extension whose API key is missing
      // does not fail cleanly, it makes an unauthenticated request and shows the
      // user someone else's error message.
      const names = missing.map((spec) => spec.title ?? spec.name).join(', ')
      throw new Error(
        `"${command.spec.title}" needs these preferences set before it can run: ${names}`
      )
    }

    // The index is a snapshot of a directory anyone can edit, so the entry may
    // have gone since it was taken — a plugin removed by hand, a build in
    // progress, an upgrade that moved where bundled ones live. Node's own answer
    // to that is `Cannot find module` and an absolute path, thrown deep inside a
    // worker; this one is a sentence, and it happens before the scratch
    // directory is created rather than after, so a plugin that is not there
    // stops leaving a support tree behind as proof that it was.
    if (!existsSync(command.entryPath)) {
      throw new Error(
        `"${command.spec.title}" is not on disk any more - reinstall the plugin, or run \`lumanin reload\``
      )
    }

    const peer = this.ensure()
    const sessionId = `s${++sessionCounter}`

    // The extension's own scratch directory has to exist before its first write,
    // and `Cache` writes without being asked to.
    mkdirSync(join(command.extension.supportPath, 'cache'), { recursive: true, mode: 0o700 })

    const spec: SessionSpec = {
      sessionId,
      extensionName: command.extension.manifest.name,
      extensionTitle: command.extension.manifest.title,
      extensionDir: command.extension.directory,
      commandName: command.spec.name,
      commandTitle: command.spec.title,
      commandMode: command.spec.mode,
      entryPath: command.entryPath,
      preferences,
      launchArguments: options.launchArguments ?? {},
      launchContext: context,
      environment: {
        assetsPath: command.extension.assetsPath,
        supportPath: command.extension.supportPath,
        appearance: this.deps.appearance(),
        textSize: 'medium',
        isDevelopment: this.deps.isDevelopment,
        launchType: options.launchType ?? 'userInitiated',
        apiVersion: this.deps.apiVersion
      }
    }

    const info: SessionInfo = {
      sessionId,
      extensionName: spec.extensionName,
      extensionTitle: spec.extensionTitle,
      commandName: spec.commandName,
      commandTitle: spec.commandTitle,
      mode: spec.commandMode,
      // Filled in below, once the command has actually rendered.
      tree: emptyTree(),
      revision: 0,
      failure: null,
      select: typeof context['item'] === 'string' ? context['item'] : null
    }

    const live: LiveSession = { info, command, tree: emptyTree(), revision: 0, failure: null }
    this.sessions.set(sessionId, live)
    try {
      await peer.call(HOST_METHODS.CREATE, spec)
    } catch (error) {
      this.sessions.delete(sessionId)
      throw error
    }

    this.deps.logger.info('extension command started', {
      extension: spec.extensionName,
      command: spec.commandName,
      sessionId
    })

    // Returned *after* `create` resolved, so it carries the first render the
    // command produced while starting up — and the crash, if it produced one of
    // those instead. Either way the renderer is handed the outcome rather than
    // being left to infer it from an event it was not yet listening for.
    live.info = { ...info, tree: live.tree, revision: live.revision, failure: live.failure }
    return live.info
  }

  /** The current tree, for a renderer that is attaching or resyncing. */
  snapshot(sessionId: string): { tree: RenderNode; revision: number } | null {
    const session = this.sessions.get(sessionId)
    return session === undefined ? null : { tree: session.tree, revision: session.revision }
  }

  event(sessionId: string, handlerId: string, payload: unknown): void {
    this.forward(HOST_METHODS.EVENT, { sessionId, handlerId, payload })
  }

  pop(sessionId: string): void {
    this.forward(HOST_METHODS.POP, { sessionId })
  }

  reload(sessionId: string): void {
    this.forward(HOST_METHODS.RELOAD, { sessionId })
  }

  close(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return
    this.sessions.delete(sessionId)
    this.forward(HOST_METHODS.DESTROY, { sessionId })
  }

  /** End every session. Called when the panel is dismissed or the daemon quits. */
  closeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) this.close(sessionId)
  }

  answerAlert(token: string, confirmed: boolean): void {
    const resolve = this.alerts.get(token)
    if (resolve === undefined) return
    this.alerts.delete(token)
    resolve(confirmed)
  }

  dispose(): void {
    this.closeAll()
    this.peer?.dispose('the daemon is shutting down')
    this.peer = null
    this.child?.kill()
    this.child = null
  }

  private forward(method: string, params: unknown): void {
    if (this.peer === null) return
    void this.peer.call(method, params).catch((error: unknown) => {
      this.deps.logger.warn('extension host call failed', { method, error })
    })
  }

  // --- services -------------------------------------------------------------

  /**
   * Resolve the extension behind a request, or refuse it.
   *
   * Every service below goes through this. The session id arrives from a worker,
   * so it is looked up rather than trusted, and the storage namespace comes from
   * what the lookup found — an extension cannot name a namespace, only a session
   * it is already running in.
   */
  private owner(params: unknown): LiveSession {
    const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId
    const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined
    if (session === undefined) {
      throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'that extension session is not running')
    }
    return session
  }

  /**
   * `focus()` and `reset()` on a form field ref, forwarded to the view.
   *
   * The field is named by its `id` prop, which is also the key it submits under —
   * so a worker can only address a field it declared, and naming one that is not
   * on screen is a no-op rather than an error. That matters because a ref call
   * commonly races the render that creates the field.
   */
  private formCommand(params: unknown, action: 'focusField' | 'resetField'): null {
    const session = this.owner(params)
    const { value } = params as { value?: unknown }
    this.deps.emit('ext.command', {
      sessionId: session.info.sessionId,
      action,
      value: typeof value === 'string' ? value : null
    })
    return null
  }

  private services(): Record<string, (params: unknown) => unknown | Promise<unknown>> {
    const { store, clipboard, logger } = this.deps

    return {
      [APP_METHODS.CLIPBOARD_COPY]: async (params) => {
        this.owner(params)
        const content = params as { concealed?: boolean }
        await clipboard.copy({
          ...pick(params as Record<string, unknown>),
          concealed: content.concealed === true
        })
        return null
      },
      [APP_METHODS.CLIPBOARD_PASTE]: async (params) => {
        this.owner(params)
        await clipboard.paste(pick(params as Record<string, unknown>))
        return null
      },
      [APP_METHODS.CLIPBOARD_READ]: async (params) => {
        this.owner(params)
        return await clipboard.read(Number((params as { offset?: number }).offset ?? 0))
      },
      [APP_METHODS.CLIPBOARD_CLEAR]: async (params) => {
        this.owner(params)
        await clipboard.clear()
        return null
      },
      [APP_METHODS.SELECTION_READ]: async (params) => {
        this.owner(params)
        return await this.deps.selection()
      },

      [APP_METHODS.STORAGE_GET]: (params) => {
        const session = this.owner(params)
        return store.get(session.info.extensionName, key(params))
      },
      [APP_METHODS.STORAGE_SET]: (params) => {
        const session = this.owner(params)
        store.set(session.info.extensionName, key(params), value(params))
        return null
      },
      [APP_METHODS.STORAGE_REMOVE]: (params) => {
        const session = this.owner(params)
        store.remove(session.info.extensionName, key(params))
        return null
      },
      [APP_METHODS.STORAGE_CLEAR]: (params) => {
        const session = this.owner(params)
        store.clear(session.info.extensionName)
        return null
      },
      [APP_METHODS.STORAGE_ALL]: (params) => {
        const session = this.owner(params)
        return store.all(session.info.extensionName)
      },

      [APP_METHODS.OPEN]: async (params) => {
        this.owner(params)
        const { target, application } = params as { target?: unknown; application?: unknown }
        if (typeof target !== 'string' || target.length === 0) {
          throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'open() needs a target')
        }
        await this.deps.open(target, typeof application === 'string' ? application : undefined)
        return null
      },
      [APP_METHODS.TRASH]: async (params) => {
        this.owner(params)
        const paths = (params as { paths?: unknown }).paths
        if (!Array.isArray(paths)) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'trash() needs paths')
        await this.deps.trash(paths.filter((entry): entry is string => typeof entry === 'string'))
        return null
      },
      [APP_METHODS.APPLICATIONS]: async (params) => {
        this.owner(params)
        const query = params as { path?: string; defaultOnly?: boolean; frontmost?: boolean }
        return await this.deps.applications(query)
      },

      [APP_METHODS.ALERT]: async (params) => {
        const session = this.owner(params)
        return await this.showAlert(session.info.sessionId, params as AlertRequest)
      },
      [APP_METHODS.CLOSE_WINDOW]: (params) => {
        this.owner(params)
        const { clearRootSearch } = params as { clearRootSearch?: boolean }
        this.deps.closeWindow({ clearRootSearch: clearRootSearch === true })
        return null
      },
      [APP_METHODS.POP_TO_ROOT]: (params) => {
        const session = this.owner(params)
        // `popToRoot` returns to the *root search*, which for us means the
        // command is over — not that its navigation stack shrank to one.
        this.close(session.info.sessionId)
        this.deps.emit('ext.ended', { sessionId: session.info.sessionId, message: null, stack: null })
        return null
      },
      [APP_METHODS.CLEAR_SEARCH_BAR]: (params) => {
        const session = this.owner(params)
        this.deps.emit('ext.command', {
          sessionId: session.info.sessionId,
          action: 'clearSearchBar',
          value: null
        })
        return null
      },
      [APP_METHODS.SELECT_ITEM]: (params) => {
        const session = this.owner(params)
        const { value: itemId } = params as { value?: unknown }
        this.deps.emit('ext.command', {
          sessionId: session.info.sessionId,
          action: 'selectItem',
          value: typeof itemId === 'string' ? itemId : null
        })
        return null
      },
      /**
       * `launchCommand` — one command starting another.
       *
       * The caller is resolved first and only used for the intra-extension case:
       * `{name}` alone means "a sibling of mine", and the extension it is a
       * sibling *of* is the session we already know this worker is, never a name
       * it sends. An inter-extension launch names its target outright, which the
       * spec allows and which is no more than any user could do from the root.
       */
      [APP_METHODS.LAUNCH_COMMAND]: async (params) => {
        const caller = this.owner(params)
        const { name, extensionName, background, context, launchArguments } = params as {
          name?: unknown
          extensionName?: unknown
          background?: unknown
          context?: unknown
          launchArguments?: unknown
        }
        if (typeof name !== 'string' || name.length === 0) {
          throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'launchCommand needs a command name')
        }

        const target = this.deps.commands.find(
          typeof extensionName === 'string' ? extensionName : caller.info.extensionName,
          name
        )
        if (target === null) {
          // The spec's own failure mode: the promise rejects, and the message is
          // what the extension author sees in their own console.
          throw new RpcError(
            RPC_ERRORS.INVALID_PARAMS,
            `no command named "${name}" is installed${typeof extensionName === 'string' ? ` in "${extensionName}"` : ''}`
          )
        }

        const session = await this.launch(target, asRecord(context), {
          launchArguments: asStrings(launchArguments),
          launchType: background === true ? 'background' : 'userInitiated'
        })

        // A background launch is a side effect with no screen. The session still
        // runs; it is simply never presented, which is the whole of what
        // `LaunchType.Background` means to a user.
        if (background !== true) this.deps.commands.present(session)
        return null
      },
      [APP_METHODS.FORM_FOCUS]: (params) => this.formCommand(params, 'focusField'),
      [APP_METHODS.FORM_RESET]: (params) => this.formCommand(params, 'resetField'),
      [APP_METHODS.OPEN_PREFERENCES]: (params) => {
        const session = this.owner(params)
        // Nothing here opens the settings window; the message names the two
        // places that do.
        logger.info('an extension asked to open its preferences', {
          extension: session.info.extensionName
        })
        throw new RpcError(
          RPC_ERRORS.INTERNAL,
          'preferences are edited in the settings window (Plugins) or with `lumanin plugins`.'
        )
      },
      [APP_METHODS.UPDATE_METADATA]: (params) => {
        const session = this.owner(params)
        const { subtitle } = params as { subtitle?: unknown }
        logger.debug('command metadata updated', {
          extension: session.info.extensionName,
          command: session.info.commandName,
          subtitle: typeof subtitle === 'string' ? subtitle : null
        })
        return null
      }
    }
  }

  /**
   * Show an alert and wait for the answer.
   *
   * The token is minted here, in main, and never travels to the worker — it is
   * what pairs an answer with a blocked call, and a worker that could choose one
   * could answer another session's alert.
   */
  private showAlert(sessionId: string, request: AlertRequest): Promise<boolean> {
    const token = `alert-${++alertCounter}`
    return new Promise<boolean>((resolve) => {
      this.alerts.set(token, resolve)
      const payload: AlertPayload = {
        sessionId,
        token,
        title: String(request.title ?? ''),
        ...(request.message === undefined ? {} : { message: String(request.message) }),
        primaryTitle: String(request.primaryTitle ?? 'OK'),
        dismissTitle: String(request.dismissTitle ?? 'Cancel'),
        destructive: request.destructive === true
      }
      this.deps.emit('ext.alert', payload)
    })
  }

  // --- notifications from the host ------------------------------------------

  private onNotification(method: string, params: unknown): void {
    switch (method) {
      case APP_METHODS.RENDER: {
        const render = params as RenderParams
        const session = this.sessions.get(render.sessionId)
        if (session === undefined) return
        // Applied here first, then forwarded. `mutateDocument: false` because the
        // tree we are holding may already have been handed to the renderer inside
        // a `SessionInfo`, and mutating it afterwards would edit a value that has
        // been sent.
        session.tree = applyPatch(
          session.tree,
          render.patches as Operation[],
          false,
          false
        ).newDocument
        session.revision = render.revision
        this.deps.emit('ext.render', render)
        return
      }
      case APP_METHODS.TOAST_SHOW: {
        const toast = params as ToastPayload
        if (!this.sessions.has(toast.sessionId)) return
        this.deps.emit('ext.toast', { sessionId: toast.sessionId, toast })
        return
      }
      case APP_METHODS.TOAST_HIDE: {
        const { sessionId } = params as { sessionId: string }
        this.deps.emit('ext.toast', { sessionId, toast: null })
        return
      }
      case APP_METHODS.HUD: {
        const { title } = params as { title?: unknown }
        this.deps.emit('ext.hud', { title: typeof title === 'string' ? title : '' })
        return
      }
      case APP_METHODS.SESSION_FAILED: {
        const failure = params as SessionFailure
        this.onFailure(failure)
        return
      }
      case APP_METHODS.SESSION_FINISHED: {
        const { sessionId } = params as { sessionId: string }
        this.close(sessionId)
        this.deps.emit('ext.ended', { sessionId, message: null, stack: null })
        return
      }
      case APP_METHODS.LOG: {
        const entry = params as LogParams
        const session = this.sessions.get(entry.sessionId)
        // Tagged with the extension so `lumanin ext log <name>` can find them
        // (ARCHITECTURE.md §Logging). Never with anything from the payload —
        // an extension's log line is its own text and gets no structure of ours.
        this.deps.logger[entry.level]('extension', {
          ...(session === undefined
            ? {}
            : { extension: session.info.extensionName, command: session.info.commandName }),
          sessionId: entry.sessionId,
          message: entry.message
        })
        return
      }
      default:
        this.deps.logger.warn('unknown notification from the extension host', { method })
    }
  }

  /**
   * An extension failed.
   *
   * `fatal` is the difference between an error card and a toast. A crashed
   * worker has no view left to show, so the session ends; a handler that threw
   * has a perfectly good view still on screen and should not lose it because one
   * action went wrong.
   */
  private onFailure(failure: SessionFailure): void {
    const session = this.sessions.get(failure.sessionId)
    this.deps.logger.error('extension failed', {
      ...(session === undefined ? {} : { extension: session.info.extensionName }),
      sessionId: failure.sessionId,
      message: failure.message,
      fatal: failure.fatal
    })

    if (failure.fatal) {
      // Recorded before the delete. A command that throws in its first render
      // fails while `launch` is still awaiting `session.create`, and `launch`
      // holds this object — so writing it here is what lets the crash reach a
      // renderer that has not yet been told the session exists.
      if (session !== undefined) {
        session.failure = { message: failure.message, stack: failure.stack ?? null }
      }
      this.sessions.delete(failure.sessionId)
      this.deps.emit('ext.ended', {
        sessionId: failure.sessionId,
        message: failure.message,
        stack: failure.stack ?? null
      })
      return
    }

    this.deps.emit('ext.toast', {
      sessionId: failure.sessionId,
      toast: {
        id: `error-${failure.sessionId}`,
        sessionId: failure.sessionId,
        style: 'FAILURE',
        title: 'Something went wrong',
        message: failure.message
      }
    })
  }
}

/**
 * The three clipboard fields, and nothing else.
 *
 * An allow-list rather than a spread: the parameters came from a worker, and
 * forwarding whatever else it put in the object would let an extension reach
 * fields of the clipboard service it was never given.
 */
function pick(content: Record<string, unknown>): { text?: string; html?: string; file?: string } {
  const text = content['text']
  const html = content['html']
  const file = content['file']
  return {
    ...(typeof text === 'string' ? { text } : {}),
    ...(typeof html === 'string' ? { html } : {}),
    ...(typeof file === 'string' ? { file } : {})
  }
}

function key(params: unknown): string {
  const value = (params as { key?: unknown }).key
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'storage needs a key')
  }
  return value
}

function value(params: unknown): StorageValue {
  const raw = (params as { value?: unknown }).value
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw
  throw new RpcError(
    RPC_ERRORS.INVALID_PARAMS,
    'LocalStorage takes a string, number or boolean - serialise anything else yourself'
  )
}

/** `launchCommand`'s `context`, which the spec allows to be anything or nothing. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * `launchCommand`'s `arguments`, narrowed to what a manifest argument can be.
 *
 * Non-strings are dropped rather than coerced: `arguments` are typed as strings
 * on the receiving side, and an argument that arrived as a number would reach
 * the target command as one and fail on its first `.trim()`.
 */
function asStrings(value: unknown): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [name, entry] of Object.entries(asRecord(value))) {
    if (typeof entry === 'string') out[name] = entry
  }
  return out
}
