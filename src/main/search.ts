import { statSync, watch, type FSWatcher } from 'node:fs'
import { rank } from '../shared/frecency'
import { parseExtensionPin, type ResolvedConfig } from '../shared/config'
import type { LaunchOutcome, ResultItem } from '../shared/ipc'
import { isOpenableUrl } from '../shared/websearch'
import { composeRoot, shellRow, type RootCommand, type ScoredRow } from './root-search'
import { matchFields, type MatchTier } from '../shared/fuzzy'
import { applicationDirectories, buildAppIndex, type AppIndexStats } from '../platform/apps/index'
import type { DesktopEntry } from '../platform/apps/desktop-entry'
import { createIconResolver, type IconResolver } from '../platform/apps/icons'
import { launchEntry, runShellCommand, type LaunchResult } from '../platform/apps/launch'
import type { BinaryMap } from '../platform/probe/binaries'
import { resolveBinary } from '../platform/probe/binaries'
import type { FrecencyStore } from '../node/frecency-store'
import type { Logger } from '../node/logger'

/**
 * Root search: the application index, ranked.
 *
 * Everything here is synchronous and in memory, because it runs on every
 * keystroke. Scoring a few thousand entries is microseconds of arithmetic; going
 * to disk or to another process for it would not be.
 *
 * The searchable fields are weighted rather than concatenated. Concatenating
 * name, generic name, comment and keywords into one haystack lets a match
 * scattered across three of them outrank a clean match in the name — which is
 * how "Files" ends up below "Disk Usage Analyzer" for the query "file".
 */

/**
 * The searchable fields, and how much a match in each is worth.
 *
 * **Only `name` is the name.** Everything else is a way of *finding* an
 * application, not what it is called, and `matchFields` reports a match in one
 * of them as `NOT_NAME` — which the composer drops outright whenever any name
 * matched. Typing "draw" returned Pinta above nothing else useful, because its
 * `Keywords=` line starts `draw;drawing;paint;`: a perfect prefix match, of a
 * keyword. If you want to draw in Pinta you type `pinta`.
 *
 * `Comment=` is gone entirely. It is a sentence of prose — "Easily create and
 * edit images" — and the only queries it answers are ones another field answers
 * better. It was how "files" found Neovim.
 */
const FIELD_WEIGHTS = {
  /** What the user sees and therefore what they are typing at. */
  name: 1,
  /** "Web Browser" for Firefox: a real intent, but not what they called it. */
  genericName: 0.75,
  /** Deliberately below the name so "browser" cannot beat a real name match. */
  keywords: 0.6,
  /** Typing a binary name is a power-user path worth supporting, quietly. */
  exec: 0.3
} as const

/** Below this, a match is noise — a few scattered letters in a long description. */
const SCORE_FLOOR = 12

/**
 * What Enter can do, injected rather than imported.
 *
 * Copying and opening a URL are Electron's job, and this module has stayed free
 * of Electron so it can be unit-tested without one. Keeping that seam is the
 * difference between testing the dispatch table and testing nothing.
 */
export interface RootActions {
  copy(text: string): void
  openUrl(url: string): void
  /** Runs a registered root command by id. */
  runCommand(id: string): LaunchOutcome | Promise<LaunchOutcome>
  /** Starts an extension command (`<extension>/<command>`) and returns its session. */
  runExtension(
    id: string,
    context: Readonly<Record<string, unknown>>
  ): LaunchOutcome | Promise<LaunchOutcome>
  /**
   * Runs one action on one row of a plugin's list, with no window.
   *
   * Never returns a session: the point of naming an action is that pressing the
   * key does the thing instead of showing you where the thing is.
   */
  runExtensionAction(
    id: string,
    category: string,
    item: string,
    action: string
  ): LaunchOutcome | Promise<LaunchOutcome>
}

export interface SearchDeps {
  /**
   * Read on every query rather than captured, so `lumanin reload` can hand the
   * daemon a new one without rebuilding the index it took disk to make.
   */
  readonly config: () => ResolvedConfig
  /**
   * Read per query, like {@link SearchDeps.config}: the list grows and shrinks as
   * extensions are installed and removed, and a snapshot taken at startup would
   * mean a freshly installed extension needed a restart to appear.
   */
  readonly commands: () => readonly RootCommand[]
  readonly actions: RootActions
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  readonly desktops: readonly string[]
  readonly binaries: BinaryMap
  readonly frecency: FrecencyStore
  readonly logger: Logger
  /** Overrides the XDG directory list. Tests only; production leaves it unset. */
  readonly directories?: readonly string[]
}

/**
 * How long to wait for a package transaction to settle before re-indexing.
 *
 * Installing one package writes, renames and chmods a handful of files, and
 * installing a group does that hundreds of times. Rebuilding per event would
 * mean rebuilding hundreds of times for one `pacman -S`; the debounce collapses
 * a transaction into a single rebuild.
 */
const REINDEX_DEBOUNCE_MS = 750

/**
 * How long an index may stand unverified while a directory is unwatched.
 *
 * Only reachable while some existing application directory has no watcher on
 * it: an edit inside such a directory changes nothing the show-path check can
 * see, so time is the only remaining signal. With every directory watched there
 * is no time-based rebuild at all.
 */
const UNWATCHED_STALE_AFTER_MS = 60_000

/**
 * How long a show waits before the rebuild it asked for runs.
 *
 * Long enough that the build cannot land in the frames the renderer spends
 * drawing its first list, short enough that the fresh index is there before
 * anyone has finished typing.
 */
const SHOW_REBUILD_DELAY_MS = 150

/**
 * The modification time of each directory that exists, keyed by path.
 *
 * A directory that is missing or unreadable is left out rather than recorded as
 * absent, so it appearing or becoming readable reads as a difference. Stats are
 * guarded because this runs on the show path, where a throw would take out
 * unrelated work: `throwIfNoEntry` covers a missing path, the catch covers a
 * path that exists but cannot be stat'd.
 */
export function directoryMtimes(directories: readonly string[]): ReadonlyMap<string, number> {
  const mtimes = new Map<string, number>()
  for (const directory of directories) {
    try {
      const stat = statSync(directory, { throwIfNoEntry: false })
      if (stat !== undefined) mtimes.set(directory, stat.mtimeMs)
    } catch {
      // Unreadable: treated exactly as missing.
    }
  }
  return mtimes
}

/** Whether two directory snapshots describe the same set of directories at the same times. */
export function sameMtimes(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false
  for (const [directory, mtime] of a) {
    if (b.get(directory) !== mtime) return false
  }
  return true
}

/** Built once so the two places that construct a row cannot spell it differently. */
const ICON_URL_PREFIX = 'lumanin-icon://app/'

export class SearchService {
  private entries: readonly DesktopEntry[] = []
  private byId = new Map<string, DesktopEntry>()
  private stats: AppIndexStats | null = null
  private readonly icons: IconResolver
  private watchers: FSWatcher[] = []
  private pending: NodeJS.Timeout | null = null
  private indexedAt = 0
  private dirMtimes: ReadonlyMap<string, number> = new Map()

  constructor(private readonly deps: SearchDeps) {
    this.icons = createIconResolver({ env: deps.env, home: deps.home })
  }

  /** The icon file for a result, for the protocol handler to serve. */
  iconPath(id: string): string | null {
    const entry = this.byId.get(id)
    return entry === undefined ? null : this.icons.resolve(entry.icon)
  }

  /**
   * An icon from the desktop's own theme, by name.
   *
   * The same resolver the application index uses, pointed at the categories a
   * *file* icon lives in. This is what makes a listing look like the file
   * manager the user already has — Breeze on KDE, Adwaita on GNOME, whatever
   * they installed — rather than like a set of glyphs we drew.
   *
   * Names are tried in order, so a caller can ask for the specific icon and name
   * the generic one after it: a theme is free to ship any subset, and a missing
   * `text-x-python` should fall back to a page rather than to nothing.
   */
  themeIconPath(names: readonly string[]): string | null {
    return this.icons.resolveFirst(names, ['mimetypes', 'places', 'apps', 'devices', 'status'])
  }

  get indexStats(): AppIndexStats | null {
    return this.stats
  }

  /**
   * The installed applications, in `@raycast/api`'s `Application` shape.
   *
   * Backed by the same `.desktop` index the launcher searches, so an extension's
   * `getApplications()` sees exactly what the user sees — rather than a second
   * enumeration that could disagree with the list right above it.
   *
   * `path` is the desktop entry, not the executable. That is the identifier the
   * rest of the desktop uses (it is what `gio launch` takes), and it is the one
   * that survives a package updating the binary underneath it.
   */
  applications(): readonly { name: string; path: string; bundleId: string }[] {
    return this.entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      // The closest honest analogue of a bundle id on Linux: the desktop-file id,
      // which is unique, stable, and what `.desktop`-aware tooling names apps by.
      bundleId: entry.id
    }))
  }

  /**
   * Watch the application directories so an app installed while the daemon is
   * running shows up without a restart.
   *
   * `fs.watch` with `recursive: true` rather than a dependency: Node has had
   * recursive inotify watches on Linux since v20, and these are a handful of
   * small directories. Watches are best-effort — a container or a low
   * `fs.inotify.max_user_watches` can refuse them — which is why
   * {@link refreshIfStale} exists as the backstop rather than as an optimisation.
   */
  watch(): void {
    for (const directory of this.stats?.directories ?? []) {
      try {
        const watcher = watch(directory, { recursive: true, persistent: false }, () => {
          this.scheduleReindex()
        })
        watcher.on('error', (error: unknown) => {
          this.deps.logger.warn('stopped watching an application directory', { directory, error })
        })
        this.watchers.push(watcher)
      } catch (error) {
        // Not fatal, and not silent: the user should be able to find out why a
        // freshly installed app needed a restart to appear.
        this.deps.logger.warn('could not watch an application directory', { directory, error })
      }
    }

    this.deps.logger.info('watching application directories', { count: this.watchers.length })
  }

  /** Where the index is looked for: the test override, or the XDG list. */
  private directoryList(): readonly string[] {
    return this.deps.directories ?? applicationDirectories(this.deps.env, this.deps.home)
  }

  private scheduleReindex(delayMs = REINDEX_DEBOUNCE_MS): void {
    if (this.pending !== null) clearTimeout(this.pending)
    this.pending = setTimeout(() => {
      this.pending = null
      this.reindex()
    }, delayMs)
    // The daemon must still be able to exit while a rebuild is pending.
    this.pending.unref?.()
  }

  /**
   * Rebuild if something under the application directories moved, off the
   * critical path.
   *
   * Called just after the panel is shown. Every show used to rebuild, because a
   * launcher is opened far less often than once every few seconds and a
   * time-based rule therefore always said "stale"; the whole walk ran in the
   * few milliseconds the renderer spends asking for its first list. What runs
   * now is one stat per candidate directory, compared against the snapshot
   * taken at the last build — installing or removing an application changes the
   * containing directory's modification time, so the common case is a handful
   * of stats and no work.
   *
   * This is what makes freshness a guarantee rather than a hope. The watchers
   * catch installs instantly when they work; this catches everything else —
   * watch limits, directories that did not exist at startup, a Flatpak remote
   * added after launch. Where a directory exists with no watcher on it, an edit
   * inside it is invisible to both, so the index is rebuilt on age alone.
   *
   * The rebuild itself is armed on a short timer rather than run here, so it
   * cannot land inside the frames right after the show; a second show while one
   * is armed neither queues another nor pushes it further out.
   */
  refreshIfStale(): void {
    if (this.pending !== null) return

    if (this.indexedAt === 0) {
      this.scheduleReindex(SHOW_REBUILD_DELAY_MS)
      return
    }

    if (!sameMtimes(directoryMtimes(this.directoryList()), this.dirMtimes)) {
      this.scheduleReindex(SHOW_REBUILD_DELAY_MS)
      return
    }

    const unwatched = this.watchers.length < (this.stats?.directories.length ?? 0)
    if (unwatched && Date.now() - this.indexedAt >= UNWATCHED_STALE_AFTER_MS) {
      this.scheduleReindex(SHOW_REBUILD_DELAY_MS)
    }
  }

  reindex(): void {
    const directories = this.directoryList()
    // Snapshotted before the walk, so a write that lands during the build is
    // seen by the next check rather than swallowed by this one.
    const mtimes = directoryMtimes(directories)

    const { entries, stats } = buildAppIndex({
      env: this.deps.env,
      home: this.deps.home,
      desktops: this.deps.desktops,
      directories
    })

    const changed = stats.found !== this.stats?.found || this.indexedAt === 0

    this.entries = entries
    this.byId = new Map(entries.map((entry) => [entry.id, entry]))
    this.stats = stats
    this.dirMtimes = mtimes
    this.indexedAt = Date.now()

    // Quiet on a rebuild that found the same thing — the watchers fire on every
    // chmod and mtime touch, and a log line per rebuild would bury everything
    // else during a system upgrade.
    if (!changed) {
      this.deps.logger.debug('application index rebuilt, unchanged', { apps: stats.found })
      return
    }

    this.deps.logger.info('application index built', {
      apps: stats.found,
      shadowed: stats.shadowed,
      skipped: stats.skipped,
      directories: stats.directories.length,
      ms: stats.elapsedMs
    })
  }

  /**
   * The root list: applications, commands, a calculation, a web search.
   *
   * Composition lives in `root-search.ts` and the application scoring stays
   * here, because scoring needs the index and the frecency database while
   * composition needs neither. That split is what lets the ordering rules be
   * tested without building an index.
   */
  search(query: string, limit = 50): readonly ResultItem[] {
    return composeRoot({
      query,
      config: this.deps.config(),
      commands: this.deps.commands(),
      apps: this.searchApps(query, limit),
      resolveAlias: (target) => this.resolveAlias(target)
    })
  }

  /**
   * An alias target: `builtin/<name>` for a command, or a desktop-file id.
   *
   * The alias table is documented as pointing at command ids. Accepting an
   * application id too is an addition rather than a reinterpretation, and an
   * obvious one — without extensions there are five commands to alias
   * and several hundred applications, so a table that could only name the former
   * would be a feature nobody could use.
   */
  private resolveAlias(target: string): ResultItem | null {
    // The one alias target that is not an id: `shell:<command line>` carries the
    // command itself, so there is nothing to look up and nothing that can have
    // gone missing. The prefix is kept in the config value precisely so that a
    // command line and a desktop-file id can never be mistaken for each other.
    if (target.startsWith('shell:')) return shellRow(target.slice('shell:'.length))

    const command = this.deps.commands().find((candidate) => candidate.id === target)
    if (command !== undefined) {
      const kind = command.kind ?? 'command'
      return { id: `${kind}:${command.id}`, title: command.title, subtitle: command.subtitle, kind }
    }

    const entry = this.byId.get(target)
    if (entry === undefined) return null
    return {
      id: `app:${entry.id}`,
      title: entry.name,
      kind: 'app',
      ...(this.icons.resolve(entry.icon) === null
        ? {}
        : { icon: `${ICON_URL_PREFIX}${encodeURIComponent(entry.id)}` })
    }
  }

  private searchApps(query: string, limit: number): readonly ScoredRow[] {
    const needle = query.trim()

    // An empty query shows nothing. The panel is a bare search bar until you
    // type — that is the shape the whole layout is built around, and returning
    // the frecency-ranked list here instead would make it open at full height
    // every time, then collapse on the first keystroke.
    //
    // `rank()` still handles an empty needle by falling through to frecency
    // alone; that is what the root command list uses.
    if (needle.length === 0) return []

    const now = Date.now()
    const history = this.deps.frecency.all()
    const frecencyWeight = this.deps.config().search.frecencyWeight.value

    const scored: { item: ResultItem; score: number; tier: MatchTier; at: number }[] = []

    for (const entry of this.entries) {
      const match = matchFields(needle, [
        { name: 'name', text: entry.name, weight: FIELD_WEIGHTS.name, isName: true },
        { name: 'genericName', text: entry.genericName ?? '', weight: FIELD_WEIGHTS.genericName },
        // `word` mode on purpose — see `fuzzy.ts`. A `Keywords=` line is a
        // hundred characters of semicolon-separated terms and a subsequence rule
        // finds *something* in one of those for almost any query; that is
        // precisely how "raycast" found LibreOffice Draw.
        { name: 'keywords', text: entry.keywords.join(' '), weight: FIELD_WEIGHTS.keywords, mode: 'word' },
        { name: 'exec', text: entry.exec, weight: FIELD_WEIGHTS.exec, mode: 'word' }
      ])
      if (match === null) continue
      if (needle.length > 0 && match.score < SCORE_FLOOR) continue

      const score = rank(match.score, history.get(entry.id), now, frecencyWeight)
      scored.push({
        score,
        tier: match.tier,
        at: match.at,
        item: {
          id: `app:${entry.id}`,
          title: entry.name,
          kind: 'app',
          // A stable URL rather than a path: the renderer is sandboxed and must
          // not learn filesystem paths, and `lumanin-icon:` lets main decide
          // what it will actually serve.
          ...(this.icons.resolve(entry.icon) === null
            ? {}
            : { icon: `${ICON_URL_PREFIX}${encodeURIComponent(entry.id)}` }),
        }
      })
    }

    // Ordered here only enough to apply `limit`; the real ordering is in
    // `composeRoot`, which has to see the commands too — a weak app match must
    // not survive a strong command one purely by being the best of its own kind.
    scored.sort(
      (a, b) => a.tier - b.tier || a.at - b.at || b.score - a.score || a.item.title.localeCompare(b.item.title)
    )

    return scored
      .slice(0, limit)
      .map((entry) => ({ row: entry.item, score: entry.score, tier: entry.tier, at: entry.at }))
  }

  /** Stop watching. The daemon owns the lifetime; nothing else calls this. */
  dispose(): void {
    if (this.pending !== null) clearTimeout(this.pending)
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
  }

  /**
   * Enter, dispatched on what the row actually is.
   *
   * The kind is read off the id rather than trusted from a separate parameter,
   * so a renderer that sent a mismatched pair cannot make a `web` row launch an
   * application. Anything unrecognised is refused rather than guessed at.
   */
  async activate(id: string): Promise<LaunchOutcome> {
    const separator = id.indexOf(':')
    const kind = separator === -1 ? '' : id.slice(0, separator)
    const payload = id.slice(separator + 1)

    switch (kind) {
      case 'app': {
        const result = this.launch(payload)
        return { ok: result.ok, detail: result.detail }
      }
      case 'command':
        return await this.deps.actions.runCommand(payload)
      case 'extension': {
        // Same dispatch as a built-in command. The difference shows up in the
        // outcome — an extension launch carries a `session`, which is what tells
        // the daemon not to hide the panel and the renderer to start playing a
        // render tree instead.
        //
        // A `#` fragment names a pinned category (and maybe an item): it is
        // split off here and travels as the launch context, so the command
        // opens already inside the category the pin named.
        //
        // A fragment that goes one level further and names an *action* is not a
        // launch at all — it runs that action headlessly and there is nothing
        // to show, which is why it returns before the session path.
        const parts = parseExtensionPin(payload)
        if (parts === null) return await this.deps.actions.runExtension(payload, {})
        if (parts.action !== null && parts.item !== null) {
          return await this.deps.actions.runExtensionAction(
            parts.commandId,
            parts.category,
            parts.item,
            parts.action
          )
        }
        return await this.deps.actions.runExtension(parts.commandId, {
          // Empty means the command declares no categories, so there is no
          // dropdown to preselect and nothing to send.
          ...(parts.category.length === 0 ? {} : { category: parts.category }),
          ...(parts.item === null ? {} : { item: parts.item })
        })
      }
      case 'shell':
        return this.runShell(payload)
      case 'calculator':
        this.deps.actions.copy(payload)
        return { ok: true, detail: 'copied' }
      case 'web': {
        // Re-checked here even though the template was validated when it was
        // read from config: this string arrives from the renderer, and the
        // renderer is untrusted input by design.
        if (!isOpenableUrl(payload)) {
          this.deps.logger.warn('refused to open a non-web url', { id })
          return { ok: false, detail: 'that is not a web address' }
        }
        this.deps.actions.openUrl(payload)
        return { ok: true, detail: 'opened' }
      }
      default:
        return { ok: false, detail: 'that result can no longer be opened' }
    }
  }

  /**
   * Run a command line the user put in their own config.
   *
   * **The command is checked against the config before it is run**, and that
   * check is the whole security story here. This id came from the renderer, and
   * `activate`'s own comment says the renderer is untrusted input by design,
   * so without this, a compromised renderer could
   * spawn anything at all just by sending `shell:<whatever>`. With it, the worst
   * it can do is run something the user already wrote down and asked for.
   *
   * The line then goes to `sh -c` as a *single* argv element. Nothing is
   * concatenated into it and nothing from the query reaches it, which is what
   * keeps the no-shell-strings rule satisfied: the rule is about shell strings
   * *built* from parts, and this one is a literal read back out of `config.toml`.
   */
  private runShell(command: string): LaunchOutcome {
    if (!this.configuredShellCommands().has(command)) {
      this.deps.logger.warn('refused a shell command that is not in the config', { command })
      return { ok: false, detail: 'that command is not in your configuration' }
    }

    const ok = runShellCommand(command, this.deps.env)
    if (!ok) return { ok: false, detail: 'that command could not be started' }
    return { ok: true, detail: `ran ${command}` }
  }

  /**
   * Every `shell:` line the config actually names — pins, rule rows and aliases.
   *
   * Rebuilt per activation rather than cached: activations are rare, the config
   * can be reloaded between two of them, and a cache that missed a reload would
   * fail in the direction of running something the user had just deleted.
   */
  private configuredShellCommands(): ReadonlySet<string> {
    const config = this.deps.config()
    const commands = new Set<string>()

    const add = (key: string): void => {
      if (key.startsWith('shell:')) commands.add(key.slice('shell:'.length))
    }

    for (const entry of config.search.pins.value) add(entry.key)
    for (const rule of config.search.rules.value) for (const entry of rule.first) add(entry.key)
    for (const alias of Object.values(config.aliases.value)) add(alias.key)
    for (const binding of config.hotkeys.value) add(binding.target)

    return commands
  }

  launch(id: string): LaunchResult {
    const entry = this.byId.get(id)
    if (entry === undefined) {
      return { ok: false, method: 'exec', detail: 'that application is no longer in the index' }
    }

    const result = launchEntry(entry, {
      binaries: this.deps.binaries,
      env: this.deps.env,
      resolveBinary: (name) => resolveBinary(name, this.deps.env)
    })

    // Only a successful launch counts. Recording a failure would teach the
    // ranking to promote something that does not start.
    if (result.ok) this.deps.frecency.record(id)
    else this.deps.logger.warn('launch failed', { id, detail: result.detail })

    return result
  }
}
