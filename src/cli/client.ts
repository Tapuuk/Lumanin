import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { APP_ID } from '../shared/identity'
import type { Response, Verb } from '../shared/protocol'

/**
 * Finding the daemon, and talking to it.
 *
 * Split out of `index.ts` so the **hot path stays small**. `lumanin toggle` is
 * what a compositor keybind runs, so its startup cost lands on every press of
 * the hotkey — and measured here, Node itself is ~35 ms and everything we add on
 * top of it was another ~13 ms, most of it parsing and initialising modules that
 * only `doctor` and `config` ever touch (the platform probes, the fix planner,
 * the theme packs, the whole TUI). Those now live in `tools.ts` and are reached
 * through a dynamic import, so the toggle path loads this file and nothing else.
 */

const CONNECT_TIMEOUT_MS = 1500
const DAEMON_START_TIMEOUT_MS = 10_000
const RETRY_INTERVAL_MS = 50

export function fail(message: string, code = 1): never {
  process.stderr.write(`${APP_ID}: ${message}\n`)
  process.exit(code)
}

/** Send one request and resolve with the daemon's reply, or `null` if nothing is listening. */
export function request(
  socketPath: string,
  verb: Verb,
  // `enumerate` runs a plugin and legitimately takes seconds; everything else
  // keeps the tight default that makes a dead socket feel dead immediately.
  timeoutMs: number = CONNECT_TIMEOUT_MS
): Promise<Response | null> {
  return new Promise((resolve) => {
    const socket = connect(socketPath)
    let buffer = ''
    let settled = false

    const finish = (value: Response | null): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }

    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.on('error', () => finish(null))

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, verb })}\n`)
    })

    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      try {
        finish(JSON.parse(buffer.slice(0, newline)) as Response)
      } catch {
        finish(null)
      }
    })

    socket.on('close', () => finish(null))
  })
}

/**
 * Find the daemon executable. Three layers, most specific first:
 *   1. `$LUMANIN_ELECTRON` — an explicit override, used by tests and packagers.
 *   2. A packaged `lumanin` binary sitting beside this script.
 *   3. The dev-tree Electron in `node_modules`, launched against the repo root.
 */
export function resolveDaemonCommand(): { command: string; args: string[] } | null {
  const override = process.env['LUMANIN_ELECTRON']
  if (override !== undefined && override.length > 0) {
    return { command: override, args: [] }
  }

  const packaged = join(dirname(process.execPath), APP_ID)
  if (isExecutable(packaged)) return { command: packaged, args: [] }

  const root = repoRoot()
  const electronBinary = join(root, 'node_modules', 'electron', 'dist', 'electron')
  if (isExecutable(electronBinary)) {
    return { command: electronBinary, args: [root] }
  }

  return null
}

/**
 * Why the daemon is not up after `startDaemon`, as a sentence a user can act on.
 *
 * Since Electron 43 the npm package no longer downloads its binary in a
 * postinstall step: `npm ci` leaves `node_modules/electron/` with no `dist/`,
 * and the first `require('electron')` fetches it. Nothing here requires it -
 * the daemon is spawned by path - so a tree that was installed but never
 * fetched has no launcher at all. `scripts/install.sh` runs the fetch; this
 * names it for a tree that skipped the script.
 */
export function missingDaemonHint(): string {
  const root = repoRoot()
  const binary = join(root, 'node_modules', 'electron', 'dist', 'electron')
  if (existsSync(binary)) {
    return `it exited while starting; run \`${binary} ${root}\` in a terminal to see why`
  }
  if (existsSync(join(root, 'node_modules', 'electron', 'install.js'))) {
    return `the Electron binary was never downloaded; run \`node node_modules/electron/install.js\` in ${root}`
  }
  return 'is the app installed?'
}

/**
 * The dev tree's root: the nearest ancestor with a `package.json`.
 *
 * **Not** a fixed number of `..` from `__dirname` — this module is shared by
 * the CLI and the settings app, so the bundler may emit it at `out/main/cli.js`
 * or under `out/main/chunks/`, and a hardcoded depth is correct in exactly one
 * of those places. Counting levels is how `lumanin settings` (and, worse, the
 * CLI's daemon start-on-demand) silently broke when this file first became a
 * shared chunk. Nothing between the repo root and the emitted bundles has a
 * `package.json`, so the walk is unambiguous.
 */
export function repoRoot(): string {
  let current = __dirname
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = resolvePath(current, '..')
    if (parent === current) break
    current = parent
  }
  return resolvePath(__dirname, '..', '..')
}

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function startDaemon(socketPath: string): Promise<boolean> {
  const daemon = resolveDaemonCommand()
  if (daemon === null) return false

  // `ELECTRON_RUN_AS_NODE` is how the launcher runs *this* CLI on Electron's
  // bundled Node when the machine has none of its own. Inheriting it would make
  // the daemon start as a bare Node process too — where `require('electron')`
  // yields a path string instead of the API, so `app` is undefined and it dies
  // before it can listen. The symptom is "none could be started" with no clue.
  // `LUMANIN_SETTINGS` must go too: this module also runs *inside* the settings
  // app (restartDaemon, enumerate's start-on-demand), whose environment carries
  // that flag — inherited, the "daemon" would boot as a second settings app,
  // lose the settings single-instance lock, and exit.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, LUMANIN_SETTINGS: _settings, ...env } = process.env

  // Detached with stdio ignored: the daemon must outlive this CLI invocation and
  // must not hold the terminal open.
  const child = spawn(daemon.command, daemon.args, {
    detached: true,
    stdio: 'ignore',
    env
  })
  // A command that is not there reports ENOENT by emitting `error` a tick later,
  // and an `error` event with no listener is rethrown — so a broken install
  // answered `lumanin toggle` with a Node stack trace instead of the sentence
  // below, at exactly the moment a sentence is worth the most. The poll loop is
  // what decides success; this only stops the failure being fatal.
  child.on('error', () => undefined)
  child.unref()

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS))
    const reply = await request(socketPath, { kind: 'ping' })
    if (reply !== null) return true
  }
  return false
}

/**
 * Launch the settings app — a separate application, not a daemon verb.
 *
 * In the dev tree it is launched *as* `settings-shell/`, a one-line Electron
 * app whose package name is `lumanin-settings`: on Wayland that package name
 * is the only thing that sets the window's app_id (see the shell's own note),
 * and the app_id is what keeps the panel's compositor rules off this window.
 * A packaged or overridden binary gets `--settings` instead — the dispatcher
 * understands both spellings.
 *
 * Detached and unwaited, like any GUI launch; the app holds its own
 * single-instance lock, so a second launch focuses the first.
 */
export function launchSettings(): boolean {
  const daemon = resolveDaemonCommand()
  if (daemon === null) return false

  // The dev shape is `electron <repoRoot>` — swap the app directory for the
  // settings shell. Any other shape (packaged binary, $LUMANIN_ELECTRON) takes
  // the flag.
  const root = repoRoot()
  const args =
    daemon.args.length === 1 && daemon.args[0] === root
      ? [join(root, 'settings-shell')]
      : [...daemon.args, '--settings']

  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  const child = spawn(daemon.command, args, {
    detached: true,
    stdio: 'ignore',
    env
  })
  child.on('error', () => undefined)
  child.unref()
  return true
}

export function readVersion(): string {
  try {
    const pkg = require(join(repoRoot(), 'package.json')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

