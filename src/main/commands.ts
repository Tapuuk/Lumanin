import type { LaunchOutcome } from '../shared/ipc'
import type { RootCommand } from './root-search'
import { ensureConfigFile } from '../node/config-file'

/**
 * The root command list: the launcher's own commands, searchable alongside
 * applications.
 *
 * This is deliberately short, and every entry does something today. A root list
 * padded with commands that open a settings pane nobody has written yet would
 * look like more progress and be worth less than nothing — the whole value of a
 * command palette is that what it lists, it does.
 *
 * Ids follow the config's `builtin/<name>` form so `[aliases]` can name them.
 */

export interface CommandHandlers {
  reloadApplications(): void
  reloadTheme(): void
  /** Re-scans `$XDG_DATA_HOME/lumanin/extensions/`. */
  reloadExtensions(): void
  /** Re-reads `config.toml`; returns settings that changed but need a restart. */
  reloadConfig(): readonly string[]
  /** Opens a path with the desktop's default handler. */
  openPath(path: string): Promise<string>
  /** Starts the settings app; false when no executable could be found. */
  openSettings(): boolean
  quit(): void
  readonly configFile: string
  readonly logFile: string
}

export interface RegisteredCommand extends RootCommand {
  run(): Promise<LaunchOutcome>
}

export function rootCommands(handlers: CommandHandlers): readonly RegisteredCommand[] {
  const opened = async (path: string, what: string): Promise<LaunchOutcome> => {
    // Electron's `openPath` resolves to an empty string on success and to an
    // error *message* on failure, rather than rejecting — so this cannot be a
    // try/catch.
    const error = await handlers.openPath(path)
    return error === ''
      ? { ok: true, detail: `opened ${what}` }
      : { ok: false, detail: `could not open ${what}: ${error}` }
  }

  return [
    {
      id: 'builtin/reload-applications',
      title: 'Reload Applications',
      subtitle: 'Rebuild the application index now',
      // What someone types when an app they just installed has not appeared —
      // which is the only reason to reach for this.
      keywords: ['rescan', 'refresh', 'reindex', 'index', 'apps', 'missing'],
      run: () => {
        handlers.reloadApplications()
        return Promise.resolve({ ok: true, detail: 'rebuilding the application index' })
      }
    },
    {
      id: 'builtin/reload-config',
      title: 'Reload Configuration',
      subtitle: 'Re-read config.toml',
      // The file is watched, so this is the backstop rather than the mechanism —
      // it is here for the cases a watch cannot cover: a config directory on a
      // filesystem without inotify, or an inotify watch limit already spent.
      keywords: ['config', 'settings', 'reread', 'refresh', 'apply', 'toml'],
      run: () => {
        const pending = handlers.reloadConfig()
        return Promise.resolve(
          pending.length === 0
            ? { ok: true, detail: 'configuration reloaded' }
            : {
                ok: false,
                detail: `reloaded - ${pending.join(' and ')} still need a restart`
              }
        )
      }
    },
    {
      id: 'builtin/reload-theme',
      title: 'Reload Theme',
      subtitle: 'Re-run the theme resolution chain',
      keywords: ['colours', 'colors', 'appearance', 'refresh', 'omarchy'],
      run: () => {
        handlers.reloadTheme()
        return Promise.resolve({ ok: true, detail: 'reloading the theme' })
      }
    },
    {
      id: 'builtin/reload-extensions',
      title: 'Reload Extensions',
      subtitle: 'Re-scan installed extensions',
      // What someone types after `lumanin plugin-install` or after editing an
      // extension by hand — the moment a command they expect is not in the list.
      keywords: ['extensions', 'rescan', 'refresh', 'plugins', 'addons', 'missing'],
      run: () => {
        handlers.reloadExtensions()
        return Promise.resolve({ ok: true, detail: 're-scanning installed extensions' })
      }
    },
    {
      id: 'builtin/settings',
      title: 'Lumanin Settings',
      subtitle: 'Every setting, as a window',
      // The .desktop entry install.sh writes makes this reachable as an
      // application too — but a dev tree has no .desktop entry, and the
      // launcher's own settings should never depend on one being installed.
      keywords: ['settings', 'preferences', 'options', 'configure', 'config'],
      run: () => {
        return Promise.resolve(
          handlers.openSettings()
            ? { ok: true, detail: 'opening the settings app' }
            : { ok: false, detail: 'the settings app could not be started' }
        )
      }
    },
    {
      id: 'builtin/open-config',
      title: 'Open Configuration File',
      subtitle: 'config.toml',
      keywords: ['settings', 'preferences', 'toml', 'edit'],
      run: () => {
        // A fresh install has no file yet, and opening a path that is not
        // there answered an errno on exactly the machine most likely to press this.
        ensureConfigFile(handlers.configFile)
        return opened(handlers.configFile, 'config.toml')
      }
    },
    {
      id: 'builtin/open-log',
      title: 'Open Log File',
      subtitle: 'Diagnostics for a bug report',
      keywords: ['logs', 'debug', 'diagnostics', 'troubleshoot'],
      run: () => opened(handlers.logFile, 'the log file')
    },
    {
      id: 'builtin/quit',
      title: 'Quit Lumanin',
      subtitle: 'Stop the daemon; the hotkey will start it again',
      keywords: ['exit', 'close', 'stop', 'kill', 'restart'],
      run: () => {
        // Deferred so this reply reaches the renderer before the process goes.
        setTimeout(() => handlers.quit(), 0)
        return Promise.resolve({ ok: true, detail: 'shutting down' })
      }
    }
  ]
}
