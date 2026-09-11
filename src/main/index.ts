import { app } from 'electron'
import { APP_ID, SETTINGS_WINDOW_CLASS, WINDOW_CLASS } from '../shared/identity'

/**
 * The Electron entry: one binary, two applications.
 *
 * `--settings` runs the settings app — a completely separate application from
 * the launcher: its own window class, its own profile directories, its own
 * single-instance lock, no socket and no daemon involvement. Everything else
 * runs the daemon.
 */

// Two spellings for one mode: `--settings` (the packaged binary, tests) and
// the env the `settings-shell/` loader sets. The shell exists because of a
// hard platform fact: on Wayland, Electron 43 derives the xdg-shell app_id
// from the loaded app's *package name* — `app.setName`, `--class` and
// `--wayland-app-id` are all ignored for it (measured; see settings-shell/
// main.js). So in dev the settings app is launched *as* that shell package,
// and this flag alone cannot change the window class.
const settingsMode = process.argv.includes('--settings') || process.env['LUMANIN_SETTINGS'] === '1'

// The name still matters off-Wayland: it is WM_CLASS on X11, and the `--class`
// switch works there. Set synchronously, before this script returns — Chromium
// snapshots the command line after the entry script finishes, so a switch
// appended from a dynamically imported module lands too late.
app.setName(settingsMode ? SETTINGS_WINDOW_CLASS : APP_ID)
app.commandLine.appendSwitch('class', settingsMode ? SETTINGS_WINDOW_CLASS : WINDOW_CLASS)

// Same timing rule for the backend hint. Without it Electron may pick X11
// under XWayland, which breaks app_id matching and every compositor rule.
if (process.env['WAYLAND_DISPLAY'] !== undefined || process.env['XDG_SESSION_TYPE'] === 'wayland') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
}

if (settingsMode) {
  void import('./settings-app')
} else {
  void import('./daemon')
}
