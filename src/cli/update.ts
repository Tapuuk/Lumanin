import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ID } from '../shared/identity'
import { applyUpdate, checkForUpdates, detectInstall, managerHint } from '../node/update'
import { readVersion, repoRoot, request, startDaemon } from './client'
import { resolvePaths } from '../node/paths'

/**
 * `lumanin update` - is there a newer launcher, and install it.
 *
 *   update           check, then ask before applying (when there is a terminal)
 *   update --check   only report
 *   update --yes     apply without asking
 *
 * Exit codes: 0 up to date or updated; 1 something failed; 3 an update is
 * available but was not applied (`--check`, or the user said no) - so a script
 * can tell the three apart.
 */
export async function runUpdate(flags: ReadonlySet<string>): Promise<number> {
  const root = repoRoot()
  const install = await detectInstall(root)
  const check = await checkForUpdates(install, readVersion())
  const out = (line: string): boolean => process.stdout.write(`${line}\n`)

  out(`installed: ${check.current}${describe(install)}`)
  if (check.problem !== null) {
    out(check.problem)
    if (install.kind === 'package') out(`  ${managerHint(install.manager, install.name)}`)
    return install.kind === 'package' ? 0 : 1
  }
  if (!check.available) {
    out('up to date')
    return 0
  }
  out(`update available: ${String(check.changes.length)} new commit${check.changes.length === 1 ? '' : 's'}${check.latest === null ? '' : ` (${check.latest})`}`)
  for (const line of check.changes.slice(0, 15)) out(`  ${line}`)
  if (check.changes.length > 15) out(`  ... and ${String(check.changes.length - 15)} more`)
  if (check.dirty) out(`note: ${root} has local edits; the update will refuse to overwrite them`)

  if (flags.has('--check')) return 3
  if (!flags.has('--yes')) {
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      out(`run \`${APP_ID} update --yes\` to apply`)
      return 3
    }
    const readline = await import('node:readline/promises')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    let answer = ''
    try {
      answer = (await rl.question('Update now? It rebuilds in place and restarts the launcher. [Y/n] ')).trim()
    } finally {
      rl.close()
    }
    if (/^n/i.test(answer)) return 3
  }

  const outcome = await applyUpdate(install, (line) => out(`  ${line}`))
  if (!outcome.ok) {
    process.stderr.write(`${APP_ID}: ${outcome.log}\n`)
    return 1
  }
  if (outcome.restart) {
    const socket = resolvePaths().socket
    if ((await request(socket, { kind: 'ping' })) !== null) {
      await request(socket, { kind: 'quit' })
      const gone = Date.now() + 5000
      while (Date.now() < gone && (await request(socket, { kind: 'ping' })) !== null) {
        await new Promise((r) => setTimeout(r, 100))
      }
      out(await startDaemon(socket) ? 'launcher restarted' : 'launcher stopped; it starts again on the next press')
    }
  }
  // Read fresh: `readVersion()` goes through require's cache and would name the
  // version this process started with.
  let after = 'the newest version'
  try {
    after = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? after
  } catch {
    // Left as the generic sentence.
  }
  out(`updated to ${after}`)
  return 0
}

function describe(install: Awaited<ReturnType<typeof detectInstall>>): string {
  switch (install.kind) {
    case 'git':
      return `, a git checkout at ${install.root} (${install.branch})`
    case 'package':
      return `, from the ${install.manager} package ${install.name}`
    case 'unknown':
      return `, at ${install.root}`
  }
}
