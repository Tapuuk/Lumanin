import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Application,
  Cache as SpecCache,
  Clipboard as SpecClipboard,
  Environment,
  LocalStorage as SpecLocalStorage,
  PopToRootType as SpecPopToRootType,
  PreferenceValues
} from '@raycast/api'
import { APP_METHODS } from '../shared/ext-protocol'
import { LaunchType } from './enums'
import { requireRuntime } from './runtime'
import { isUnsupportedMember, unsupported } from './unsupported'

/**
 * The non-visual half of the API: the desktop, as an extension sees it.
 *
 * Almost everything here is a one-line RPC, and that is the point — the worker
 * is not sandboxed but it is also not the process holding the platform backends,
 * so clipboard, storage and "open this" all belong to main. What lives locally is
 * what genuinely can: `environment` (constants handed over at session start) and
 * `Cache` (a synchronous API, so it cannot be RPC at all).
 */

// --- environment -------------------------------------------------------------

/**
 * `environment`.
 *
 * A getter object rather than a frozen snapshot, because `appearance` changes
 * when the user switches theme and an extension that read it at import time
 * would be wrong for the rest of the session. The values come from the session
 * spec, which the worker refreshes.
 */
export const environment: Environment = {
  get raycastVersion(): string {
    return requireRuntime().spec.environment.apiVersion
  },
  get ownerOrAuthorName(): string {
    return requireRuntime().spec.extensionName
  },
  get extensionName(): string {
    return requireRuntime().spec.extensionName
  },
  get commandName(): string {
    return requireRuntime().spec.commandName
  },
  get commandMode(): Environment['commandMode'] {
    return requireRuntime().spec.commandMode
  },
  get assetsPath(): string {
    return requireRuntime().spec.environment.assetsPath
  },
  get supportPath(): string {
    return requireRuntime().spec.environment.supportPath
  },
  get isDevelopment(): boolean {
    return requireRuntime().spec.environment.isDevelopment
  },
  get appearance(): 'light' | 'dark' {
    return requireRuntime().spec.environment.appearance
  },
  get theme(): 'light' | 'dark' {
    return requireRuntime().spec.environment.appearance
  },
  get textSize(): 'medium' | 'large' {
    return requireRuntime().spec.environment.textSize
  },
  get launchType(): Environment['launchType'] {
    return requireRuntime().spec.environment.launchType === 'background'
      ? LaunchType.Background
      : LaunchType.UserInitiated
  },
  /**
   * `canAccess(api)` — whether an API is available to this extension.
   *
   * Raycast uses it to gate Pro features (`environment.canAccess(AI)`). Ours
   * answers honestly for the one thing that is genuinely conditional: anything
   * that throws `PlatformNotSupportedError` is not accessible. An always-`true`
   * implementation would be worse than useless — extensions call this precisely
   * so they can offer a fallback, and lying removes the fallback.
   */
  canAccess(api: unknown): boolean {
    if (typeof api !== 'function' && typeof api !== 'object') return false
    return !isUnsupportedMember(api)
  }
}

// --- preferences -------------------------------------------------------------

/**
 * `getPreferenceValues()`.
 *
 * Resolved in main and handed over with the session — manifest defaults first,
 * then whatever the user has set — so this is a read of something already
 * correct rather than a merge done per call. Extensions call it in render.
 */
export function getPreferenceValues<Values extends PreferenceValues = PreferenceValues>(): Values {
  return requireRuntime().spec.preferences as Values
}

/** @deprecated in the spec, and still imported by older extensions. */
export const preferences = new Proxy(
  {},
  {
    get(_target, key: string): unknown {
      const value = requireRuntime().spec.preferences[key]
      // The legacy shape was `{[name]: {value, ...}}` rather than a bare value.
      return value === undefined ? undefined : { value, name: key }
    }
  }
) as Record<string, unknown>

export function openCommandPreferences(): Promise<void> {
  return requireRuntime().call(APP_METHODS.OPEN_PREFERENCES, { scope: 'command' })
}

export function openExtensionPreferences(): Promise<void> {
  return requireRuntime().call(APP_METHODS.OPEN_PREFERENCES, { scope: 'extension' })
}

// --- clipboard ---------------------------------------------------------------

function clipboardParams(content: string | number | SpecClipboard.Content): Record<string, unknown> {
  if (typeof content === 'string' || typeof content === 'number') return { text: String(content) }
  if ('file' in content) return { file: String(content.file) }
  if ('html' in content) return { html: content.html, ...(content.text === undefined ? {} : { text: content.text }) }
  return { text: content.text }
}

export const Clipboard = {
  async copy(
    content: string | number | SpecClipboard.Content,
    options?: SpecClipboard.CopyOptions
  ): Promise<void> {
    await requireRuntime().call(APP_METHODS.CLIPBOARD_COPY, {
      ...clipboardParams(content),
      // `concealed` travels with the write so anything that ever records
      // clipboard contents can decide before the write, not filter at display
      // time. Nothing records them today — clipboard history was cut.
      concealed: options?.concealed === true,
      transient: options?.transient === true
    })
  },

  async paste(content: string | number | SpecClipboard.Content): Promise<void> {
    await requireRuntime().call(APP_METHODS.CLIPBOARD_PASTE, clipboardParams(content))
  },

  async clear(): Promise<void> {
    await requireRuntime().call(APP_METHODS.CLIPBOARD_CLEAR)
  },

  async read(options?: { offset?: number }): Promise<SpecClipboard.ReadContent> {
    return await requireRuntime().call(APP_METHODS.CLIPBOARD_READ, { offset: options?.offset ?? 0 })
  },

  async readText(options?: { offset?: number }): Promise<string | undefined> {
    const content = await Clipboard.read(options)
    return content.text.length > 0 ? content.text : undefined
  }
}

// --- LocalStorage ------------------------------------------------------------

/**
 * `LocalStorage` — namespaced per extension, in main's SQLite.
 *
 * Namespacing is done by main from the session it already knows, never from a
 * name the worker sends: "extension reading another extension's secrets" is a
 * threat we guard against, and a namespace the caller chooses is not a
 * namespace.
 */
export const LocalStorage = {
  async allItems<T extends SpecLocalStorage.Values = SpecLocalStorage.Values>(): Promise<T> {
    return await requireRuntime().call(APP_METHODS.STORAGE_ALL)
  },
  async getItem<T extends SpecLocalStorage.Value = SpecLocalStorage.Value>(
    key: string
  ): Promise<T | undefined> {
    const value = await requireRuntime().call<T | null>(APP_METHODS.STORAGE_GET, { key })
    return value === null ? undefined : value
  },
  async setItem(key: string, value: SpecLocalStorage.Value): Promise<void> {
    await requireRuntime().call(APP_METHODS.STORAGE_SET, { key, value })
  },
  async removeItem(key: string): Promise<void> {
    await requireRuntime().call(APP_METHODS.STORAGE_REMOVE, { key })
  },
  async clear(): Promise<void> {
    await requireRuntime().call(APP_METHODS.STORAGE_CLEAR)
  }
}

// --- Cache -------------------------------------------------------------------

const CACHE_DIRECTORY_NAME = 'cache'
const CACHE_DEFAULT_CAPACITY = 10 * 1024 * 1024

interface CacheFile {
  /** Insertion/refresh order, oldest first. The LRU list. */
  readonly order: string[]
  readonly entries: Record<string, string>
}

/**
 * `Cache` — synchronous, file-backed, LRU-evicted.
 *
 * Synchronous is the whole constraint: the spec's `get`/`set` return values
 * rather than promises, so this cannot be RPC to main and has to be the worker's
 * own filesystem. That is fine — a cache is per-extension by definition and the
 * worker already has full Node.
 *
 * Written through a temp file and renamed, because the alternative is a cache
 * that is one crash away from being unparseable JSON, and a corrupt cache that
 * throws on construction takes the whole extension down with it.
 */
export class Cache {
  static get STORAGE_DIRECTORY_NAME(): string {
    return CACHE_DIRECTORY_NAME
  }

  static get DEFAULT_CAPACITY(): number {
    return CACHE_DEFAULT_CAPACITY
  }

  private readonly directory: string
  private readonly namespace: string
  private readonly capacity: number
  private readonly file: string
  private data: CacheFile = { order: [], entries: {} }
  private readonly subscribers = new Set<SpecCache.Subscriber>()

  constructor(options?: SpecCache.Options) {
    this.namespace = options?.namespace ?? 'default'
    this.capacity = options?.capacity ?? CACHE_DEFAULT_CAPACITY
    this.directory =
      options?.directory ?? join(requireRuntime().spec.environment.supportPath, CACHE_DIRECTORY_NAME)
    this.file = join(this.directory, `${encodeURIComponent(this.namespace)}.json`)
    this.load()
  }

  get storageDirectory(): string {
    return this.directory
  }

  get isEmpty(): boolean {
    return this.data.order.length === 0
  }

  get(key: string): string | undefined {
    return this.data.entries[key]
  }

  has(key: string): boolean {
    return Object.hasOwn(this.data.entries, key)
  }

  set(key: string, data: string): void {
    const entries = { ...this.data.entries, [key]: data }
    const order = [...this.data.order.filter((entry) => entry !== key), key]
    this.data = evict({ order, entries }, this.capacity)
    this.persist()
    this.notify(key, data)
  }

  remove(key: string): boolean {
    if (!this.has(key)) return false
    const entries = { ...this.data.entries }
    delete entries[key]
    this.data = { order: this.data.order.filter((entry) => entry !== key), entries }
    this.persist()
    this.notify(key, undefined)
    return true
  }

  clear(options?: { notifySubscribers: boolean }): void {
    this.data = { order: [], entries: {} }
    this.persist()
    if (options?.notifySubscribers !== false) this.notify(undefined, undefined)
  }

  subscribe(subscriber: SpecCache.Subscriber): SpecCache.Subscription {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  private notify(key: string | undefined, data: string | undefined): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(key, data)
      } catch {
        // A subscriber that throws is the extension's bug, and it must not
        // prevent the other subscribers from hearing about the write.
      }
    }
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<CacheFile>
      if (Array.isArray(parsed.order) && typeof parsed.entries === 'object' && parsed.entries !== null) {
        this.data = { order: parsed.order, entries: parsed.entries }
      }
    } catch {
      // Missing or unreadable: an empty cache is always a correct answer for a
      // cache, which is exactly why this is not reported as an error.
    }
  }

  private persist(): void {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 })
      renameSync(temporary, this.file)
    } catch {
      // A cache that cannot be written is a slow extension, not a broken one.
    }
  }
}

function evict(data: CacheFile, capacity: number): CacheFile {
  let size = 0
  for (const value of Object.values(data.entries)) size += value.length

  if (size <= capacity) return data

  const order = [...data.order]
  const entries = { ...data.entries }
  while (size > capacity && order.length > 1) {
    const oldest = order.shift()
    if (oldest === undefined) break
    size -= entries[oldest]?.length ?? 0
    delete entries[oldest]
  }
  return { order, entries }
}

// --- opening things ----------------------------------------------------------

export async function open(target: string, application?: Application | string): Promise<void> {
  const name = typeof application === 'string' ? application : application?.name
  await requireRuntime().call(APP_METHODS.OPEN, {
    target,
    ...(name === undefined ? {} : { application: name })
  })
}

export async function trash(path: string | string[] | URL | URL[]): Promise<void> {
  const paths = (Array.isArray(path) ? path : [path]).map((entry) => String(entry))
  await requireRuntime().call(APP_METHODS.TRASH, { paths })
}

export async function getApplications(path?: string | URL): Promise<Application[]> {
  return await requireRuntime().call(APP_METHODS.APPLICATIONS, {
    ...(path === undefined ? {} : { path: String(path) })
  })
}

export async function getDefaultApplication(path: string | URL): Promise<Application> {
  const applications = await requireRuntime().call<Application[]>(APP_METHODS.APPLICATIONS, {
    path: String(path),
    defaultOnly: true
  })
  const first = applications[0]
  if (first === undefined) throw new Error(`no default application for ${String(path)}`)
  return first
}

/**
 * `getSelectedText()` — the PRIMARY selection.
 *
 * Partial by design: on X11 and Wayland the "currently selected
 * text" is the PRIMARY selection, which is a different thing from macOS's
 * accessibility read — it is whatever was last selected anywhere, and it is
 * empty when the selection was made in an application that does not export one.
 * Documented rather than silently different.
 */
export async function getSelectedText(): Promise<string> {
  return await requireRuntime().call(APP_METHODS.SELECTION_READ)
}

// --- window & root -----------------------------------------------------------

export async function closeMainWindow(options?: {
  clearRootSearch?: boolean
  popToRootType?: SpecPopToRootType
}): Promise<void> {
  await requireRuntime().call(APP_METHODS.CLOSE_WINDOW, {
    clearRootSearch: options?.clearRootSearch === true,
    popToRootType: options?.popToRootType ?? 'default'
  })
}

export async function popToRoot(options?: { clearSearchBar?: boolean }): Promise<void> {
  await requireRuntime().call(APP_METHODS.POP_TO_ROOT, {
    clearSearchBar: options?.clearSearchBar === true
  })
}

export async function clearSearchBar(options?: { forceScrollToTop?: boolean }): Promise<void> {
  await requireRuntime().call(APP_METHODS.CLEAR_SEARCH_BAR, {
    forceScrollToTop: options?.forceScrollToTop === true
  })
}

export async function updateCommandMetadata(metadata: { subtitle?: string | null }): Promise<void> {
  await requireRuntime().call(APP_METHODS.UPDATE_METADATA, {
    subtitle: metadata.subtitle ?? null
  })
}

// --- diagnostics -------------------------------------------------------------

/**
 * `captureException` — **local only**.
 *
 * The privacy posture: no telemetry, no crash reporting to any remote
 * endpoint, and no opt-in to build because there is no collection. This writes to
 * the extension's log and nowhere else.
 */
export function captureException(exception: unknown): void {
  const runtime = requireRuntime()
  const message =
    exception instanceof Error
      ? `${exception.name}: ${exception.message}\n${exception.stack ?? ''}`
      : String(exception)
  runtime.notify(APP_METHODS.LOG, { level: 'error', message })
}

// --- macOS-only 🔒 -----------------------------------------------------------

export const showInFinder = unsupported<(path: string) => Promise<void>>(
  'showInFinder',
  'Finder is macOS-only. Use `open()` with the containing directory to reveal a file in the desktop’s file manager.'
)

export const getSelectedFinderItems = unsupported<() => Promise<never>>(
  'getSelectedFinderItems',
  'Finder is macOS-only. There is no cross-desktop way to read a file manager’s selection on Linux.'
)

/**
 * `getFrontmostApplication()` — 🟡, and deliberately *not* in the list above.
 *
 * "The focused window's application" is a real question on Linux, just a
 * compositor-dependent one: the `windows` capability answers it on Hyprland,
 * Sway and X11 and reports itself unavailable elsewhere.
 * So it is an RPC that may reject, not a member that always throws — the
 * difference matters, because declaring it unsupported would also make
 * `environment.canAccess` say so on the desktops where it works.
 */
export async function getFrontmostApplication(): Promise<Application> {
  return await requireRuntime().call(APP_METHODS.APPLICATIONS, { frontmost: true })
}

/**
 * A cache-directory cleanup, exported for tests only. Nothing in the API surface
 * calls it, and no extension can reach it: it is not re-exported from `index.ts`.
 */
export function purgeCacheDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true })
}
