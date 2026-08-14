import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { APP_ID, CONFIG_BASENAME, SOCKET_BASENAME } from '../shared/identity'

/**
 * XDG path resolution. `docs/CONFIG.md` is the contract; never hardcode `~/.config`.
 *
 * Everything is derived from an injected environment so tests can drive the whole
 * matrix (unset vars, relative vars, missing runtime dir) without touching the
 * real process environment.
 */

export interface PathsEnv {
  readonly [key: string]: string | undefined
}

export interface LumaninPaths {
  /**
   * `$XDG_CONFIG_HOME` itself, *not* our subdirectory of it.
   *
   * `doctor --fix` writes into other applications' config — `hypr/hyprland.conf`,
   * `autostart/lumanin.desktop` — so it needs the root. Handing it `config` put
   * a `hypr/` tree inside `~/.config/lumanin/` where no compositor would ever
   * read it.
   */
  readonly configHome: string
  /** `$XDG_DATA_HOME` itself. GTK theme lookup searches `<dataHome>/themes/`. */
  readonly dataHome: string
  /** `$HOME`, resolved the same way every other path here is. */
  readonly home: string
  /** User-authored, portable: `config.toml`, `themes/`. */
  readonly config: string
  /** Installed extensions and derived databases. Losing this loses data. */
  readonly data: string
  /** Safe to delete at any time; deleting it may only make the next launch slower. */
  readonly cache: string
  /** Logs, token fallback, last-used-theme. */
  readonly state: string
  /** Per-boot, user-private. Holds the control socket. */
  readonly runtime: string
  readonly configFile: string
  readonly socket: string
  readonly logDir: string
  readonly extensionsDir: string
}

/**
 * The XDG spec requires absolute paths and says relative ones must be ignored as
 * if unset. Honouring that matters: a stray `XDG_DATA_HOME=.` otherwise scatters
 * databases into whatever directory the daemon happened to start in.
 */
function xdgDir(env: PathsEnv, variable: string, fallback: string): string {
  const value = env[variable]
  if (value !== undefined && value.length > 0 && isAbsolute(value)) return value
  return fallback
}

/**
 * `$XDG_RUNTIME_DIR` is normally set by pam_systemd, but it is absent in bare
 * `ssh` sessions, some containers, and minimal display managers. Falling back to
 * a world-writable `/tmp` path unconditionally would be a security downgrade, so
 * the fallback is uid-scoped and the caller is expected to create it 0700.
 */
export function resolveRuntimeDir(env: PathsEnv, uid: number): string {
  const explicit = env['XDG_RUNTIME_DIR']
  if (explicit !== undefined && explicit.length > 0 && isAbsolute(explicit)) return explicit
  return join(tmpdir(), `${APP_ID}-${String(uid)}`)
}

export function resolvePaths(env: PathsEnv = process.env, uid: number = process.getuid?.() ?? 0): LumaninPaths {
  const home = env['HOME'] ?? homedir()

  const configHome = xdgDir(env, 'XDG_CONFIG_HOME', join(home, '.config'))
  const config = join(configHome, APP_ID)
  const dataHome = xdgDir(env, 'XDG_DATA_HOME', join(home, '.local', 'share'))
  const data = join(dataHome, APP_ID)
  const cache = join(xdgDir(env, 'XDG_CACHE_HOME', join(home, '.cache')), APP_ID)
  const state = join(xdgDir(env, 'XDG_STATE_HOME', join(home, '.local', 'state')), APP_ID)
  const runtime = resolveRuntimeDir(env, uid)

  return {
    configHome,
    dataHome,
    home,
    config,
    data,
    cache,
    state,
    runtime,
    configFile: join(config, CONFIG_BASENAME),
    socket: join(runtime, SOCKET_BASENAME),
    logDir: join(state, 'logs'),
    extensionsDir: join(data, 'extensions')
  }
}

/**
 * Where the plugins that ship inside the application live.
 *
 * Not part of `LumaninPaths`: this is not an XDG directory and does not depend
 * on the environment — it is wherever this build put itself. Both the daemon and
 * the CLI need it, and both find it the same way, from the directory their own
 * bundle was loaded out of.
 *
 * `resources/plugins` first, because that is where a packaged build puts them —
 * outside the asar, since a worker `require`s a command's entry and reads the
 * extension's assets as ordinary files.
 *
 * Then **upwards from the calling module**, rather than exactly one level up.
 * The obvious `join(moduleDir, '..', 'plugins')` is right for `out/main/index.js`
 * and wrong for everything else: rollup splits shared code into
 * `out/main/chunks/`, so the same expression evaluated from the CLI's half
 * answered `out/main/plugins` — a directory that has never existed. The daemon
 * found the bundled plugins and every CLI screen did not, which is precisely the
 * disagreement `scanAllExtensions` exists to prevent. What is actually true is
 * that `plugins/` sits beside the built bundles; how deep the caller happens to
 * be is a fact about the bundler.
 */
export function bundledPluginsDir(moduleDir: string, resourcesPath?: string): string {
  if (resourcesPath !== undefined && resourcesPath.length > 0) {
    const packaged = join(resourcesPath, 'plugins')
    if (existsSync(packaged)) return packaged
  }

  // Two levels, deliberately: `out/main` and `out/main/chunks` are the only
  // places a bundle of ours is loaded from, and a third would reach the repo's
  // own `plugins/` — the *source*, with `src/` and no built `commands/`. Finding
  // that would turn "this build has no bundled plugins" into one "reinstall the
  // extension" problem per command, which is a worse answer than none.
  let at = moduleDir
  for (let up = 0; up < 2; up += 1) {
    at = join(at, '..')
    const candidate = join(at, 'plugins')
    if (existsSync(candidate)) return candidate
  }
  // Nothing found: this build ships no plugins, or has not been built yet.
  // Returning the sibling of the caller keeps the answer a real path, which is
  // what a scan of a missing directory expects.
  return join(moduleDir, '..', 'plugins')
}
