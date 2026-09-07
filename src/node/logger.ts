import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { ENV_PREFIX } from '../shared/identity'

/**
 * Structured JSONL logging.
 *
 * Redaction lives here and only here. It is the logger's job
 * rather than each call site's: clipboard contents, `password`-typed preference
 * values must never reach disk, and a rule that depends on every
 * future call site remembering it is a rule that will be broken.
 */

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type Level = (typeof LEVELS)[number]

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * Field names whose values are replaced wholesale. Matching is
 * case-insensitive and substring-based so that `oauthToken`, `access_token` and
 * `refreshToken` are all caught by `token`.
 */
const REDACTED_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'clipboard',
  'credential',
  'privatekey',
  'private_key'
]

const REDACTED = '[redacted]'

/** Depth guard: log payloads are diagnostics, not object dumps. */
const MAX_DEPTH = 6
const MAX_ARRAY = 50
const MAX_STRING = 2000

export type Fields = Record<string, unknown>

function keyIsSecret(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '')
  return REDACTED_KEY_PATTERNS.some((pattern) => normalized.includes(pattern.replace(/_/g, '')))
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth-limit]'
  if (value === null || value === undefined) return value

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[${value.length} chars]` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function') return '[function]'
  if (typeof value === 'symbol') return value.toString()

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (value instanceof Date) return value.toISOString()

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1))
    if (value.length > MAX_ARRAY) items.push(`…[${value.length - MAX_ARRAY} more]`)
    return items
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = keyIsSecret(key) ? REDACTED : redact(inner, depth + 1)
    }
    return out
  }

  return String(value)
}

export function parseLevel(raw: string | undefined, fallback: Level = 'info'): Level {
  if (raw === undefined) return fallback
  const normalized = raw.toLowerCase().trim()
  return (LEVELS as readonly string[]).includes(normalized) ? (normalized as Level) : fallback
}

export interface LogRecord {
  time: string
  level: Level
  msg: string
  [field: string]: unknown
}

export type Sink = (record: LogRecord) => void

/** Rotate at 4 MiB, keep one previous file. Logs are diagnostics, not an archive. */
const ROTATE_BYTES = 4 * 1024 * 1024

/**
 * Appending JSONL to a file that another process may also hold open is safe on
 * Linux for writes below PIPE_BUF, but rotation is not. Only the daemon installs
 * this sink; short-lived processes (the CLI) log to stderr.
 */
export function createFileSink(logDir: string, basename = 'lumanin.jsonl'): Sink {
  mkdirSync(logDir, { recursive: true, mode: 0o700 })
  const file = join(logDir, basename)

  let stream: WriteStream = openStream()
  let written = sizeOf(file)

  /**
   * A write stream that cannot take the process down with it.
   *
   * A `WriteStream` with no `error` listener re-emits its failure as an
   * uncaught exception, and in the main process Electron turns that into a
   * modal "A JavaScript error occurred" dialog. A disk that filled up, or a log
   * directory that went away, must cost us log lines and nothing else.
   */
  function openStream(): WriteStream {
    const opened = createWriteStream(file, { flags: 'a', mode: 0o600 })
    opened.on('error', () => {
      // Nothing to say and nowhere to say it: reporting a logging failure
      // through the logger is how one bad write becomes a loop.
    })
    return opened
  }

  function sizeOf(path: string): number {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  }

  function rotateIfNeeded(): void {
    if (written < ROTATE_BYTES) return
    stream.end()
    try {
      renameSync(file, `${file}.1`)
    } catch {
      // A failed rotation must not take logging down with it.
    }
    stream = openStream()
    written = 0
  }

  return (record) => {
    const line = `${JSON.stringify(record)}\n`
    written += Buffer.byteLength(line)
    try {
      stream.write(line)
    } catch {
      // A synchronous throw (a stream ended by a racing rotation) is the same
      // kind of nothing as an async one.
    }
    rotateIfNeeded()
  }
}

/**
 * Log lines to stderr — which is allowed to be a pipe that nobody is reading.
 *
 * The daemon inherits whatever stderr the thing that started it had: a
 * terminal, the journal, or a parent process's pipe. When that parent goes
 * away the pipe breaks, and the *next* write raises `EPIPE`. Unhandled, that
 * is an uncaught exception in the main process, which Electron shows as a
 * modal error dialog and which leaves the IPC that dispatches window actions
 * dead behind it — one dropped log line taking the whole app's interactivity
 * with it. Observed from a `Logger.error` call after the parent
 * that owned the pipe was killed.
 *
 * Losing a diagnostic line is the correct outcome; the process staying up is
 * the point.
 */
export function createStderrSink(): Sink {
  let broken = false

  return (record) => {
    if (broken) return
    const { time, level, msg, ...rest } = record
    const tail = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : ''
    try {
      process.stderr.write(`${time} ${level.toUpperCase().padEnd(5)} ${msg}${tail}\n`, (error) => {
        // The async half: `write` reports a broken pipe through its callback,
        // and without one the stream re-emits it as an uncaught exception.
        if (error !== null && error !== undefined) broken = true
      })
    } catch {
      // The sync half: once the fd is gone the write throws outright.
      broken = true
    }
  }
}

export class Logger {
  private readonly sinks: Sink[]

  constructor(
    private level: Level,
    sinks: Sink[],
    private readonly bound: Fields = {}
  ) {
    this.sinks = sinks
  }

  static fromEnv(sinks: Sink[], env: Readonly<Record<string, string | undefined>> = process.env): Logger {
    return new Logger(parseLevel(env[`${ENV_PREFIX}LOG`]), sinks)
  }

  setLevel(level: Level): void {
    this.level = level
  }

  addSink(sink: Sink): void {
    this.sinks.push(sink)
  }

  /** Derive a logger that stamps every record with extra fields (extensionName, sessionId, …). */
  child(fields: Fields): Logger {
    return new Logger(this.level, this.sinks, { ...this.bound, ...fields })
  }

  debug(msg: string, fields?: Fields): void {
    this.write('debug', msg, fields)
  }
  info(msg: string, fields?: Fields): void {
    this.write('info', msg, fields)
  }
  warn(msg: string, fields?: Fields): void {
    this.write('warn', msg, fields)
  }
  error(msg: string, fields?: Fields): void {
    this.write('error', msg, fields)
  }

  private write(level: Level, msg: string, fields?: Fields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return

    const merged = { ...this.bound, ...fields }
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      msg,
      ...(redact(merged) as Fields)
    }

    for (const sink of this.sinks) {
      try {
        sink(record)
      } catch {
        // Never let a broken sink propagate into application code.
      }
    }
  }
}
