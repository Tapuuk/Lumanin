/**
 * The daemon control protocol.
 *
 * One verb vocabulary is shared by three transports, deliberately:
 *   1. the `lumanin` CLI over `$XDG_RUNTIME_DIR/lumanin.sock` (the fast path),
 *   2. Electron's `second-instance` argv forwarding (running the binary directly),
 *   3. user scripts writing to the socket.
 *
 * The verb set is a closed allow-list and is never eval-shaped. A
 * request that does not parse into one of these is rejected without side effects.
 */

import type { EnumeratedItem } from './render-tree'

export const VERB_KINDS = [
  'toggle',
  'show',
  'hide',
  'status',
  'ping',
  'reload',
  'quit'
] as const

export type VerbKind = (typeof VERB_KINDS)[number]

/**
 * Two verbs carry parameters; the rest are bare. The set stays a closed
 * allow-list either way — `parseRequest` validates each parameterised shape
 * field by field and rejects anything else without side effects.
 *
 *  - `open` is what a `[[hotkeys]]` compositor bind runs (`lumanin open
 *    <target>`): show the panel and activate one row, a pin key naming it.
 *  - `enumerate` is the config screen asking a plugin what rows a category
 *    holds, so an item can be pinned. Socket-only; the CLI has no spelling
 *    for it.
 */
export type Verb =
  | { kind: VerbKind }
  | { kind: 'open'; target: string }
  | { kind: 'enumerate'; command: string; category: string | null }

/** What `enumerate` answers with. */
export interface EnumerateData {
  readonly items: readonly EnumeratedItem[]
}

/** Wire request. `id` lets a client correlate replies on a multiplexed socket. */
export interface Request {
  id: number
  verb: Verb
}

export interface DaemonStatus {
  version: string
  pid: number
  /** Whether the main window is currently visible. */
  visible: boolean
  /** Seconds since the daemon became ready. */
  uptimeSeconds: number
  sessionType: string
  desktop: string
  /**
   * The backend the *running daemon* chose per capability, or its status where
   * it chose none.
   *
   * `lumanin doctor` deliberately probes in the CLI process so it works when the
   * daemon does not — which means it reports what the CLI can see, not what the
   * daemon decided. Those differ whenever the two were started with different
   * environments (a compositor `exec` with a trimmed `$PATH` is the common case),
   * and when they differ, this is the one that is actually in effect.
   */
  backends: Readonly<Record<string, string>>
}

export type Response =
  | { id: number; ok: true; data?: DaemonStatus | EnumerateData | undefined }
  | { id: number; ok: false; error: string }

export function isVerbKind(value: unknown): value is VerbKind {
  return typeof value === 'string' && (VERB_KINDS as readonly string[]).includes(value)
}

/**
 * Parse a wire frame into a request. Returns `null` for anything that is not a
 * well-formed request for an allow-listed verb — callers must treat `null` as
 * "reject", never as "assume a default".
 */
export function parseRequest(frame: unknown): Request | null {
  if (typeof frame !== 'object' || frame === null) return null
  const candidate = frame as { id?: unknown; verb?: unknown }
  if (typeof candidate.id !== 'number' || !Number.isFinite(candidate.id)) return null
  if (typeof candidate.verb !== 'object' || candidate.verb === null) return null
  const verb = candidate.verb as { kind?: unknown; target?: unknown; command?: unknown; category?: unknown }

  if (verb.kind === 'open') {
    // The target is a pin key; `activate` re-validates it and a `shell:` target
    // is additionally checked against the config before anything is spawned.
    if (typeof verb.target !== 'string' || verb.target.length === 0 || verb.target.length > 1024) {
      return null
    }
    return { id: candidate.id, verb: { kind: 'open', target: verb.target } }
  }

  if (verb.kind === 'enumerate') {
    if (typeof verb.command !== 'string' || verb.command.length === 0) return null
    if (verb.category !== null && typeof verb.category !== 'string') return null
    return {
      id: candidate.id,
      verb: { kind: 'enumerate', command: verb.command, category: verb.category }
    }
  }

  if (!isVerbKind(verb.kind)) return null
  return { id: candidate.id, verb: { kind: verb.kind } }
}

/**
 * Commands the CLI answers itself, without talking to the daemon.
 *
 * `doctor` is here deliberately: a diagnostic that requires the thing being
 * diagnosed to be running is useless in exactly the situation you reach for it.
 */
/**
 * Commands the CLI answers itself. They are not verbs because a verb is
 * something a *running* daemon does, and these are the two that must work when
 * one is not running: `doctor` diagnoses why, and `start` fixes it.
 */
export const CLIENT_COMMANDS = [
  'doctor',
  'start',
  'config',
  // The settings app. A client command, not a verb: it launches a completely
  // separate application (own process, own window class), and the daemon has
  // nothing to do with it — a daemon that is not running changes nothing here.
  'settings',
  'ext',
  'plugins',
  // The old spelling of `plugins`. Parsed so it can print the new one — an
  // "unknown verb" answer to a command we shipped would read as a regression.
  'store',
  'plugin-install',
  'plugin-export',
  'update'
] as const
export type ClientCommand = (typeof CLIENT_COMMANDS)[number]

export interface ParsedArgs {
  /** `null` when the args did not name a verb (help/version/unknown/client command). */
  verb: Verb | null
  /** Set when the args named a command the CLI handles locally. */
  clientCommand: ClientCommand | null
  help: boolean
  version: boolean
  /** Long/short flags as written, e.g. `--json`. */
  flags: ReadonlySet<string>
  /** Set when the args named something that is neither. */
  unknown: string | null
  /**
   * Positional arguments after the verb.
   *
   * `ext` is the first command with a grammar of its own — `ext remove <name>`,
   * `ext dev <path>` — and it parses its own tail rather than teaching this
   * parser about subcommands it has no other reason to know.
   *
   * `plugin-install` takes its tail the same way.
   */
  rest: readonly string[]
}

/**
 * Parse user-supplied CLI arguments (already stripped of the executable path).
 * Bare invocation (`lumanin`) means `toggle` — it is the overwhelmingly common
 * case and what compositor binds call.
 */
export function parseArgs(args: readonly string[]): ParsedArgs {
  const positional = args.filter((a) => !a.startsWith('-'))
  const flags = new Set(args.filter((a) => a.startsWith('-')))

  const base: ParsedArgs = {
    verb: null,
    clientCommand: null,
    help: false,
    version: false,
    flags,
    unknown: null,
    rest: positional.slice(1)
  }

  if (flags.has('-h') || flags.has('--help')) return { ...base, help: true }
  if (flags.has('-v') || flags.has('--version')) return { ...base, version: true }
  // `--config` as well as `config`: it is the spelling people try first, and a
  // launcher that answers "unknown verb" to it has failed at its one job here.
  if (flags.has('--config')) return { ...base, clientCommand: 'config' }

  const first = positional[0]
  if (first === undefined) return { ...base, verb: { kind: 'toggle' } }
  // `open` carries its target. An empty one still parses — the CLI turns it
  // into a usage message, which beats "unknown verb 'open'" for a verb we have.
  if (first === 'open') return { ...base, verb: { kind: 'open', target: positional[1] ?? '' } }
  if (isVerbKind(first)) return { ...base, verb: { kind: first } }
  if ((CLIENT_COMMANDS as readonly string[]).includes(first)) {
    return { ...base, clientCommand: first as ClientCommand }
  }
  return { ...base, unknown: first }
}
