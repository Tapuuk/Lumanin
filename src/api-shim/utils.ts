import { useCallback, useEffect, useRef, useState } from 'react'
import {
  defaultParseOutput,
  runCommand,
  splitCommand,
  type ExecOptions,
  type ParseExecOutput
} from './exec'
import { Cache, LocalStorage } from './system'
import { Toast, showToast } from './feedback'
import { Icon } from './icon'
import { NO_OAUTH } from './namespaces'
import { declined, pending, unsupported } from './unsupported'

/** Bounds what one completed run costs: the whole file is stringified and rewritten. */
const HOOK_CACHE_CAPACITY = 1024 * 1024

/**
 * `@raycast/utils`, as far as the extension host needs it.
 *
 * This package was once filed as a later addition, and that turned out to be
 * wrong about one thing: the extension host's gate is "an unmodified simple
 * store extension runs", and the store's idea of a simple List-and-fetch extension
 * includes `usePromise`. Hacker News, the canonical simple store extension, is
 * four lines of `@raycast/api` and one `usePromise`. Without this the gate is unreachable, not
 * because anything in the host is missing but because no real extension is
 * written the way the gate imagines.
 *
 * So the hooks that a data-loading extension cannot do without are implemented
 * here, and the rest still throw. What is real: `usePromise`, `useCachedPromise`,
 * `useCachedState`, `useLocalStorage`, `useFetch`, `showFailureToast` and the
 * three icon helpers — plus `useExec`, added for a reason particular to
 * this platform. A Linux launcher plugin is usually a face for a CLI, so running
 * a program and rendering its output is not a convenience here the way it is on
 * a Mac full of scriptable apps; it is the common case. Its non-React half lives
 * in `./exec`.
 *
 * `@raycast/utils` is MIT-licensed and its source is public. This is a
 * reimplementation from the documented behaviour and the published type
 * definitions, not a copy — the semantics are theirs and the attribution belongs
 * to them (see `themes/CREDITS.md` for how we record that elsewhere).
 */

interface AsyncState<T> {
  isLoading: boolean
  data?: T
  error?: Error
}

interface PromiseOptions<T> {
  /** `false` means "not yet" — do not call, and do not report loading. */
  execute?: boolean
  onData?: (data: T) => void
  onError?: (error: Error) => void
  onWillExecute?: () => void
  /** An `AbortController` the hook replaces on every run, so a stale fetch can be cancelled. */
  abortable?: { current: AbortController | null | undefined }
  initialData?: T
  keepPreviousData?: boolean
  failureToastOptions?: { title?: string; message?: string }
}

/**
 * `usePromise(fn, args, options)`.
 *
 * The contract that matters, and the one extensions actually depend on:
 *
 *  - it runs when `args` change, compared **structurally** rather than by
 *    identity, because callers pass a fresh array literal every render;
 *  - `execute: false` means it does not run *and is not loading* — an extension
 *    gates its fetch on a dropdown selection, and reporting `isLoading` while
 *    waiting for the user would leave a spinner up forever;
 *  - a run that is superseded is ignored rather than applied late, or a slow
 *    first request would overwrite the results of a fast second one;
 *  - a rejection sets `error` and shows a failure toast, because the alternative
 *    is an empty list with no explanation.
 */
export function usePromise<T>(
  fn: (...args: never[]) => Promise<T>,
  args: readonly unknown[] = [],
  options: PromiseOptions<T> = {}
): AsyncState<T> & { revalidate: () => Promise<T>; mutate: MutateFn<T> } {
  const execute = options.execute !== false
  const [state, setState] = useState<AsyncState<T>>(() => ({
    isLoading: execute,
    ...(options.initialData === undefined ? {} : { data: options.initialData })
  }))

  // Held in a ref so a changed callback does not itself trigger a run: extensions
  // pass inline closures, and treating those as a dependency would re-fetch on
  // every render forever.
  const latest = useRef({ fn, options })
  latest.current = { fn, options }

  const generation = useRef(0)
  const key = stableKey(args)

  const run = useCallback(async (): Promise<T> => {
    const ours = ++generation.current
    const { fn: call, options: current } = latest.current

    current.onWillExecute?.()
    if (current.abortable !== undefined) {
      current.abortable.current?.abort()
      current.abortable.current = new AbortController()
    }

    setState((previous) => ({
      isLoading: true,
      ...(current.keepPreviousData === false ? {} : { data: previous.data })
    }))

    try {
      const data = await call(...(args as never[]))
      if (generation.current !== ours) return data
      setState({ isLoading: false, data })
      current.onData?.(data)
      return data
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      // An abort is the hook doing its job, not a failure to report.
      if (failure.name === 'AbortError') throw failure
      if (generation.current === ours) setState({ isLoading: false, error: failure })

      if (current.onError !== undefined) current.onError(failure)
      else void showFailureToast(failure, current.failureToastOptions)
      throw failure
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    }
    // `args` is intentionally absent: `key` is its structural stand-in, and the
    // array itself is a new object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (!execute) {
      setState((previous) => ({ ...previous, isLoading: false }))
      return
    }
    void run().catch(() => {
      // Already recorded in state and surfaced as a toast. Rethrowing here would
      // become an unhandled rejection and take the worker down.
    })
  }, [execute, run])

  const mutate = useCallback<MutateFn<T>>(
    async (asyncUpdate, mutateOptions) => {
      const previous = state.data
      if (mutateOptions?.optimisticUpdate !== undefined && previous !== undefined) {
        setState({ isLoading: true, data: mutateOptions.optimisticUpdate(previous) })
      }
      try {
        const result = await asyncUpdate
        if (mutateOptions?.shouldRevalidateAfter !== false) await run().catch(() => undefined)
        return result
      } catch (error) {
        if (mutateOptions?.rollbackOnError !== false && previous !== undefined) {
          setState({ isLoading: false, data: previous })
        }
        throw error
      }
    },
    [run, state.data]
  )

  return { ...state, revalidate: run, mutate }
}

type MutateFn<T> = (
  asyncUpdate?: Promise<unknown>,
  options?: {
    optimisticUpdate?: (data: T) => T
    rollbackOnError?: boolean
    shouldRevalidateAfter?: boolean
  }
) => Promise<unknown>

/**
 * `useCachedPromise` — the same, but the last answer survives the command closing.
 *
 * That is the whole reason extensions reach for it: a list that was populated
 * yesterday should be on screen before today's request finishes, rather than
 * showing an empty panel for 400 ms every single time.
 */
export function useCachedPromise<T>(
  fn: (...args: never[]) => Promise<T>,
  args: readonly unknown[] = [],
  options: PromiseOptions<T> & { initialData?: T; cacheWriteDebounce?: number } = {}
): AsyncState<T> & { revalidate: () => Promise<T>; mutate: MutateFn<T> } {
  const cache = useRef<Cache | null>(null)
  cache.current ??= new Cache({ namespace: 'raycast-utils', capacity: HOOK_CACHE_CAPACITY })

  const key = `promise:${hash(fn.toString())}:${stableKey(args)}`
  const cached = readCached<T>(cache.current, key)

  const result = usePromise(fn, args, {
    ...options,
    ...(cached === undefined ? {} : { initialData: cached }),
    onData: (data) => {
      writeCached(cache.current, key, data, options.cacheWriteDebounce)
      options.onData?.(data)
    }
  })

  // A cached value is *data*, so the first paint has content and `isLoading`
  // still reports that a fresher answer is on its way.
  return result.data === undefined && cached !== undefined ? { ...result, data: cached } : result
}

/** `useCachedState(key, initial)` — `useState` that survives the command closing. */
export function useCachedState<T>(
  key: string,
  initialValue?: T,
  config?: { cacheNamespace?: string; cacheWriteDebounce?: number }
): [T, (value: T | ((previous: T) => T)) => void] {
  const cache = useRef<Cache | null>(null)
  cache.current ??= new Cache({
    ...(config?.cacheNamespace === undefined ? {} : { namespace: config.cacheNamespace })
  })

  const [value, setValue] = useState<T>(() => readCached<T>(cache.current, key) ?? (initialValue as T))

  const update = useCallback(
    (next: T | ((previous: T) => T)) => {
      setValue((previous) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(previous) : next
        writeCached(cache.current, key, resolved, config?.cacheWriteDebounce)
        return resolved
      })
    },
    [key, config?.cacheWriteDebounce]
  )

  return [value, update]
}

/** `useLocalStorage(key, initial)` — the async, cross-command store. */
export function useLocalStorage<T>(
  key: string,
  initialValue?: T
): {
  value: T | undefined
  setValue: (value: T) => Promise<void>
  removeValue: () => Promise<void>
  isLoading: boolean
} {
  const [value, setValue] = useState<T | undefined>(initialValue)
  const [isLoading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    void LocalStorage.getItem<string>(key).then((stored) => {
      if (!live) return
      if (stored !== undefined) {
        try {
          setValue(JSON.parse(stored) as T)
        } catch {
          // A value written by an older version, or by hand. Falling back to the
          // initial value beats throwing inside an effect.
        }
      }
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [key])

  return {
    value,
    isLoading,
    setValue: async (next: T) => {
      setValue(next)
      await LocalStorage.setItem(key, JSON.stringify(next))
    },
    removeValue: async () => {
      setValue(undefined)
      await LocalStorage.removeItem(key)
    }
  }
}

/**
 * `useFetch(url, options)`.
 *
 * `fetch` is Node's own — the worker runs on Node 24, which has had it since 18
 * — so there is no HTTP client here and no dependency to keep current.
 */
export function useFetch<T>(
  url: string,
  options: PromiseOptions<T> & {
    method?: string
    headers?: Record<string, string>
    body?: string
    parseResponse?: (response: Response) => Promise<T>
    mapResult?: (result: T) => { data: T }
  } = {}
): AsyncState<T> & { revalidate: () => Promise<T>; mutate: MutateFn<T> } {
  const request = useCallback(async (): Promise<T> => {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.abortable?.current == null ? {} : { signal: options.abortable.current.signal })
    })

    if (options.parseResponse !== undefined) return await options.parseResponse(response)
    if (!response.ok) {
      // The status line is the useful half of an HTTP failure and is what an
      // extension's error toast should say.
      throw new Error(`${String(response.status)} ${response.statusText}`)
    }
    const parsed = (await response.json()) as T
    return options.mapResult === undefined ? parsed : options.mapResult(parsed).data
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, options.method, options.body])

  return usePromise(request as (...args: never[]) => Promise<T>, [url], options)
}

/**
 * `showFailureToast(error, options)`.
 *
 * The message is the error's own. A generic "Something went wrong" is the single
 * least useful thing a launcher can say, and the extension author has usually
 * already written a better one into the error they threw.
 */
export async function showFailureToast(
  error: unknown,
  options?: { title?: string; message?: string; primaryAction?: never }
): Promise<Toast> {
  const message = error instanceof Error ? error.message : String(error)
  return await showToast({
    style: Toast.Style.Failure,
    title: options?.title ?? 'Something went wrong',
    message: options?.message ?? message
  })
}

// --- icon helpers ------------------------------------------------------------

/**
 * `getAvatarIcon(name)` — initials on a coloured disc, as a `data:` URI.
 *
 * Generated rather than fetched. It is the whole point of the helper that it
 * works for a name nobody has an image for, and an implementation that asked a
 * remote avatar service would both fail offline and tell that service every name
 * an extension ever renders.
 */
export function getAvatarIcon(
  name: string,
  options?: { background?: string; gradient?: boolean }
): string {
  const initials = name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

  const background = options?.background ?? PALETTE[hash(name) % PALETTE.length] ?? '#888888'
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<circle cx="32" cy="32" r="32" fill="${background}"/>` +
    `<text x="32" y="41" font-family="sans-serif" font-size="26" fill="#ffffff"` +
    ` text-anchor="middle">${escapeXml(initials)}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

/**
 * `getFavicon(url)` — the site's **own** favicon, over TLS.
 *
 * Not a favicon *service*. The usual implementation proxies through a third
 * party, which means every URL an extension renders is reported to someone who
 * was never part of the transaction. Asking the site itself is the version that
 * matches the privacy posture: the only host contacted is the one the
 * extension is already about.
 */
export function getFavicon(
  url: string | URL,
  options?: { fallback?: string; mask?: string; size?: number }
): string {
  try {
    return new URL('/favicon.ico', typeof url === 'string' ? url : url.toString()).toString()
  } catch {
    return options?.fallback ?? Icon.Globe
  }
}

/** `getProgressIcon(progress, color)` — a donut, as a `data:` URI. */
export function getProgressIcon(
  progress: number,
  color?: string,
  options?: { background?: string; backgroundOpacity?: number }
): string {
  const clamped = Math.max(0, Math.min(1, progress))
  const circumference = 2 * Math.PI * 26
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<circle cx="32" cy="32" r="26" fill="none" stroke="${options?.background ?? '#8888884d'}" stroke-width="8"/>` +
    `<circle cx="32" cy="32" r="26" fill="none" stroke="${color ?? '#3b82f6'}" stroke-width="8"` +
    ` stroke-dasharray="${String(circumference)}"` +
    ` stroke-dashoffset="${String(circumference * (1 - clamped))}"` +
    ` transform="rotate(-90 32 32)" stroke-linecap="round"/></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

const PALETTE = ['#e05252', '#e0a052', '#52a0e0', '#7f52e0', '#52e0a0', '#e052a0']

// --- enumerations ------------------------------------------------------------

/**
 * `FormValidation` and `DeeplinkType`.
 *
 * These are *values*, not types, and an extension that imports one from a
 * CommonJS bundle destructures it at load — so a missing enum is not a feature
 * that quietly does nothing, it is `undefined.Required` and a dead extension
 * before any of its code runs. `qrcode-generator` failed exactly that way:
 * "Cannot read properties of undefined (reading 'Required')", with no mention of
 * the package it came from.
 *
 * Both are declared here even though `useForm` is still `pending` and the
 * deeplink builders are `declined`. Reaching a message that says so is strictly
 * better than crashing on the import.
 */
export const FormValidation = { Required: 'required' } as const
export const DeeplinkType = { ScriptCommand: 'script-command', Extension: 'extension' } as const

interface ExecHookOptions<T> extends PromiseOptions<T> {
  parseOutput?: ParseExecOutput<T, string> | ParseExecOutput<T, Buffer>
  cacheWriteDebounce?: number
}

/**
 * `useExec(command, args?, options?)` — run a program, render its output.
 *
 * The most useful hook there is on this platform. A Linux launcher plugin is
 * usually a face for a CLI — `systemctl`, `git`, `pacman`, `docker`, `godot` —
 * and without this every one of them hand-rolls `child_process`, a loading flag,
 * an error path and a cancel-the-stale-run guard. Getting that right once here
 * is worth more than any other API in this package.
 *
 * Both spec call shapes work. `useExec('git', ['status'])` is the one to write:
 * arguments as an array need no quoting and cannot be re-parsed. `useExec('git
 * status')` splits on spaces per the spec's rule and is there for parity.
 *
 * Values survive the command closing, like `useCachedPromise` — which is what
 * the spec means by *"the last value will be kept between command runs"*, and is
 * why a plugin opens showing yesterday's list instead of an empty panel.
 */
export function useExec<T = string>(
  command: string,
  argsOrOptions?: readonly string[] | (ExecOptions & ExecHookOptions<T>),
  maybeOptions?: ExecOptions & ExecHookOptions<T>
): AsyncState<T> & { revalidate: () => Promise<T>; mutate: MutateFn<T> } {
  const explicitArgs = Array.isArray(argsOrOptions) ? (argsOrOptions as readonly string[]) : null
  const options: ExecOptions & ExecHookOptions<T> =
    (explicitArgs === null ? (argsOrOptions as ExecOptions & ExecHookOptions<T>) : maybeOptions) ??
    {}

  // Without args the command string is the whole line; with them it is a file.
  const parsed = explicitArgs === null ? splitCommand(command) : { file: command, args: [] }
  const file = parsed.file
  const args = explicitArgs ?? parsed.args

  const latest = useRef(options)
  latest.current = options

  // Our own controller, not the caller's: the spec `Omit`s `abortable` from this
  // hook's options precisely because the hook owns the child process. `usePromise`
  // replaces and aborts it on every run, which is what kills a superseded child.
  const abortable = useRef<AbortController | null>(null)

  const run = useCallback(async (): Promise<T> => {
    const current = latest.current
    const signal = abortable.current?.signal ?? new AbortController().signal
    const outcome = await runCommand(file, args, current, signal)
    const parse = (current.parseOutput ?? defaultParseOutput) as ParseExecOutput<
      T,
      string | Buffer
    >
    return parse(outcome)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, stableKey(args)])

  // An unmounting command must not leave a child running: the worker outlives
  // the view by a grace window, and a `find /` started on the way out would
  // still be going when the next command opens.
  useEffect(() => () => abortable.current?.abort(), [])

  return useCachedPromise(run as (...args: never[]) => Promise<T>, [file, args, options.cwd], {
    ...options,
    abortable
  })
}

// --- not implemented ---------------------------------------------------------

export const useSQL = pending<never>('useSQL', 'no SQLite query API is exposed to plugins')
export const useForm = pending<never>('useForm', 'Form itself is real; this helper over it is not')
export const useAI = pending<never>('useAI', 'no AI provider ships with Lumanin')
export const useStreamJSON = pending<never>('useStreamJSON', 'streaming JSON pagination is unwritten')
export const useFrecencySorting = pending<never>('useFrecencySorting', 'frecency ranking is internal to the launcher')
export const executeSQL = pending<never>('executeSQL', 'no SQLite query API is exposed to plugins')
// Declined with the OAuth client they wrap — see `namespaces.ts` for the why.
export const withAccessToken = declined<never>('withAccessToken', NO_OAUTH)
export const getAccessToken = declined<never>('getAccessToken', NO_OAUTH)
export const withCache = pending<never>('withCache', 'unwritten; useCachedPromise caches a promise today')
// Cut: `lumanin open '<key>'` already does the deeplink's job on Linux,
// and building a second URL scheme for it would be a worse spelling of the same thing.
const NO_DEEPLINKS = 'there is no deeplink URL scheme; `lumanin open` launches any command from a shell'
export const createDeeplink = declined<never>('createDeeplink', NO_DEEPLINKS)
export const createExtensionDeeplink = declined<never>('createExtensionDeeplink', NO_DEEPLINKS)
export const createScriptCommandDeeplink = declined<never>('createScriptCommandDeeplink', NO_DEEPLINKS)

export const runAppleScript = unsupported<never>(
  'runAppleScript',
  'AppleScript is macOS-only. There is no equivalent scripting bridge on Linux.'
)
export const runPowerShellScript = unsupported<never>(
  'runPowerShellScript',
  'PowerShell scripting targets Windows; Lumanin does not run it.'
)

/** The OAuth service wrapper: a convenience over a client that will not exist. */
export const OAuthService = declined<never>('OAuthService', NO_OAUTH)

// --- helpers -----------------------------------------------------------------

/**
 * A structural key for a dependency array.
 *
 * Extensions pass `[topic]` — a new array literal every render — so identity
 * comparison would re-run the promise on every render, forever. `JSON.stringify`
 * is enough here: these are search terms, ids and filter flags, not graphs.
 */
function stableKey(args: readonly unknown[]): string {
  try {
    return JSON.stringify(args) ?? ''
  } catch {
    return String(args.length)
  }
}

function hash(value: string): number {
  let result = 0
  for (let index = 0; index < value.length; index++) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0
  }
  return result
}

function readCached<T>(cache: Cache | null, key: string): T | undefined {
  const raw = cache?.get(key)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/**
 * Whether a value comes back out of a JSON cache as the same thing.
 *
 * `JSON.stringify` does not refuse a `Buffer` — it writes
 * `{"type":"Buffer","data":[…]}` and that is what parses back. So a
 * `useExec(…, { encoding: 'buffer' })` plugin would get a real Buffer on a fresh
 * run and a plain object from cache, differing only on the runs where the cache
 * happened to be warm. Storing nothing is the honest outcome: the hook then
 * simply has no cached value, which it already knows how to be.
 *
 * Bounded rather than exhaustive on purpose — this catches the shape the API can
 * actually produce, and a cache lookup is not the place for a deep graph walk.
 */
function survivesJson(value: unknown, depth = 3): boolean {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return false
  if (depth === 0 || value === null || typeof value !== 'object') return true
  if (Array.isArray(value)) return value.every((entry) => survivesJson(entry, depth - 1))
  return Object.values(value).every((entry) => survivesJson(entry, depth - 1))
}

function writeCached(cache: Cache | null, key: string, value: unknown, delayMs?: number): void {
  if (!survivesJson(value)) return
  try {
    cache?.set(key, JSON.stringify(value), delayMs)
  } catch {
    // Unserialisable data is not a reason to fail the request that produced it.
  }
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => {
    const entities: Readonly<Record<string, string>> = {
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '"': '&quot;',
      "'": '&apos;'
    }
    return entities[character] ?? character
  })
}
