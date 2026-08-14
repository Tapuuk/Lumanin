// The settings app's shell — the reason this directory exists is one line in
// its package.json: `"name": "lumanin-settings"`.
//
// On Wayland, Electron derives the xdg-shell app_id from the loaded app's
// package name and from nothing else — measured on Electron 43 against every
// documented alternative (`app.setName`, the `--class` switch, a
// `--wayland-app-id` switch): four probe windows, one name each way, and every
// one mapped under the package name. The panel's compositor rules match
// `class:^(lumanin)$` exactly, so the settings app must load under a different
// package — this one — to keep its window out of them.
//
// Everything real lives in the repository's build; this shell only marks the
// process as the settings app and hands over.
process.env.LUMANIN_SETTINGS = '1'
require('../out/main/index.js')
