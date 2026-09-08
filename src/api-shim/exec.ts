/**
 * Running a program, without the React part.
 *
 * `useExec` is the hook; this is everything it does that is worth reasoning
 * about on its own — argument splitting, spawning, decoding, and what a failure
 * turns into. Split out for two reasons: the rules here have exact answers and
 * deserve direct tests, and `src/api-shim/lumanin.ts` re-exports `./utils`
 * wholesale, so anything left in that file becomes part of the surface a plugin
 * can import. A helper is not an API.
 */

import type { ChildProcess } from 'node:child_process'

/** `ExecOptions`, verbatim from the spec. Defaults are the spec's, not ours. */
export interface ExecOptions {
  /** `true` runs the line through `/bin/sh -c`; a string names a different shell. */
  shell?: boolean | string
  /** @default true */
  stripFinalNewline?: boolean
  cwd?: string
  /** Extends `process.env`; a key given here wins over an inherited one. */
  env?: NodeJS.ProcessEnv
  /** `"buffer"` leaves stdout and stderr as `Buffer`s. @default "utf8" */
  encoding?: BufferEncoding | 'buffer'
  input?: string | Buffer
  /** SIGTERM after this many ms. @default 10000 */
  timeout?: number
}

/** Everything `parseOutput` is handed. A failure arrives here, it is not thrown past it. */
export interface ExecOutcome<D extends string | Buffer = string> {
  stdout: D
  stderr: D
  error?: Error
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  /** The whole line, for logging. */
  command: string
  options?: ExecOptions
}

export type ParseExecOutput<T, D extends string | Buffer> = (outcome: ExecOutcome<D>) => T

/**
 * Split a command line into a file and its arguments.
 *
 * The spec is unusually precise here and the precision is the point: *"if the
 * file or an argument of the command contains spaces, they must be escaped with
 * backslashes. Except for spaces, no escaping/quoting is needed."* So this is
 * deliberately **not** a shell parser — `"` and `'` are ordinary characters, and
 * a plugin that writes `grep "foo bar"` gets the quotes in its argument, exactly
 * as it would from the real API. Anyone wanting shell syntax passes `shell`.
 */
export function splitCommand(command: string): { file: string; args: string[] } {
  const parts: string[] = []
  let current = ''
  let escaped = false
  for (const char of command) {
    if (escaped) {
      // Only a space is escapable; anything else keeps its backslash, so a
      // Windows-shaped path or a regex in an argument survives intact.
      current += char === ' ' ? ' ' : '\\' + char
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n') {
      if (current.length > 0) parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (escaped) current += '\\'
  if (current.length > 0) parts.push(current)
  return { file: parts[0] ?? '', args: parts.slice(1) }
}

function stripNewline<D extends string | Buffer>(value: D, strip: boolean): D {
  if (!strip || typeof value !== 'string') return value
  return value.replace(/\r?\n$/, '') as D
}

/**
 * How long a killed child gets to exit on its own before SIGKILL.
 *
 * The escalation is reachable in two situations: a command that runs past its
 * own timeout, and one aborted while its session carries on — a popped view
 * whose worker keeps living. A child whose worker is torn down instead is
 * orphaned regardless of this value: the timer dies with the isolate, and the
 * child belongs to the host process rather than to the thread that spawned it.
 */
const KILL_GRACE_MS = 1000

/** Children already on their way to SIGKILL, so a second arming is a no-op. */
const escalating = new WeakSet<ChildProcess>()

/**
 * Make a SIGTERM final.
 *
 * SIGTERM is a request, and a program is entitled to ignore it — a shell
 * trapping it, or a child mid-syscall. Left there, the promise waiting on
 * `close` never settles and the hook behind it stays loading forever. The timer
 * is `unref`'d so a process that is otherwise finished does not wait on it, and
 * it is cleared the moment the child exits so a well-behaved one is never
 * signalled twice.
 */
export function killAfterGrace(child: ChildProcess, graceMs = KILL_GRACE_MS): void {
  if (child.pid === undefined || escalating.has(child)) return
  escalating.add(child)

  const timer = setTimeout(() => {
    child.kill('SIGKILL')
  }, graceMs)
  timer.unref?.()
  child.once('exit', () => clearTimeout(timer))
}

/**
 * Run one command to completion.
 *
 * The process rule — *"anything that spawns a process takes an argv array,
 * never a shell string built by concatenation"* — is why the argv form is the
 * primary shape and `shell` is opt-in with the spec's own warning attached. The
 * extension host is explicitly not a security boundary (a plugin already has
 * full Node), so this is about the plugin not shooting itself: a plugin that
 * interpolates a search query into a command line is the injection, and the argv
 * form makes not doing that the easy path.
 */
export async function runCommand(
  file: string,
  args: readonly string[],
  options: ExecOptions,
  signal: AbortSignal
): Promise<ExecOutcome<string | Buffer>> {
  const { spawn } = await import('node:child_process')
  const encoding = options.encoding ?? 'utf8'
  const timeout = options.timeout ?? 10_000
  const useShell = options.shell !== undefined && options.shell !== false
  const line = [file, ...args].join(' ')
  // The spec says `env` extends `process.env`. The caller's map is spread last
  // so a key given there wins over an inherited one of the same name.
  const env = options.env === undefined ? process.env : { ...process.env, ...options.env }

  const child = useShell
    ? spawn(options.shell === true ? '/bin/sh' : String(options.shell), ['-c', line], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env,
        signal
      })
    : spawn(file, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env,
        signal
      })

  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))

  // A child that never started — a missing binary is the common case — has
  // already-destroyed stdio, and writing to it emits `error` on the stream.
  // Unhandled, that is rethrown, and the plugin's error card would then name a
  // stream failure instead of the command that does not exist.
  child.stdin?.on('error', () => undefined)

  if (options.input !== undefined) {
    child.stdin?.end(options.input)
  } else {
    // Leaving stdin open makes anything that reads it hang until the timeout,
    // which reads to the plugin author as "the command is slow".
    child.stdin?.end()
  }

  let timedOut = false
  const timer =
    timeout > 0
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
          killAfterGrace(child)
        }, timeout)
      : null

  const settled = await new Promise<{
    error?: Error
    exitCode: number | null
    signal: NodeJS.Signals | null
  }>((resolve) => {
    child.on('error', (error: Error) => {
      resolve({ error, exitCode: null, signal: null })
    })
    child.on('close', (code: number | null, bySignal: NodeJS.Signals | null) => {
      resolve({ exitCode: code, signal: bySignal })
    })
  })
  if (timer !== null) clearTimeout(timer)

  // An aborted spawn settles the instant Node sends its own SIGTERM, so this is
  // the one place the child can still be alive after the promise resolved.
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    killAfterGrace(child)
  }

  const decode = (chunks: Buffer[]): string | Buffer => {
    const joined = Buffer.concat(chunks)
    return encoding === 'buffer' ? joined : joined.toString(encoding)
  }
  const strip = options.stripFinalNewline !== false

  return {
    stdout: stripNewline(decode(out), strip),
    stderr: stripNewline(decode(err), strip),
    // A timeout arrives as a `close` with SIGTERM, not as an `error`, so keying
    // this off `settled.error` alone reported the one failure a plugin author is
    // most likely to want to handle as "was killed with SIGTERM" — true, and no
    // help at all in working out that the timeout they set is the reason.
    ...(settled.error === undefined && !timedOut
      ? {}
      : {
          error: timedOut
            ? new Error(`${line} timed out after ${String(timeout)} ms`)
            : settled.error
        }),
    exitCode: settled.exitCode,
    signal: settled.signal,
    timedOut,
    command: line,
    options
  }
}

/**
 * What happens when nobody passes `parseOutput`: stdout, or a thrown failure.
 *
 * The message is stderr's when there is one. A command that failed has almost
 * always already said why, and replacing that with "exited with code 1" throws
 * away the only useful sentence in the whole exchange.
 */
export function defaultParseOutput(outcome: ExecOutcome<string | Buffer>): string | Buffer {
  if (outcome.error !== undefined) throw outcome.error
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    const said = typeof outcome.stderr === 'string' ? outcome.stderr.trim() : ''
    const how =
      outcome.signal !== null
        ? `was killed with ${outcome.signal}`
        : `exited with code ${String(outcome.exitCode)}`
    throw new Error(said.length > 0 ? said : `${outcome.command} ${how}`)
  }
  return outcome.stdout
}

