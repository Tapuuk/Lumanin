import { spawn } from 'node:child_process'

/**
 * Running git, for the two things that fetch source: the catalogue's pinned tree
 * and `plugin-install`'s arbitrary repository.
 *
 * Shared so there is one place that spawns git, and so the rule that matters is
 * stated once: **an argv array, never a shell string**. Both callers take a URL
 * from somewhere the user pointed at, and a
 * URL concatenated into a shell line is the classic way that ends badly.
 */

export interface RunResult {
  readonly ok: boolean
  readonly output: string
}

export type Run = (command: string, args: readonly string[], cwd: string) => Promise<RunResult>

/** Thrown with a message written for the person who ran the command. */
export class GitError extends Error {}

export function runCommand(command: string, args: readonly string[], cwd: string): Promise<RunResult> {
  return new Promise((settle) => {
    let output = ''
    const child = spawn(command, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Git must never stop and ask. Without this a repository that needs
        // credentials — a typo'd name, a private repo — hangs the CLI on a
        // prompt the user cannot see, because this output is being captured.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
        GCM_INTERACTIVE: 'never'
      }
    })
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', (error) => {
      settle({ ok: false, output: error.message })
    })
    child.on('close', (code) => {
      settle({ ok: code === 0, output })
    })
  })
}

export async function hasGit(run: Run, cwd: string): Promise<boolean> {
  return (await run('git', ['--version'], cwd)).ok
}

/** Run a step that has no meaningful partial success. */
export async function must(result: Promise<RunResult>, problem: string): Promise<void> {
  const settled = await result
  if (!settled.ok) throw new GitError(`${problem} - ${firstLine(settled.output)}`)
}

export function firstLine(output: string): string {
  return output.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'no output'
}
