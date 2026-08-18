import { spawn } from 'node:child_process'
import type { BinaryMap } from '../probe/binaries'
import { parseExec, type DesktopEntry } from './desktop-entry'

/**
 * Launching an application.
 *
 * Three strategies, in priority order, and the order matters for a
 * reason that is invisible until it bites: `gio launch` and `gtk-launch` hand
 * the request to the desktop's own launcher, which means the app is started in a
 * **fresh scope**, gets startup notification, and — critically — does not become
 * a child of the daemon. Applications launched as our children inherit our
 * environment, our cgroup, and our death: quitting Lumanin would take the user's
 * editor with it.
 *
 * The `Exec` fallback exists because neither helper is guaranteed installed, and
 * it does the same job by hand: parse argv per the spec, spawn detached, and
 * unref so the child is adopted by init.
 */

export type LaunchMethod = 'gio' | 'gtk-launch' | 'exec'

export interface LaunchResult {
  readonly ok: boolean
  readonly method: LaunchMethod
  readonly detail: string
}

export interface LaunchDeps {
  readonly binaries: BinaryMap
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * Looks a command up on `$PATH`. Terminals are resolved on demand rather than
   * added to the startup probe: there are nine candidates, only one of which is
   * ever needed, and only for the small minority of entries with `Terminal=true`.
   */
  readonly resolveBinary: (name: string) => string | null
  /** Injectable for tests; defaults to a real detached spawn. */
  readonly spawnDetached?: (command: string, args: readonly string[], cwd?: string) => boolean
}

/**
 * Terminals to try for `Terminal=true` entries, in the order a Linux desktop is
 * likely to have them. `$TERMINAL` wins because a user who set it has already
 * answered this question.
 *
 * The exec flag is per-terminal and not guessable: most take `-e`, but
 * `gnome-terminal` wants `--`, and passing the wrong one silently opens an empty
 * terminal instead of running the command.
 */
const TERMINALS: readonly { readonly command: string; readonly flag: string }[] = [
  { command: 'alacritty', flag: '-e' },
  { command: 'ghostty', flag: '-e' },
  { command: 'kitty', flag: '-e' },
  { command: 'foot', flag: '-e' },
  { command: 'wezterm', flag: '-e' },
  { command: 'konsole', flag: '-e' },
  { command: 'gnome-terminal', flag: '--' },
  { command: 'xfce4-terminal', flag: '-e' },
  { command: 'xterm', flag: '-e' }
]

function defaultSpawn(command: string, args: readonly string[], cwd?: string): boolean {
  try {
    // detached + ignored stdio + unref: the application must outlive the daemon
    // and must not hold a pipe to it. Argv array, no shell.
    const child = spawn(command, [...args], {
      detached: true,
      stdio: 'ignore',
      ...(cwd === undefined ? {} : { cwd })
    })
    // **Required, not defensive.** A failed spawn — the overwhelmingly common
    // case being a `.desktop` file left behind by an uninstalled application —
    // reports ENOENT by emitting `error` on the next tick, and an `error` event
    // with no listener is rethrown by EventEmitter. There is no `try` around a
    // later tick, so this was a launcher that **exited** when you picked a stale
    // entry: the daemon died, the window vanished, and the next hotkey press
    // paid a cold start. The synchronous `catch` below only ever caught bad
    // arguments, which is not a thing that happens in practice.
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * Run a command line from the user's own config (`shell:` pins and aliases).
 *
 * This is the one place in the codebase that hands a string to a shell, and it
 * does so deliberately. "Type your own command" means the shell's vocabulary —
 * `&&`, `~`, `$EDITOR`, a pipe — and parsing an approximation of that ourselves
 * would be a worse answer than using the thing that already implements it. What
 * makes it safe is upstream: the caller checks the line against `config.toml`
 * first, so this can only ever run something the user wrote there.
 *
 * The line is passed as a **single argv element**, never concatenated into one,
 * which is the actual content of the no-shell-strings rule.
 *
 * `$SHELL` rather than `/bin/sh`, with `-c` and no `-l`: the user typed this at
 * a launcher, expecting their own shell's aliases and functions to be irrelevant
 * (a non-interactive shell reads neither) but their `$PATH` to be the one they
 * have. A login shell would re-read profile scripts on every launch for nothing.
 */
export function runShellCommand(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  spawnDetached: (command: string, args: readonly string[]) => boolean = defaultSpawn
): boolean {
  const shell = env['SHELL'] ?? '/bin/sh'
  return spawnDetached(shell, ['-c', command])
}

/**
 * Open a **file** with whatever the desktop associates with it.
 *
 * Separate from {@link launchEntry}, which starts an application, and separate
 * from Electron's `shell.openPath`, which is what this replaces — for a reason
 * worth writing down, because it looks like duplication until it bites.
 *
 * `shell.openPath` runs `xdg-open`. On a desktop `xdg-open` does not recognise
 * — which is every wlroots compositor, Hyprland included — it takes its generic
 * path, and that path decides the file's type with `xdg-mime query filetype`,
 * which asks **`file(1)`**: content sniffing, filename ignored. A modern
 * `.blend` is zstd-compressed, so `file` answers `application/zstd`, whose
 * handler on a GNOME-flavoured install is **the file manager**. Pressing Open on
 * a Blender scene opened Nautilus. Reported from a real session, and reproduced
 * exactly:
 *
 *     xdg-mime query filetype x.blend  →  application/zstd  →  org.gnome.Nautilus.desktop
 *     gio info -a standard::content-type x.blend  →  application/x-blender  →  blender.desktop
 *
 * `gio` weighs the filename glob the way every file manager does, which is why
 * double-clicking the same file in Nautilus has always worked. So it goes first
 * where it exists — it ships with glib2, so it is present on anything with GTK
 * anywhere on it — and `xdg-open` remains the fallback for everywhere else.
 *
 * The exit code is waited for, unlike everywhere else in this file: `gio open`
 * returns as soon as it has handed the file over, and its **failure** (no
 * handler at all) is the case the fallback exists for. Bounded, because a
 * launcher must not hang on a missing helper.
 */
export function openPath(
  target: string,
  deps: Pick<LaunchDeps, 'binaries'> & {
    /** Injectable for tests; resolves false when gio could not take it. */
    readonly runGio?: (gio: string, args: readonly string[]) => Promise<boolean>
  }
): Promise<boolean> {
  const gio = deps.binaries.gio
  if (gio === null) return Promise.resolve(false)
  return (deps.runGio ?? defaultRunGio)(gio, ['open', target])
}

/** How long `gio open` gets to say it could not. It answers in milliseconds. */
const GIO_OPEN_TIMEOUT_MS = 3000

function defaultRunGio(gio: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }

    try {
      // Detached and stdio-ignored for the same reason as everything else here:
      // the application it starts must outlive the daemon. `gio` itself is the
      // only child, and it exits immediately.
      const child = spawn(gio, [...args], { detached: true, stdio: 'ignore' })
      child.on('error', () => finish(false))
      child.on('exit', (code) => finish(code === 0))
      child.unref()
      setTimeout(() => finish(true), GIO_OPEN_TIMEOUT_MS).unref()
    } catch {
      finish(false)
    }
  })
}

export function launchEntry(entry: DesktopEntry, deps: LaunchDeps): LaunchResult {
  const spawnDetached = deps.spawnDetached ?? defaultSpawn

  // `gio launch` takes the desktop file itself, so the desktop's own launcher
  // resolves Exec, field codes, Terminal and Path — every rule we would
  // otherwise reimplement, applied exactly as the rest of the session applies it.
  if (deps.binaries.gio !== null) {
    if (spawnDetached('gio', ['launch', entry.path])) {
      return { ok: true, method: 'gio', detail: `gio launch ${entry.path}` }
    }
  }

  // gtk-launch takes the desktop-file ID, not a path, and requires the file to be
  // in a standard directory — which everything in the index is, by construction.
  if (deps.binaries['gtk-launch'] !== null) {
    const id = entry.id.replace(/\.desktop$/, '')
    if (spawnDetached('gtk-launch', [id])) {
      return { ok: true, method: 'gtk-launch', detail: `gtk-launch ${id}` }
    }
  }

  const argv = parseExec(entry.exec)
  const command = argv[0]
  if (command === undefined) {
    return { ok: false, method: 'exec', detail: 'the entry has no runnable Exec line' }
  }

  if (entry.terminal) {
    const terminal = pickTerminal(deps)
    if (terminal === null) {
      return {
        ok: false,
        method: 'exec',
        detail: 'this is a terminal application and no terminal emulator was found (set $TERMINAL)'
      }
    }
    const ok = spawnDetached(terminal.command, [terminal.flag, ...argv], entry.path_)
    return {
      ok,
      method: 'exec',
      detail: ok ? `${terminal.command} ${terminal.flag} ${command}` : `could not start ${terminal.command}`
    }
  }

  // Asked *before* spawning, because a detached spawn cannot answer it: the
  // failure arrives on a later tick, by which time we have already told the user
  // their application started. A `.desktop` file whose program has been
  // uninstalled is the ordinary case here — every distro leaves them behind —
  // and "firefox is not installed" is a usable answer where a window that never
  // appears is not. Only the bare-name case: a path is the spawn's own business.
  if (!command.includes('/') && deps.resolveBinary(command) === null) {
    return {
      ok: false,
      method: 'exec',
      detail: `${command} is not installed - this .desktop entry is stale`
    }
  }

  const ok = spawnDetached(command, argv.slice(1), entry.path_)
  return { ok, method: 'exec', detail: ok ? argv.join(' ') : `could not start ${command}` }
}

function pickTerminal(deps: LaunchDeps): { command: string; flag: string } | null {
  const preferred = deps.env['TERMINAL']
  if (preferred !== undefined && preferred.length > 0) {
    // A known terminal keeps its known flag; an unknown one gets `-e`, which is
    // the overwhelming majority convention.
    const known = TERMINALS.find((t) => preferred.endsWith(t.command))
    return { command: preferred, flag: known?.flag ?? '-e' }
  }

  for (const terminal of TERMINALS) {
    if (deps.resolveBinary(terminal.command) !== null) return terminal
  }
  return null
}
