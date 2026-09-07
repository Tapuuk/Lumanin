import { APP_DISPLAY_NAME, APP_ID } from '../shared/identity'
import { firstRunPending, markFirstRunOffered } from '../node/first-run'
import { resolvePaths } from '../node/paths'
import { CLIENT_COMMANDS, parseArgs, VERB_KINDS } from '../shared/protocol'
import { fail, launchSettings, missingDaemonHint, readVersion, request, restartIfStale, startDaemon } from './client'

/**
 * The `lumanin` CLI.
 *
 * A plain Node script — it must never import `electron`. It is what compositor
 * binds invoke, so its startup cost is on the user's critical path: talking to
 * the running daemon over its socket takes single-digit milliseconds, where
 * booting Electron to forward argv takes hundreds.
 *
 * If no daemon is listening the CLI starts one and retries, so a fresh
 * `lumanin toggle` from a keybind works on the very first press.
 *
 * Deliberately thin. Everything except verb dispatch lives in `tools.ts` behind
 * a dynamic import, because this file's parse and init time is paid on **every
 * press of the hotkey** — see the note in `client.ts` for the measurement.
 */

const USAGE = `${APP_DISPLAY_NAME} - a keyboard-first launcher for Linux

Usage: ${APP_ID} [verb]

Verbs:
  toggle    show the panel, or hide it if already visible (default)
  show      show the panel
  hide      hide the panel
  status    print the running daemon's status as JSON
  ping      exit 0 if a daemon is running, 1 otherwise
  reload    re-read config.toml and apply it (the file is watched, so this is
            only needed where a filesystem watch is unavailable)
  quit      stop the daemon

  open <target>
            show the panel already on one thing: an app, a command, or a
            plugin category (extension:1password/search#logins). This is the
            verb the [[hotkeys]] section's binds run - set them up in
            ${APP_ID} config.

  start     start the daemon if it is not already running, and leave it hidden
            (what the autostart entry runs; there is no separate "stop")

  settings  open the settings app, as a window. Also in your app grid as
            "${APP_DISPLAY_NAME} Settings". It needs no daemon and touches
            nothing of the panel's. \`config\` is the same thing in the
            terminal.

Plugins:
  plugins   the plugins you have installed, as a menu: turn one off without
            deleting it, choose which of its commands appear, set its
            preferences, or remove it.

  plugin-install <repository>
            install a plugin from any public git repository over https:
              plugin-install owner/name
              plugin-install https://github.com/owner/name
              plugin-install https://github.com/owner/name/tree/main/sub/dir
            Shows you what it is and who wrote it, then asks. Nobody has
            reviewed it - see the trust note below.
              --yes   skip the confirmation
              --deps  allow npm dependencies (install scripts stay disabled)

  plugin-export <name>
            copy an installed plugin's source into your Downloads folder as a
            directory ready to push to a public repository - the other half of
            plugin-install. Add a directory argument to export somewhere else.

  ext       manage what is already installed
              ext list                show what is installed, and where from
              ext remove <name>       uninstall
              ext dev <dir>           rebuild and reload on every change

Configuration:
  config    every setting, as an interactive menu in this terminal. The same
            settings as the \`settings\` window; both write
            ${APP_ID}/config.toml, keeping a backup and preserving keys they
            do not recognise; editing that file by hand still works.

Updating:
  update    check whether a newer launcher exists where this one came from
            (a git checkout pulls; a distro package names its manager) and,
            with your say-so, install it, rebuild in place and restart.
              --check     only report; exit 3 when an update is available
              --yes       apply without asking

Diagnostics:
  doctor    report the detected platform and the backend chosen per capability.
            Runs entirely in this process - it needs no daemon, which is the
            whole point of a diagnostic.
              --json      machine-readable output
              --verbose   also show every candidate backend and why it lost
              --fix       install the compositor rules, keybind and autostart
                          entry, after showing you the exact diff
              --unfix     remove everything --fix installed
              --yes       skip the confirmation prompt (for scripts)

Options:
  -h, --help       show this help
  -v, --version    show the version

With no verb, ${APP_ID} toggles. Starting the daemon if it is not running is
automatic; there is no separate "start" verb.
`

/**
 * A closed pipe is not an error worth a stack trace.
 *
 * `lumanin status | head -1` and `lumanin doctor --json | rg something` both end
 * with the reader gone while we are still writing, and Node's default for an
 * unhandled `EPIPE` on stdout is to throw — so the user gets fifteen lines of
 * Node internals for having piped into `head`. Every other CLI on the system
 * exits quietly here, and so does this one.
 */
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))

  if (parsed.help) {
    process.stdout.write(USAGE)
    return
  }
  if (parsed.version) {
    process.stdout.write(`${readVersion()}\n`)
    return
  }
  // Loaded only now: `doctor` and `config` pull in the platform probes, the fix
  // planner, the theme packs and the whole terminal UI, and none of that may sit
  // on the toggle path.
  if (parsed.clientCommand === 'doctor') {
    await (await import('./tools')).runDoctor(parsed.flags)
    return
  }
  if (parsed.clientCommand === 'config') {
    // `config` is the terminal menu, `settings` is the window (user decision:
    // a person typing a verb into a terminal wants the terminal
    // answer). Both edit the same config.toml, so which frontend answered
    // never matters. `--tui` is accepted for compatibility and is a no-op.
    process.exit(await (await import('./tools')).runConfig())
  }
  if (parsed.clientCommand === 'ext') {
    process.exit(await (await import('./ext')).runExt(parsed.rest))
  }
  if (parsed.clientCommand === 'plugins') {
    process.exit(await (await import('./tools')).runPlugins())
  }
  if (parsed.clientCommand === 'store') {
    // The menu's original name. Prints the new spelling rather than aliasing to
    // it — same rule as `ext install`, so both do not stay in circulation.
    process.stderr.write(`${APP_ID}: the plugin menu is \`${APP_ID} plugins\` now.\n`)
    process.exit(2)
  }
  if (parsed.clientCommand === 'plugin-install') {
    process.exit(await (await import('./plugin')).runPluginInstall(parsed.rest, parsed.flags))
  }
  if (parsed.clientCommand === 'plugin-export') {
    process.exit(await (await import('./plugin-export')).runPluginExport(parsed.rest))
  }
  if (parsed.clientCommand === 'update') {
    process.exit(await (await import('./update')).runUpdate(parsed.flags))
  }
  if (parsed.clientCommand === 'settings') {
    if (!launchSettings()) fail(`the settings app could not be started (${missingDaemonHint()})`)
    return
  }
  if (parsed.clientCommand === 'start') {
    const socketPath = resolvePaths().socket
    if ((await request(socketPath, { kind: 'ping' })) !== null) return
    if (!(await startDaemon(socketPath))) fail('the daemon could not be started')
    return
  }
  if (parsed.unknown !== null) {
    const known = [...VERB_KINDS, 'open', ...CLIENT_COMMANDS].join(', ')
    fail(`unknown verb '${parsed.unknown}'. Known verbs: ${known}`, 2)
  }

  const verb = parsed.verb
  if (verb === null) fail('nothing to do', 2)
  if (verb.kind === 'open' && verb.target.length === 0) {
    fail(
      `usage: ${APP_ID} open <target>\n` +
        `A target is a pin key: app:firefox.desktop, extension:1password/search#logins, …\n` +
        `This is what a [[hotkeys]] bind runs.`,
      2
    )
  }

  // First run, from the terminal door: someone typing `lumanin` into a shell
  // on an unconfigured machine gets offered the setup wizard before the panel,
  // because the panel cannot tell them there are keys to choose. Only when
  // there is a person to ask — a compositor bind has no TTY and skips all of
  // this, and the daemon offers the same wizard when the panel first shows.
  // Asked once, ever: the marker is written before the question.
  const paths = resolvePaths()
  if (
    (verb.kind === 'toggle' || verb.kind === 'show') &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    firstRunPending(paths.configFile, paths.state)
  ) {
    markFirstRunOffered(paths.state)
    process.stdout.write(`First run - ${APP_ID} has no configuration yet.\n`)
    const readline = await import('node:readline/promises')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question('Open the setup window now? [Y/n] ')).trim()
    rl.close()
    if (!/^n/i.test(answer)) {
      if (launchSettings()) {
        process.stdout.write(`Setup opened. Run \`${APP_ID}\` again when you are done.\n`)
        return
      }
      process.stderr.write(`the settings app could not be started; continuing\n`)
    }
  }

  const socketPath = paths.socket
  let reply = await request(socketPath, verb)

  if (reply === null) {
    // `ping` asks whether a daemon is running; it must never start one.
    if (verb.kind === 'ping') process.exit(1)
    // Nor should `hide`/`quit` boot a daemon just to tell it to go away.
    if (verb.kind === 'hide' || verb.kind === 'quit') return
    // Nothing is running, so there is no stale config to replace. Starting a
    // daemon in order to reload it would read the same file it would have read
    // anyway, a second later, for no reason.
    if (verb.kind === 'reload') return

    if (!(await startDaemon(socketPath))) {
      fail(`no daemon running and none could be started (${missingDaemonHint()})`)
    }
    reply = await request(socketPath, verb)
  }

  if (reply === null) fail('daemon did not respond')
  if (!reply.ok) fail(reply.error)

  // A daemon older than this CLI is one a package upgrade left running. It
  // answered, so the press is not lost — it is replayed against the new code
  // once that is up. `quit` and `ping` are exempt: quitting a stale daemon is
  // the point, and `ping` promises never to start one.
  if (verb.kind !== 'quit' && verb.kind !== 'ping' && (await restartIfStale(socketPath, reply))) {
    reply = await request(socketPath, verb)
    if (reply === null) fail('the daemon was restarted for the new version but did not respond')
    if (!reply.ok) fail(reply.error)
  }

  if (reply.data !== undefined) {
    process.stdout.write(`${JSON.stringify(reply.data, null, 2)}\n`)
  }
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
})
