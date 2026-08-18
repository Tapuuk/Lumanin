import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { runConfigUi } from './config-ui'
import { probePlatform } from '../platform/detect'
import { buildReport, formatReport } from '../platform/doctor'
import {
  applyPlan,
  planFixes,
  planRevert,
  readManagedBinds,
  runCommands,
  type FixDirs
} from '../platform/fix/index'
import { bindable as desktopBindable, planBind, reloadNotes } from '../platform/fix/bind'
import { planGnomeBinds } from '../platform/fix/gnome'
import { loadConfig, type ResolvedConfig } from '../shared/config'
import type { EnumerateData } from '../shared/protocol'
import { DEFAULT_HOTKEY, type ExtraBind, type FixOptions, type HotkeyChoice } from '../platform/fix/actions'
import { parseHotkey, type Hotkey } from '../shared/hotkey'
import { APP_ID } from '../shared/identity'
import { bundledPluginsDir, resolvePaths } from '../node/paths'
import { readVersion, request, resolveDaemonCommand, startDaemon } from './client'

/**
 * Everything the CLI does that is not `toggle`.
 *
 * This module exists to be **absent** from the hot path. It pulls in the
 * platform probes, the fix planner, the theme packs and the terminal UI — tens
 * of thousands of lines that `lumanin toggle` has no use for, and whose parse
 * and module-init time would otherwise be paid on every press of the hotkey.
 * `index.ts` reaches it through a dynamic import, so none of it is touched
 * unless someone actually ran `doctor` or `config`.
 */

/**
 * `lumanin config`. Every setting, as a menu.
 *
 * Needs a terminal, and says so rather than half-working down a pipe: the whole
 * thing is cursor movement and raw-mode keys. Editing the file by hand stays
 * fully supported — this writes the same file.
 */
export async function runConfig(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const paths = resolvePaths()
    process.stderr.write(
      `${APP_ID}: config needs a terminal.\n` +
        `Edit ${paths.configFile} directly - see the CONFIG documentation.\n`
    )
    return 1
  }

  const paths = resolvePaths()
  const running = (await request(paths.socket, { kind: 'ping' })) !== null
  // Probed once, up front: the hotkey screen needs to know which compositor's
  // config it would be writing, and probing per keystroke would be a dozen
  // subprocesses every time the cursor moved.
  const profile = await probePlatform(process.env)
  const dirs = { config: paths.configHome, data: paths.dataHome }
  // Every desktop we know a bind mechanism for, which is no longer only the two
  // with a text config: KDE has kglobalaccel, GNOME has dconf, COSMIC has its
  // own RON file. What is left over — an unknown compositor, a bare X11 session
  // — still gets the "bind it yourself" screen rather than a broken promise.
  const bindable = desktopBindable(profile)

  return await runConfigUi({
    term: { input: process.stdin, output: process.stdout },
    env: process.env,
    configFile: paths.configFile,
    home: homedir(),
    extensionsDir: paths.extensionsDir,
    bundledDir: bundledPluginsDir(__dirname),
    dataDir: paths.data,
    // Both offered only when there is something to apply them to.
    //
    // `reload` is what a save normally needs, and the daemon watches the file
    // anyway — this is the belt to that braces, and it is what reports back
    // whether anything could *not* be applied live.
    applyChanges: running
      ? async () => {
          const reply = await request(paths.socket, { kind: 'reload' })
          if (reply === null) return { ok: false, detail: 'The daemon did not answer' }
          return reply.ok ? { ok: true } : { ok: false, detail: reply.error }
        }
      : null,
    // The panel window is created once at its configured size, so a new width or
    // height needs a new window. That is the only thing this is for.
    restartDaemon: running
      ? async () => {
          await request(paths.socket, { kind: 'quit' })
          return await startDaemon(paths.socket)
        }
      : null,
    // Only where there is a config file whose bind syntax we know. Everywhere
    // else the hotkey stays a setting the *portal* will eventually carry, and
    // `doctor` says so rather than this menu pretending it wrote something.
    planBind: bindable ? (choice) => planBind(profile, dirs, choice) : null,
    applyBind: bindable
      ? async (plan) => [...applyPlan(plan.edits, stamp()), ...(await applyCommands(plan.commands))]
      : null,
    // Read fresh on every draw rather than captured: the hotkeys screen writes
    // this file itself, and a cached answer would have it reporting the state
    // from before its own write.
    readBinds: bindable ? () => readManagedBinds(profile, dirs) : null,
    // Item pinning asks the plugin what a category holds, which needs a daemon.
    // One is started on demand — same policy as the toggle path.
    enumerateItems: async (command, category) => {
      const verb = { kind: 'enumerate' as const, command, category }
      let reply = await request(paths.socket, verb, ENUMERATE_TIMEOUT_MS)
      if (reply === null) {
        if (!(await startDaemon(paths.socket))) {
          throw new Error('the daemon could not be started, and only it can run the plugin')
        }
        reply = await request(paths.socket, verb, ENUMERATE_TIMEOUT_MS)
      }
      if (reply === null) throw new Error('the daemon did not answer')
      if (!reply.ok) throw new Error(reply.error)
      const data = reply.data as EnumerateData | undefined
      return data?.items ?? []
    }
  })
}

const applyCommands = async (fixes: readonly { commands: readonly (readonly string[])[] }[]) =>
  (await Promise.all(fixes.map((fix) => runCommands(fix.commands, run)))).flat()

/** The plugin gets 8 s daemon-side; this waits a little longer than that. */
const ENUMERATE_TIMEOUT_MS = 10_000

/**
 * `lumanin plugins`. The installed plugins, as a menu.
 *
 * Needs a terminal for the same reason `config` does. Unlike `config` it also
 * wants a daemon — not to work, but to apply: installing something with nothing
 * running is fine and the next start finds it, which the screen says rather
 * than implying the install did not take.
 */
export async function runPlugins(): Promise<number> {
  const paths = resolvePaths()

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      `${APP_ID}: plugins needs a terminal.\n` +
        `Install a directory you already have with \`${APP_ID} plugin-install <directory>\`.\n`
    )
    return 1
  }

  const running = (await request(paths.socket, { kind: 'ping' })) !== null

  return await (await import('./plugins')).runPluginsUi({
    term: { input: process.stdin, output: process.stdout },
    env: process.env,
    configFile: paths.configFile,
    extensionsDir: paths.extensionsDir,
    bundledDir: bundledPluginsDir(__dirname),
    dataDir: paths.data,
    cacheDir: paths.cache,
    reload: running
      ? async () => (await request(paths.socket, { kind: 'reload' }))?.ok === true
      : null
  })
}

/**
 * `lumanin doctor`. Runs the probes here rather than asking the daemon, so it
 * still works — and is still worth running — when the daemon will not start.
 */
export async function runDoctor(flags: ReadonlySet<string>): Promise<void> {
  const paths = resolvePaths()

  let fileContents: string | null = null
  try {
    fileContents = readFileSync(paths.configFile, 'utf8')
  } catch {
    fileContents = null
  }

  const profile = await probePlatform(process.env)
  const config = loadConfig({ fileContents, env: process.env })

  const dirs = { config: paths.configHome, data: paths.dataHome }

  if (flags.has('--fix')) {
    await runFix(profile, dirs, flags.has('--yes'), {
      ...hotkeyChoice(config),
      ...(daemonCommandLine() === null ? {} : { daemonCommand: daemonCommandLine() as string })
    })
    return
  }
  if (flags.has('--unfix')) {
    await runUnfix(profile, dirs, flags.has('--yes'))
    return
  }

  const report = buildReport(profile, config, readVersion())

  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  process.stdout.write(`${formatReport(report, flags.has('--verbose'))}\n`)
}

/**
 * `doctor --fix`. The rules, in order: show the diff, ask, apply
 * only what was consented to in this same run, back up, stay idempotent.
 */
async function runFix(
  profile: Awaited<ReturnType<typeof probePlatform>>,
  dirs: FixDirs,
  assumeYes: boolean,
  options: FixOptions
): Promise<void> {
  const plan = planFixes(profile, dirs, options)
  const out = process.stdout

  for (const edit of plan.edits) {
    if (edit.state === 'not-applicable') continue
    for (const action of edit.actions) out.write(`\n${action.title}\n  ${action.why}\n`)
    if (edit.state === 'blocked') {
      out.write(`  ! skipped: ${edit.problem ?? 'unknown problem'}\n`)
      continue
    }
    if (edit.state === 'up-to-date') {
      out.write(`  ✔ already installed in ${edit.path}\n`)
      continue
    }
    out.write(`${indent(edit.diff)}\n`)
  }

  if (plan.manual.length > 0) {
    // Deliberately not automated. Everything here needs root, and a launcher that
    // silently acquires uinput access is a launcher that silently acquires every
    // keystroke — that is the user's decision to make knowingly.
    out.write('\nNot done for you - these need root, so run them yourself:\n')
    for (const step of plan.manual) {
      out.write(`\n  ${step.title}\n    ${step.why}\n`)
      for (const command of step.commands) out.write(`      ${command}\n`)
    }
  }

  // GNOME's shortcuts live in dconf, so there is no file and no diff — the
  // honest equivalent is the exact commands, printed before they are run.
  const runnable = plan.commands.filter((fix) => fix.state === 'will-add' || fix.state === 'will-update')
  for (const fix of plan.commands) {
    out.write(`\n${fix.title}\n  ${fix.why}\n`)
    if (fix.state === 'up-to-date') out.write('  ✔ already set\n')
    for (const line of fix.preview) out.write(`  + ${line}\n`)
  }

  const pending = plan.edits.filter((e) => e.state === 'will-add' || e.state === 'will-update')
  if (pending.length === 0 && runnable.length === 0) {
    out.write('\nNothing to change.\n')
    return
  }

  const total = pending.length + runnable.length
  if (!assumeYes && !(await confirm(`\nApply ${String(total)} change(s)?`))) {
    out.write('Nothing was changed.\n')
    return
  }

  const results = applyPlan(pending, stamp())
  report(results)
  for (const fix of runnable) report(await runCommands(fix.commands, run))

  for (const line of reloadNotes(profile, plan)) out.write(`\n${line}\n`)

  if (results.some((result) => result.ok && result.path.endsWith('lumanin.service'))) {
    await enableUnit(out)
  }
}

/**
 * Turn a written unit into a running one.
 *
 * Writing the file is not enabling it — systemd needs to be told the unit exists
 * and that `graphical-session.target` wants it, and neither happens by itself.
 * Both commands are `--user`: nothing here touches system units, and nothing
 * here needs root, which is the line drawn for what `--fix` may run as
 * opposed to print.
 */
async function enableUnit(out: NodeJS.WriteStream): Promise<void> {
  for (const args of [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--now', `${APP_ID}.service`]
  ]) {
    const ok = await run('systemctl', args)
    out.write(`  ${ok ? '\u2714' : '\u2718'} systemctl ${args.join(' ')}\n`)
    if (!ok) {
      out.write('    Run it yourself once your session has a systemd user manager.\n')
      return
    }
  }
}

/** Run a command, argv array never a shell string. */
function run(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

/**
 * The command a systemd unit should run to keep the daemon in the foreground.
 *
 * Not `lumanin start`: that spawns the daemon detached and returns, which a
 * `Type=simple` unit reads as the service having exited — systemd then kills the
 * daemon with the rest of the cgroup. The unit gets the daemon binary itself.
 */
function daemonCommandLine(): string | null {
  const daemon = resolveDaemonCommand()
  if (daemon === null) return null
  // Paths with spaces would otherwise split into two arguments. systemd's own
  // quoting rules accept the shell-ish double-quoted form.
  const quote = (part: string): string => (/[\s"']/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part)
  return [daemon.command, ...daemon.args].map(quote).join(' ')
}

async function runUnfix(
  profile: Awaited<ReturnType<typeof probePlatform>>,
  dirs: FixDirs,
  assumeYes: boolean
): Promise<void> {
  const edits = planRevert(dirs)
  // GNOME's has no file to revert, so it is asked for the same way it was
  // planned: what is in dconf now, and what would undo it.
  const gnome = planGnomeBinds(profile, [])
  const commands = gnome.state === 'not-applicable' ? [] : gnome.undo

  if (edits.length === 0 && commands.length === 0) {
    process.stdout.write('Nothing installed by `doctor --fix` was found.\n')
    return
  }

  for (const edit of edits) process.stdout.write(`${indent(edit.diff)}\n\n`)
  for (const [command, ...args] of commands) {
    process.stdout.write(`  - ${command ?? ''} ${args.join(' ')}\n`)
  }
  if (!assumeYes && !(await confirm(`Remove ${String(edits.length + commands.length)} change(s)?`))) {
    process.stdout.write('Nothing was changed.\n')
    return
  }

  // Disabled *before* the file goes: `systemctl disable` reads the unit to find
  // what wanted it, and it cannot remove a symlink to a file that is no longer
  // there. Doing this in the other order leaves a dangling wants-link behind.
  if (edits.some((edit) => edit.path.endsWith(`${APP_ID}.service`))) {
    const ok = await run('systemctl', ['--user', 'disable', '--now', `${APP_ID}.service`])
    process.stdout.write(`  ${ok ? '\u2714' : '\u2718'} systemctl --user disable ${APP_ID}.service\n`)
  }

  report(applyPlan(edits, stamp()))
  if (commands.length > 0) report(await runCommands(commands, run))
}

function report(results: readonly { path: string; ok: boolean; detail: string }[]): void {
  for (const result of results) {
    process.stdout.write(`  ${result.ok ? '✔' : '✘'} ${result.path} - ${result.detail}\n`)
  }
}

const indent = (text: string): string =>
  text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')

/**
 * The hotkey to write a bind for, and whether the user actually chose it.
 *
 * An unparseable value falls back to the default rather than refusing to write
 * anything: `doctor` already reports the problem, and leaving someone with no
 * bind at all because they typed `Supr+K` would be the worse failure.
 */
function hotkeyChoice(config: ResolvedConfig): HotkeyChoice {
  const setting = config.general.hotkey
  const parsed = parseHotkey(setting.value)
  return {
    hotkey: parsed ?? DEFAULT_HOTKEY,
    explicit: parsed !== null && setting.layer !== 'default',
    fileSearch: fileSearchHotkey(config),
    extraBinds: extraBindsFrom(config)
  }
}

/**
 * `[file_search].hotkey`, or `null` for "do not bind one".
 *
 * An empty string is that answer written down, which is why the setting accepts
 * one; an unparseable value is a mistake and is reported by the resolver rather
 * than silently binding something else. Note what `null` costs here: this key is
 * the *only* way into file search, so turning it off is turning the feature off.
 */
export function fileSearchHotkey(config: ResolvedConfig): Hotkey | null {
  const value = config.fileSearch.hotkey.value.trim()
  return value.length === 0 ? null : parseHotkey(value)
}

/**
 * `[[hotkeys]]` entries as bind lines. An unparseable bind is skipped — the
 * config resolver already reported it — rather than blocking every other bind.
 */
export function extraBindsFrom(config: ResolvedConfig): readonly ExtraBind[] {
  return config.hotkeys.value.flatMap((binding) => {
    const hotkey = parseHotkey(binding.bind)
    return hotkey === null ? [] : [{ hotkey, target: binding.target, title: binding.title }]
  })
}

/** Backups and temp files are stamped so two runs cannot collide. */
const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

/**
 * Ask before touching anything. A non-interactive stdin (a pipe, a systemd unit)
 * is a "no", never an implied yes — `--yes` is how a script says yes, and it has
 * to be said out loud.
 */
function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stdout.write(`${question} - stdin is not a terminal; pass --yes to apply.\n`)
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    process.stdout.write(`${question} [y/N] `)
    process.stdin.setEncoding('utf8')
    process.stdin.once('data', (chunk: string) => {
      process.stdin.pause()
      resolve(chunk.trim().toLowerCase().startsWith('y'))
    })
    process.stdin.resume()
  })
}

