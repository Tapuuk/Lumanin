import type { EscAtRoot, ResolvedConfig } from './config'
import type { Hotkey } from './hotkey'
import type { KeyMap } from './keys'
import type { EnumeratedItem } from './render-tree'
import type { CommandMode } from './extension'
import type { AlertPayload, RenderParams, ToastPayload } from './ext-protocol'
import type { RenderNode } from './render-tree'
import type { DaemonStatus } from './protocol'
import type { Theme } from './theme/tokens'

/**
 * The renderer ↔ main contract (`docs/ARCHITECTURE.md` §"Renderer ↔ main").
 *
 * The renderer is dumb: it renders trees and forwards user intents. It has no Node
 * access and no privileges — everything crosses this typed bridge, over exactly two
 * Electron channels, through a method allow-list checked in main.
 *
 * Methods are namespaced `platform.* | ext.* | store.* | theme.* | builtin.*`
 * plus `app.*`/`window.*` for daemon control. M0 defines the window and theme
 * slice; later milestones add namespaces without changing the transport.
 */

export const INVOKE_CHANNEL = 'lumanin:invoke'
export const EVENT_CHANNEL = 'lumanin:event'

/** The theme as the renderer consumes it: metadata plus ready-to-apply CSS vars. */
export interface ThemePayload {
  readonly meta: Theme['meta']
  readonly cssVars: Readonly<Record<string, string>>
  /** Whether the compositor actually granted background blur (PLATFORM-MATRIX §12). */
  readonly blurGranted: boolean
  /**
   * The zoom the main process applies to the window: the text size wanted
   * (the desktop's - Omarchy's shell font, GNOME's text-scaling-factor - unless
   * `[appearance].text_scale` says otherwise) divided by what Chromium's toolkit
   * has already scaled by on its own. Rides along here so both frontends can say
   * what is in effect.
   */
  readonly textScale: number
}

/** Where Esc was pressed. `esc_at_root` only governs the root — see `escapeAction`. */
export interface EscapeParams {
  /**
   * True when there is nothing left to back out of: no query typed and, from M4,
   * no extension view pushed on the navigation stack.
   */
  readonly atRoot: boolean
}

/** What Esc did, so the renderer can mirror it. */
export interface EscapeResult {
  readonly action: EscAtRoot
}

/**
 * What a row *is*, which is also what Enter does to it.
 *
 * The renderer needs this to label the action — "Open", "Copy", "Search" — and
 * main needs it to dispatch. Both read it off the row rather than re-deriving it,
 * so a row can never be labelled one thing and do another.
 */
export const RESULT_KINDS = ['app', 'command', 'calculator', 'web', 'extension', 'shell'] as const
export type ResultKind = (typeof RESULT_KINDS)[number]

/** One row in the results list. */
export interface ResultItem {
  /**
   * `<kind>:<payload>` — namespaced so main can dispatch on it without a lookup
   * table, and so a desktop-file id can never be confused with a URL to open.
   * Opaque to the renderer, which only ever hands it back.
   */
  readonly id: string
  readonly title: string
  /** Second line: the answer for a calculation, the URL for a search. */
  readonly subtitle?: string
  readonly kind: ResultKind
  /**
   * A `lumanin-icon:` URL, absent when the app has no resolvable icon.
   *
   * Not a filesystem path: the renderer is sandboxed, and handing it real paths
   * would both leak the layout of the machine and let a future extension-supplied
   * result point at any file on disk. Main resolves and serves.
   */
  readonly icon?: string
  /**
   * A mark drawn over the icon.
   *
   * `'search'` is the three dots that stamp a plugin's "Search X" row: the icon
   * underneath is the *target's* — Godot's, Steam's — and without the mark the
   * row would be indistinguishable from the application it fronts. Drawn by the
   * renderer rather than baked into an image so it is identical on every row
   * and recolours with the theme.
   */
  readonly badge?: 'search'
}

/** What happened when the user pressed Enter. */
export interface LaunchOutcome {
  readonly ok: boolean
  /** Shown to the user only on failure; logged either way. */
  readonly detail: string
  /**
   * Present only when Enter started an extension command.
   *
   * The panel does not close for one of these — it becomes the extension's view
   * — so the daemon uses this field to decide whether to hide, and the renderer
   * uses it to know what it is now showing. A launch outcome that says `ok` and
   * nothing else still means "we are done here", which is what every other kind
   * of row wants.
   */
  readonly session?: SessionInfo
}

/** The identity of a running extension command, as the renderer needs it. */
export interface SessionInfo {
  readonly sessionId: string
  readonly extensionName: string
  readonly extensionTitle: string
  readonly commandName: string
  readonly commandTitle: string
  readonly mode: CommandMode
  /**
   * The tree as it already stands, and the revision it is at.
   *
   * A command renders **before** `launch` resolves — the worker mounts it during
   * `session.create` — so by the time the renderer is told a session exists, it
   * has already missed a patch batch. Without this snapshot the next batch would
   * be applied to an empty document and produce a tree that never existed on
   * either side. Handing over the current state closes that window instead of
   * racing it.
   */
  readonly tree: RenderNode
  readonly revision: number
  /**
   * Set when the command died before the renderer knew the session existed.
   *
   * The same race as `tree`, one step worse. A command that throws in its first
   * render fails *during* `session.create`, so `ext.ended` is emitted while the
   * renderer's idea of the active session is still `null` — and an event for a
   * session nobody is watching is dropped, correctly. The renderer then received
   * a perfectly good `SessionInfo` for a command that was already dead and drew
   * an empty panel with no error and no way back except Escape.
   *
   * Found by running `markdown-reference`, which used `ActionPanel.Item` — a
   * deprecated member the shim did not have — and so threw on its first render
   * every time, silently.
   */
  readonly failure: { readonly message: string; readonly stack: string | null } | null
  /**
   * An item id the launch asked to land on — a pinned item, or a hotkey with
   * one. The renderer selects the row with this `id` prop once it exists, and
   * only until the user moves the cursor themselves.
   */
  readonly select: string | null
  /**
   * Whether this session was opened *as* the panel, with no root list behind it.
   *
   * True for the `open` verb — a key bound straight to a command, which is the
   * only way into file search. Escape at the bottom of such a session closes the
   * window rather than revealing a launcher the user did not ask for.
   *
   * **Absent means "unchanged"**, which is what `launchCommand` needs: it
   * replaces the session in place, and whether there is a root list behind it is
   * a fact about how the *first* one started. Inferring it instead — "is a
   * session running right now" — looked equivalent and was not: the host may end
   * the outgoing session before it announces the incoming one, and in that gap
   * every launch looks like the first.
   */
  readonly standalone?: boolean
}

/** The action label for a row, so the renderer never invents one. */
export const ACTION_LABELS: Readonly<Record<ResultKind, string>> = {
  app: 'Open',
  command: 'Run',
  calculator: 'Copy',
  web: 'Search',
  extension: 'Run',
  shell: 'Run'
}

export interface InvokeMap extends SettingsInvokeMap {
  'app.status': { params: undefined; result: DaemonStatus }
  /** Dismiss the panel — the backdrop was clicked, or a built-in asked to close. */
  'window.hide': { params: undefined; result: void }
  /**
   * Root search. Ranking lives in main, not the renderer: it needs the index and
   * the frecency database, and shipping either across the bridge on every
   * keystroke would cost more than the scoring does.
   */
  'search.query': { params: { query: string }; result: readonly ResultItem[] }
  /** Launch a result. The daemon hides the panel itself on success. */
  'search.launch': { params: { id: string }; result: LaunchOutcome }
  /**
   * Esc pressed. Main owns the decision because it depends on
   * `[general].esc_at_root`; the renderer only reports the keypress, says whether
   * it was at the root, and reacts to the answer. (Inside an extension session
   * Esc pops the navigation stack instead — that path arrives with the host in M4.)
   */
  'window.escape': { params: EscapeParams; result: EscapeResult }
  'theme.current': { params: undefined; result: ThemePayload }
  /**
   * The panel's own keybindings (`[keys]`).
   *
   * Fetched rather than compiled in, because they are a setting now: the
   * renderer asks once on load and is pushed a new map whenever `config.toml`
   * changes, the same shape the theme already has. Matching stays in the
   * renderer — the alternative is a round trip on every keystroke, on the one
   * path in this application that is measured in milliseconds.
   */
  'keys.current': { params: undefined; result: KeyMap }

  // --- Extensions (M4). The renderer holds no extension state of its own: it
  // plays the tree the worker sends and forwards what the user did to it.
  /**
   * A user interaction reached a function prop. `handlerId` came out of the tree.
   *
   * This is the only channel: typing in the search bar dispatches the `List`'s
   * own `onSearchTextChange` handler through here rather than through a method of
   * its own, so there is one path from "the user did something" to "the worker
   * hears about it" and no second one to keep in step.
   */
  'ext.event': { params: { sessionId: string; handlerId: string; payload?: unknown }; result: void }
  /** Back out one navigation level. Only sent when the tree says there is one. */
  'ext.pop': { params: { sessionId: string }; result: void }
  /** End the session — Esc at the extension's root, or the panel being dismissed. */
  'ext.close': { params: { sessionId: string }; result: void }
  /** Rebuild and remount, for `lumanin ext dev` and the error card's Reload action. */
  'ext.reload': { params: { sessionId: string }; result: void }
  /**
   * Re-fetch the whole tree.
   *
   * The renderer's last line of defence: a patch batch whose revision is not the
   * one after the last applied means something was missed, and a patch applied
   * to the wrong base does not fail loudly — it silently produces a document
   * that never existed. Resyncing is the only correct response, and main can
   * always answer because it materialises the tree as the patches pass through.
   */
  'ext.attach': { params: { sessionId: string }; result: { tree: RenderNode; revision: number } | null }
  /** The answer to a `confirmAlert`, which the worker is blocked on. */
  'ext.alertAnswer': { params: { token: string; confirmed: boolean }; result: void }
  /**
   * Close the settings window. Its renderer's Esc and its titlebar button both
   * land here — the window is main's, so the renderer asks rather than acts.
   */
  'settings.close': { params: undefined; result: void }
  /**
   * `Form.FilePicker` — the desktop's own open dialog.
   *
   * It has to be main's: a renderer with `nodeIntegration` off cannot open one,
   * and a path is exactly the kind of thing the renderer is not trusted to
   * invent. Main also holds the panel open while the dialog is up, or the blur
   * would hide the form the user is half-way through filling in.
   */
  'ext.pickFiles': {
    params: { sessionId: string; directories?: boolean; multiple?: boolean }
    result: readonly string[]
  }
}

// ---------------------------------------------------------------------------
// The settings app's own surface. These methods exist only in the settings
// process — the daemon never registers them — but they live in this one typed
// map so the preload bridge stays a single implementation.
// ---------------------------------------------------------------------------

/**
 * Everything the settings renderer needs to draw itself, in one snapshot.
 * Pushed again as `settings.changed` whenever `config.toml` changes on disk —
 * whichever of the three writers (this app, the CLI, an editor) changed it.
 */
export interface SettingsState {
  readonly resolved: ResolvedConfig
  readonly configPath: string
  /** Set when the file exists but does not parse; editing is then refused. */
  readonly parseError: string | null
  /** Theme packs the daemon-side chain can name: built-ins, user packs. */
  readonly themes: readonly { readonly value: string; readonly label: string }[]
  /** `hyprland/wayland`, `gnome/x11`, … — for the hotkey screen's wording. */
  readonly desktop: string
  /** Whether this desktop has a bind mechanism we know how to write. */
  readonly bindable: boolean
  /** Whether a daemon answered the socket just now. */
  readonly daemonRunning: boolean
  /**
   * True on a machine that has never been set up: no `config.toml`, and the
   * wizard has not been completed or dismissed. What opens the first-run flow.
   */
  readonly firstRun: boolean
}

/**
 * The whole desktop-integration plan — `doctor --fix`, as the wizard shows it:
 * window rules, keybind, autostart, systemd unit. Same DTO discipline as
 * {@link BindPlanDto}: a description, never an instruction.
 */
export interface SetupPlanDto extends BindPlanDto {
  /** Steps that need root or a relogin — printed, never run. */
  readonly manual: readonly { readonly title: string; readonly why: string; readonly commands: readonly string[] }[]
}

/** What `settings.set` accepts. `null` deletes the key (back to the default). */
export type SettingsSetValue = string | number | boolean | readonly string[] | null

/** One `[[hotkeys]]` entry as the settings app edits it. */
export interface HotkeyEntryDto {
  /** `formatHotkey` spelling, e.g. `Super+Shift+G`. */
  readonly hotkey: string
  readonly target: string
  /** Stored display title for plugin-item targets. */
  readonly title?: string
}

/**
 * A bind plan, serialised. The real `BindPlan` carries `FixAction`s — regexes
 * and functions — which cannot cross the bridge, and must not: the renderer is
 * shown the plan and consents, and main re-plans from disk before applying, so
 * a compromised renderer cannot smuggle an edit into the apply step.
 */
export interface BindPlanDto {
  readonly edits: readonly {
    readonly path: string
    readonly state: 'up-to-date' | 'will-add' | 'will-update' | 'blocked' | 'not-applicable'
    readonly diff: string
    readonly problem?: string
  }[]
  /** GNOME's dconf writes: no file, so the exact command lines are the diff. */
  readonly commands: readonly { readonly title: string; readonly preview: readonly string[] }[]
  readonly notes: readonly string[]
  /** True when applying would change anything at all. */
  readonly pending: boolean
}

export interface ApplyBindDto {
  readonly results: readonly { readonly target: string; readonly ok: boolean; readonly detail?: string }[]
  readonly notes: readonly string[]
}

/** `ManagedBind`, shaped for the bridge (the original lives in platform code). */
export interface ManagedBindDto {
  readonly path: string
  readonly keyText: string
  readonly hotkey: Hotkey | null
  /** The `open` target, or `null` for the toggle bind. */
  readonly target: string | null
}

export interface PluginCommandDto {
  /** `<extension>/<command>` — what `[extensions].disabled` stores. */
  readonly id: string
  readonly name: string
  readonly title: string
  readonly description: string
  readonly enabled: boolean
  readonly root: boolean
  readonly categories: readonly { readonly id: string; readonly title: string }[]
}

export interface PluginPreferenceDto {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly type: string
  readonly required: boolean
  readonly placeholder?: string
  readonly label?: string
  readonly data?: readonly { readonly title: string; readonly value: string }[]
  /** The manifest default, shown as the placeholder when nothing is stored. */
  readonly default?: string | number | boolean
  /** What the user stored, if anything. */
  readonly value?: string | number | boolean
}

/** Preferences grouped the way they are declared: extension-wide, then per command. */
export interface PluginPreferenceGroupDto {
  /** `''` for extension-wide preferences, else the command name. */
  readonly command: string
  readonly title: string
  readonly preferences: readonly PluginPreferenceDto[]
}

export interface PluginDto {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly author: string
  readonly bundled: boolean
  readonly enabled: boolean
  /** Where it came from, when installed from a repository. */
  readonly origin: string | null
  readonly commands: readonly PluginCommandDto[]
  readonly preferenceGroups: readonly PluginPreferenceGroupDto[]
}

/** What `settings.inspectPlugin` answers before anything is built. */
export interface PluginInspectionDto {
  readonly ok: boolean
  readonly error?: string
  readonly name?: string
  readonly title?: string
  readonly description?: string
  readonly author?: string
  readonly commands?: readonly string[]
  readonly dependencies?: readonly string[]
  readonly commit?: string
  readonly label?: string
  /** True when a plugin of this name is already installed. */
  readonly replacing?: boolean
  /** The checked-out directory, so "read it first" can name a real path. */
  readonly directory?: string
}

/** One entry of the official plugin index (the Lumanin-Plugins repository). */
export interface OfficialPluginDto {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly author: string
  /** The browse URL of the plugin's folder — what plugin-install takes. */
  readonly source: string
  /** A plugin of this name is already installed. */
  readonly installed: boolean
}

/** What `settings.exportPlugin` hands back. */
export interface PluginExportDto {
  readonly ok: boolean
  readonly detail?: string
  /** The exported directory, on success. */
  readonly directory?: string
  /** The remote it was originally installed from, when that is on record. */
  readonly publishedAt?: string
  /** `gh` is installed and signed in, so publishing can be offered. */
  readonly ghReady?: boolean
}

export interface SettingsInvokeMap {
  'settings.state': { params: undefined; result: SettingsState }
  /**
   * Write one setting. The path must be on the model's closed allow-list —
   * same rule as the verb set, so the renderer can never name an arbitrary
   * TOML key. A value equal to the built-in default deletes the key instead,
   * so defaults stay free to improve underneath a config that never disagreed.
   */
  'settings.set': {
    params: { path: readonly string[]; value: SettingsSetValue }
    result: { ok: boolean; detail?: string }
  }
  /** Replace the whole `[[hotkeys]]` list. */
  'settings.setHotkeys': {
    params: { entries: readonly HotkeyEntryDto[] }
    result: { ok: boolean; detail?: string }
  }
  /**
   * Replace `[search].pins`. Entries with a title are written as `{ id, title }`
   * tables — a plugin row's name exists only while its plugin runs.
   */
  'settings.setPins': {
    params: { entries: readonly { key: string; title: string | null }[] }
    result: { ok: boolean; detail?: string }
  }
  /** Set or (with `key: null`) delete one `[aliases]` entry. */
  'settings.setAlias': {
    params: { alias: string; key: string | null; title: string | null }
    result: { ok: boolean; detail?: string }
  }
  /** Plan the compositor/desktop writes that would make the config's keys real. */
  'settings.planBind': { params: undefined; result: BindPlanDto }
  /** Apply what `planBind` showed. Main re-plans from disk; see `BindPlanDto`. */
  'settings.applyBind': { params: undefined; result: ApplyBindDto }
  /** The binds actually present in the desktop's config right now. */
  'settings.readBinds': { params: undefined; result: readonly ManagedBindDto[] }
  /** Installed applications, for the pickers. */
  'settings.apps': { params: undefined; result: readonly { id: string; title: string }[] }
  /** Ask a running plugin what rows a category holds (via the daemon). */
  'settings.enumerate': {
    params: { command: string; category: string | null }
    result: readonly EnumeratedItem[]
  }
  'settings.plugins': { params: undefined; result: readonly PluginDto[] }
  'settings.setPluginEnabled': {
    params: { name: string; enabled: boolean }
    result: { ok: boolean; detail?: string }
  }
  'settings.setCommandEnabled': {
    params: { id: string; enabled: boolean }
    result: { ok: boolean; detail?: string }
  }
  'settings.setPreference': {
    params: { extension: string; command: string; name: string; value: string | number | boolean }
    result: { ok: boolean; detail?: string }
  }
  'settings.removePlugin': { params: { name: string }; result: { ok: boolean; detail?: string } }
  /** Copy a plugin's source into Downloads as a publishable directory. */
  'settings.exportPlugin': {
    params: { name: string; license: 'mit' | null }
    result: PluginExportDto
  }
  /**
   * Create a public GitHub repository for an export and push it, via `gh`.
   * Main recomputes the directory from the name — no paths cross this wire.
   */
  'settings.publishPlugin': {
    params: { name: string }
    result: { ok: boolean; detail: string; url?: string }
  }
  /**
   * The official index, fetched on an explicit click — the launcher's one
   * outbound request that is not an install, and it is user-initiated too.
   */
  'settings.officialPlugins': {
    params: undefined
    result: { ok: boolean; error?: string; plugins: readonly OfficialPluginDto[] }
  }
  /** Fetch and describe, so the consent screen shows facts, not the URL. */
  'settings.inspectPlugin': { params: { source: string }; result: PluginInspectionDto }
  'settings.installPlugin': {
    params: { source: string; allowDependencies: boolean }
    result: { ok: boolean; detail: string }
  }
  /** For the width/height notice — the panel window is created once. */
  'settings.restartDaemon': { params: undefined; result: { ok: boolean } }
  /** The wizard's desktop-integration step: the full `doctor --fix` plan. */
  'settings.planSetup': { params: undefined; result: SetupPlanDto }
  /** Apply it — file edits, commands, and enabling the systemd unit. */
  'settings.applySetup': { params: undefined; result: ApplyBindDto }
  /** The wizard was completed or dismissed; never open it again unasked. */
  'settings.finishFirstRun': { params: undefined; result: void }
}

export type InvokeMethod = keyof InvokeMap

export const INVOKE_METHODS = [
  'app.status',
  'window.hide',
  'window.escape',
  'theme.current',
  'keys.current',
  'search.query',
  'search.launch',
  'ext.event',
  'ext.pop',
  'ext.close',
  'ext.reload',
  'ext.attach',
  'ext.alertAnswer',
  'ext.pickFiles',
  'settings.close'
] as const satisfies readonly InvokeMethod[]

/**
 * What the settings app's renderer may invoke. The settings app is a separate
 * process with its own `ipcMain`, so this is its whole method surface — the
 * daemon never answers any of it, and the panel's methods never appear here.
 * Grows with the settings screens.
 */
export const SETTINGS_INVOKE_METHODS = [
  'theme.current',
  'settings.close',
  'settings.state',
  'settings.set',
  'settings.setHotkeys',
  'settings.setPins',
  'settings.setAlias',
  'settings.planBind',
  'settings.applyBind',
  'settings.readBinds',
  'settings.apps',
  'settings.enumerate',
  'settings.plugins',
  'settings.setPluginEnabled',
  'settings.setCommandEnabled',
  'settings.setPreference',
  'settings.removePlugin',
  'settings.exportPlugin',
  'settings.publishPlugin',
  'settings.officialPlugins',
  'settings.inspectPlugin',
  'settings.installPlugin',
  'settings.restartDaemon',
  'settings.planSetup',
  'settings.applySetup',
  'settings.finishFirstRun'
] as const satisfies readonly InvokeMethod[]

export interface EventMap {
  'window.visibility': { visible: boolean }
  /**
   * A session the *daemon* started — `lumanin open` from a hotkey bind. The
   * renderer treats it exactly like the session a `search.launch` reply
   * carries; this event exists because that launch had no renderer to reply to.
   */
  'ext.started': SessionInfo
  'theme.changed': ThemePayload
  /** `[keys]` changed on disk. Same contract as `theme.changed`. */
  'keys.changed': KeyMap
  /** A batch of JSON Patch operations for one session's tree. */
  'ext.render': RenderParams
  /** `null` hides the toast; anything else shows or replaces it. */
  'ext.toast': { sessionId: string; toast: ToastPayload | null }
  /** `showHUD`: a line of text that outlives the panel it was shown from. */
  'ext.hud': { title: string }
  /** `confirmAlert`: a modal the worker is waiting on. Answered by `ext.alertAnswer`. */
  'ext.alert': AlertPayload
  /** The session is over — cleanly, or with a message and a stack to show. */
  'ext.ended': { sessionId: string; message: string | null; stack: string | null }
  /**
   * An imperative instruction from the worker to the view: clear the search bar,
   * select an item, focus or reset a form field. `value` names the target where
   * one is needed — an item id, or a form field's `id` prop.
   */
  'ext.command': {
    sessionId: string
    action: 'clearSearchBar' | 'selectItem' | 'focusField' | 'resetField'
    value: string | null
  }
  /** The settings app: `config.toml` changed on disk, whoever wrote it. */
  'settings.changed': SettingsState
  /** One progress line from a plugin fetch or build in flight. */
  'settings.installProgress': { line: string }
}

export type EventName = keyof EventMap

/** The shape exposed on `window.lumanin` by the preload bridge. */
export interface LumaninBridge {
  invoke<M extends InvokeMethod>(
    method: M,
    params?: InvokeMap[M]['params']
  ): Promise<InvokeMap[M]['result']>
  /** Returns an unsubscribe function. */
  on<E extends EventName>(event: E, listener: (payload: EventMap[E]) => void): () => void
}

/** The envelope main pushes over {@link EVENT_CHANNEL}. */
export interface EventEnvelope {
  readonly event: EventName
  readonly payload: EventMap[EventName]
}
