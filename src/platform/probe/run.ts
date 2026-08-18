import { execFile } from 'node:child_process'

/**
 * Subprocess helper for probes.
 *
 * Rule 1: anything that spawns a process takes an argv array, never
 * a shell string built by concatenation. `execFile` without a shell is the whole
 * point — none of these arguments ever reach `/bin/sh`.
 *
 * Probes run at daemon start and must never hang it, so every call is bounded by
 * a timeout and a failure is just "not available".
 */

export interface RunResult {
  readonly ok: boolean
  readonly stdout: string
}

const DEFAULT_TIMEOUT_MS = 2000

export function run(
  command: string,
  args: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        resolve({ ok: error === null, stdout: stdout || '' })
      }
    )
  })
}
