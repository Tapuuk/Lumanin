import { execFile, spawn } from 'node:child_process'

/**
 * The one place the platform layer spawns processes.
 *
 * SECURITY.md rule 1: an argv array, never a shell string. Nothing here ever
 * reaches `/bin/sh`, so no amount of quoting in a clipboard payload or a window
 * title can turn into a command.
 *
 * Rule 2, less obvious: **payloads go on stdin, never in argv**. `/proc/<pid>/cmdline`
 * is world-readable, so `wl-copy -- <text>` publishes whatever was copied — which
 * for a launcher is routinely a password — to every process on the machine for as
 * long as the copy takes. Every backend here pipes instead.
 *
 * `Exec` is an interface rather than a bare function because it is the seam the
 * tests inject at: asserting the exact argv a backend builds is the only way to
 * test the ydotool/wtype/xdotool paths on a machine that has none of them.
 */

export interface RunOptions {
  /** Written to the child's stdin and then closed. */
  readonly stdin?: string
  readonly timeoutMs?: number
}

export interface RunResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  /** Set when the process could not be spawned or was killed. */
  readonly error?: string
}

export interface Exec {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>
}

const DEFAULT_TIMEOUT_MS = 2000

export const systemExec: Exec = {
  run(command, args, options = {}) {
    return new Promise<RunResult>((resolve) => {
      const child = execFile(
        command,
        [...args],
        {
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8'
        },
        (error, stdout, stderr) => {
          resolve({
            ok: error === null,
            stdout: stdout || '',
            stderr: stderr || '',
            ...(error === null ? {} : { error: error.message })
          })
        }
      )

      if (options.stdin === undefined) return

      // A child that exits before reading stdin (a missing binary, a helper that
      // rejects its arguments) makes this pipe EPIPE. That is the child's failure
      // to report, not a crash of the daemon.
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(options.stdin)
    })
  }
}

export interface LineStream {
  stop(): void
}

/**
 * Spawn a process that runs until we stop it, and deliver its stdout a line at a
 * time.
 *
 * Separate from {@link Exec} because everything there is request/response, and a
 * change *subscription* is neither: `gdbus monitor` never exits, has no exit
 * code worth waiting for, and must not hold the daemon open. This is the only
 * other place the platform layer starts a process, and it obeys the same
 * SECURITY.md rules — argv array, no shell, nothing sensitive in argv.
 *
 * `onExit` fires if the child dies on its own. Callers treat that as "this
 * source stopped being live", not as a crash: the theme still resolves, it just
 * stops following changes until the next restart.
 */
export function spawnLines(
  command: string,
  args: readonly string[],
  onLine: (line: string) => void,
  onExit?: (reason: string) => void
): LineStream {
  let child: ReturnType<typeof spawn> | null = null
  try {
    child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (error) {
    onExit?.(String(error))
    return { stop: () => undefined }
  }

  // The daemon must be able to exit with this running; a monitor is a courtesy,
  // not a reason to keep the process alive.
  child.unref()

  // …but it must not *outlive* us either. `unref` only drops the event-loop
  // reference; the child stays in our process group and keeps running when we
  // go, which orphans a monitor for the rest of the session and makes anything
  // waiting on the group — a test harness, a supervising unit — wait forever.
  const killOnExit = (): void => {
    child?.kill()
  }
  process.once('exit', killOnExit)

  let buffer = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    // Bounded so a child that never emits a newline cannot grow without limit.
    if (buffer.length > 1024 * 1024) buffer = buffer.slice(-4096)

    let index = buffer.indexOf('\n')
    while (index !== -1) {
      onLine(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  })

  child.on('error', (error) => onExit?.(error.message))
  child.on('exit', (code, signal) => onExit?.(`exited with ${String(signal ?? code)}`))

  return {
    stop: () => {
      process.removeListener('exit', killOnExit)
      child?.removeAllListeners('exit')
      child?.kill()
    }
  }
}
