import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runCommand, type Run } from '../store/git'

/**
 * Checking for, and applying, an update of the launcher itself.
 *
 * There is no update server: the source of truth is wherever this copy came
 * from. Two shapes are recognised, and each is answered honestly:
 *
 * - **A git checkout** - `scripts/install.sh` from a clone, or the curl
 *   one-liner (which clones into `$XDG_DATA_HOME/lumanin/src`). The tree has a
 *   `.git`; the remote's branch is the newer version; applying is `git pull
 *   --ff-only` and the same install script, which rebuilds in place.
 * - **A distro package** - the tree is owned by pacman/dpkg/rpm. We do not
 *   pull over a package manager's files; the check reports what it can and
 *   applying prints the manager's own command. Today no package exists, so
 *   this branch is written from the manager's documented interfaces only.
 *
 * Anything else (a tarball, a copied directory) is `unknown`: reported as such,
 * never guessed at.
 *
 * Node-only (child processes, filesystem); the renderer sees the results over
 * the settings IPC.
 */

export type InstallKind =
  | { readonly kind: 'git'; readonly root: string; readonly branch: string }
  | { readonly kind: 'package'; readonly root: string; readonly manager: 'pacman' | 'apt' | 'rpm'; readonly name: string }
  | { readonly kind: 'unknown'; readonly root: string }

export interface UpdateCheck {
  readonly install: InstallKind
  /** True when something newer is known to exist. */
  readonly available: boolean
  /** What is running: `1.0.0 (a1b2c3d)` for git, the package version otherwise. */
  readonly current: string
  /** What would be installed, when known. */
  readonly latest: string | null
  /** For git: the commits behind, newest first, `<sha> <subject>`. */
  readonly changes: readonly string[]
  /** For git: uncommitted edits in the tree, which `--ff-only` will refuse over. */
  readonly dirty: boolean
  /** A sentence for the cases where the check could not decide. */
  readonly problem: string | null
}

export interface UpdateOutcome {
  readonly ok: boolean
  /** The tail of what happened, for the person watching. */
  readonly log: string
  /** Set when the daemon should be restarted for the new code to run. */
  readonly restart: boolean
}

export async function detectInstall(root: string, run: Run = runCommand): Promise<InstallKind> {
  if (existsSync(join(root, '.git'))) {
    const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root)
    const name = branch.ok ? branch.output.trim() : ''
    return { kind: 'git', root, branch: name.length > 0 && name !== 'HEAD' ? name : 'main' }
  }
  const owner = await packageOwner(root, run)
  if (owner !== null) return { kind: 'package', root, ...owner }
  return { kind: 'unknown', root }
}

async function packageOwner(
  root: string,
  run: Run
): Promise<{ manager: 'pacman' | 'apt' | 'rpm'; name: string } | null> {
  const probe = join(root, 'package.json')
  const pacman = await run('pacman', ['-Qqo', probe], root)
  if (pacman.ok) return { manager: 'pacman', name: pacman.output.trim().split(/\s+/)[0] ?? 'lumanin' }
  const dpkg = await run('dpkg', ['-S', probe], root)
  if (dpkg.ok) return { manager: 'apt', name: dpkg.output.split(':')[0]?.trim() ?? 'lumanin' }
  const rpm = await run('rpm', ['-qf', '--qf', '%{NAME}', probe], root)
  if (rpm.ok) return { manager: 'rpm', name: rpm.output.trim() || 'lumanin' }
  return null
}

export async function checkForUpdates(
  install: InstallKind,
  version: string,
  run: Run = runCommand
): Promise<UpdateCheck> {
  const base = { install, available: false, latest: null, changes: [], dirty: false, problem: null }
  if (install.kind === 'git') {
    const root = install.root
    const head = await run('git', ['rev-parse', '--short', 'HEAD'], root)
    const current = `${version} (${head.ok ? head.output.trim() : 'unknown'})`
    const fetch = await run('git', ['fetch', '--quiet', 'origin', install.branch], root)
    if (!fetch.ok) {
      return { ...base, current, problem: `could not reach the repository - ${lastLine(fetch.output)}` }
    }
    const status = await run('git', ['status', '--porcelain', '--untracked-files=no'], root)
    const dirty = status.ok && status.output.trim().length > 0
    const log = await run(
      'git',
      ['log', '--oneline', '--no-decorate', `HEAD..origin/${install.branch}`],
      root
    )
    if (!log.ok) return { ...base, current, dirty, problem: `could not compare - ${lastLine(log.output)}` }
    const changes = log.output.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    const remote = await run('git', ['rev-parse', '--short', `origin/${install.branch}`], root)
    return {
      ...base,
      current,
      dirty,
      available: changes.length > 0,
      latest: remote.ok ? remote.output.trim() : null,
      changes
    }
  }
  if (install.kind === 'package') {
    // A package manager knows the installed version and, after its own
    // refresh, the newest one. Only pacman is queried without root; the others
    // report the installed version and hand over.
    if (install.manager === 'pacman') {
      const installed = await run('pacman', ['-Q', install.name], install.root)
      const current = installed.ok ? installed.output.trim().split(/\s+/)[1] ?? version : version
      return {
        ...base,
        current,
        problem: `installed from a package (${install.name}); your package manager checks and applies updates for it`
      }
    }
    return { ...base, current: version, problem: `installed from a package (${install.name}); use your package manager` }
  }
  return { ...base, current: version, problem: 'not a git checkout or a package - update it the way it was installed' }
}

/**
 * Apply an update: fast-forward the checkout, then run the install script (which
 * rebuilds in place and re-links). Streams the script's output through `onLine`.
 * Never touches a packaged install.
 */
export async function applyUpdate(
  install: InstallKind,
  onLine: (line: string) => void,
  run: Run = runCommand
): Promise<UpdateOutcome> {
  if (install.kind !== 'git') {
    const hint =
      install.kind === 'package'
        ? `installed from a package: update it with your package manager (${managerHint(install.manager, install.name)})`
        : 'not a git checkout - update it the way it was installed'
    return { ok: false, log: hint, restart: false }
  }
  const root = install.root
  const pull = await run('git', ['pull', '--ff-only', 'origin', install.branch], root)
  onLine(pull.output.trim())
  if (!pull.ok) {
    return {
      ok: false,
      log: `git pull failed - ${lastLine(pull.output)}. Local edits in ${root}? Commit or stash them first.`,
      restart: false
    }
  }
  const script = join(root, 'scripts', 'install.sh')
  if (!existsSync(script)) return { ok: false, log: `${script} is missing`, restart: false }
  const lines: string[] = []
  const code = await new Promise<number>((settle) => {
    // stdin closed on purpose: the script asks about desktop setup only when
    // there is a terminal to answer, and this is not one.
    const child = spawn('bash', [script], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: pathWithNodeManagers(process.env['PATH'] ?? '', process.env['HOME'] ?? ''),
        // Tells the script it is a rebuild, not a first install: no PATH advice,
        // no "Installed. Next:" epilogue, no setup offer.
        LUMANIN_UPDATE: '1'
      }
    })
    const take = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim().length === 0) continue
        lines.push(line)
        onLine(line)
      }
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', (error) => {
      lines.push(error.message)
      settle(1)
    })
    child.on('close', (exit) => settle(exit ?? 1))
  })
  const tail = lines.slice(-12).join('\n')
  if (code !== 0) return { ok: false, log: `install script exited ${code}\n${tail}`, restart: false }
  return { ok: true, log: tail, restart: true }
}

/**
 * The script needs `node` and `npm`. From a terminal they are on PATH; from the
 * settings app - a GUI process whose environment is the session's, not a login
 * shell's - a version manager's node usually is not (mise, fnm, volta, asdf,
 * nvm all activate in the interactive rc file). Their standard shim/bin
 * directories are appended, after whatever PATH already has, so a system node
 * still wins and a managed one is at least found.
 */
export function pathWithNodeManagers(path: string, home: string): string {
  if (home.length === 0) return path
  const extra = [
    join(home, '.local', 'share', 'mise', 'shims'),
    join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.nvm', 'current', 'bin')
  ].filter((dir) => existsSync(dir) && !path.split(':').includes(dir))
  return extra.length === 0 ? path : `${path}:${extra.join(':')}`
}

export function managerHint(manager: 'pacman' | 'apt' | 'rpm', name: string): string {
  switch (manager) {
    case 'pacman':
      return `yay -Syu ${name}` // or paru; an AUR helper, since it would be an AUR package
    case 'apt':
      return `sudo apt install --only-upgrade ${name}`
    case 'rpm':
      return `sudo dnf upgrade ${name}`
  }
}

function lastLine(output: string): string {
  const lines = output.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  return lines[lines.length - 1] ?? 'no output'
}
