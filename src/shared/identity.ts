/**
 * The fixed identifier set. Never invent variants of these.
 *
 * These strings are matched literally by things outside this repository —
 * compositor window rules (`class:^(lumanin)$`), third-party Omarchy theme files
 * (`lumanin.toml`), systemd units, and user scripts talking to the socket.
 * Renaming any of them is a breaking change for other people's configs.
 *
 * Never inline these literals elsewhere; import from here.
 */

/** Binary / CLI name, and the value used for `.desktop` and app name. */
export const APP_ID = 'lumanin'

/** The config file's name, matched by the daemon's watcher on the config dir. */
export const CONFIG_BASENAME = 'config.toml'

/** Human-facing product name. Used in UI chrome only, never as an identifier. */
export const APP_DISPLAY_NAME = 'Lumanin'

/**
 * Window class. On X11 this is WM_CLASS; on Wayland it is the xdg-shell app_id.
 * Compositor rules match this exactly.
 */
export const WINDOW_CLASS = 'lumanin'

/** Socket basename inside `$XDG_RUNTIME_DIR`. */
export const SOCKET_BASENAME = 'lumanin.sock'

/**
 * The settings app's window class — and the proof it is a separate application.
 *
 * On Wayland every surface of a process shares one app_id, and the compositor
 * rules that float and pin the panel match `^(lumanin)$` exactly. Scoping those
 * rules to spare a second in-process window was tried and broke
 * the panel's `no_blur`; the settings app therefore runs as its own process
 * under this class, and the panel's rules are never touched. Fixed for the same
 * reason every identifier here is: users may write their own compositor rules
 * against it.
 */
export const SETTINGS_WINDOW_CLASS = 'lumanin-settings'

/**
 * The settings window's title, and the `Name=` of `lumanin-settings.desktop` —
 * the app grid, the window and the taskbar all say the same thing.
 */
export const SETTINGS_WINDOW_TITLE = `${APP_DISPLAY_NAME} Settings`

/** Basename of the per-theme file third-party theme authors are invited to ship. */
export const THEME_FILE_BASENAME = 'lumanin.toml'

/** Deep-link scheme, without the `://`. */
export const URL_SCHEME = 'lumanin'

/** Environment variable prefix for the config-precedence chain. */
export const ENV_PREFIX = 'LUMANIN_'

/** systemd user unit name. */
export const SYSTEMD_UNIT = 'lumanin.service'

/**
 * Custom scheme for serving application icons to the sandboxed renderer.
 *
 * Derived from `APP_ID` so it moves with the name, like every other identifier
 * here — but note it is *not* the deep-link scheme (`lumanin://`), which is a
 * public contract with other applications. This one is internal.
 */
export const ICON_SCHEME = `${APP_ID}-icon`

/**
 * The `@raycast/api` version we implement, reported as `environment.raycastVersion`.
 *
 * Extensions do compare against it — usually to decide whether an API exists —
 * so it has to be the version whose *shape* we reproduce, which is the one
 * pinned in `spec/`. Reporting our own
 * version number here would answer a question nobody asked.
 */
export const RAYCAST_API_VERSION = '1.104.24'
/** Where the code lives, and where a bug goes. Both settings front doors link the second. */
export const REPOSITORY_URL = 'https://github.com/Tapuuk/Lumanin'
export const ISSUES_URL = `${REPOSITORY_URL}/issues`
