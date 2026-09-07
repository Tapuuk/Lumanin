# Changelog

Versions follow semver. What the version number promises to plugin authors and to your
config is written in [CONTRIBUTING.md](CONTRIBUTING.md#what-stays-stable).

## 1.0.0 - unreleased

First release.

### The launcher

- Global search on `Super+R`: applications, plugins, pins, aliases, web searches and a
  calculator with units, temperatures and percentages, ranked by name match first and by
  how often you launch each thing.
- File search on `Super+Shift+R`, a surface of its own: `fd`, `plocate` or `find`, whichever
  is installed, browsing into folders, system icons, seven file-type categories.
- A long-lived daemon behind a single instance lock, so the window is shown, never started.
  Autostart is set up on first run.
- Theming from `lumanin.toml`, with live Omarchy theme following.
- Desktops: Hyprland (conf and Lua configs), sway, KDE (live D-Bus binds, no logout),
  GNOME (dconf) and COSMIC (RON shortcuts) all get the hotkey written for them. Everything
  else falls back to a working path; `lumanin doctor` reports what was chosen and why.

### Plugins

- `import { List, Action, useExec, ... } from 'lumanin'`: one module, TypeScript, React.
  `List`, `Detail`, `Form`, `ActionPanel`, toasts, HUDs, alerts, navigation,
  `LocalStorage`, `Cache`, preferences, `useExec`, `usePromise`, `useFetch`, `launchCommand`.
- `lumanin plugin-install <url|directory>` installs from any public https git repository,
  including a folder inside a bigger one, after a consent screen naming author, commands
  and dependencies. Provenance is recorded on disk.
- `lumanin plugin-export` hands back a publishable directory.
- Bundled plugins ship inside the app, can be disabled but not removed, and are replaced
  wholesale by a user plugin of the same name.
- Plugin internals reach the root as pins: a category, a row, or one action on a row.
  Item pins keep the row's own icon.
- An official plugin index, browsed from Settings and installed through the same consent
  screen as a pasted URL.
- A generator skill for Claude Code (`/lumanin-plugin`) that interviews, writes, installs
  and verifies a plugin against the real launcher.

### Settings

- A settings window (`lumanin settings`) and the same menus in the terminal
  (`lumanin config`), both writing `config.toml` with a backup and preserving keys they do
  not know.
- A three-step first-run wizard: hotkey, desktop integration, autostart. Every file it
  wants to touch is shown as a diff and asked about first.
- Plugin hotkeys (`[[hotkeys]]`) bound to a command, a category, a row or one action, with
  the bind state read back from the desktop rather than assumed.
- Panel keys (`[keys]`) rebindable; a one-character bind with no modifier only fires while
  the search box is empty.

### Install and operate

- Packages: `.deb`, `.rpm` and a `.tar.gz` for x86_64 and aarch64 on every release, and
  an AUR `PKGBUILD`. Each bundles its own Electron. After a package upgrade, the daemon
  still running the previous version restarts itself on the next press of the hotkey.

- `scripts/install.sh`: build from source into your home directory, no root.
  `scripts/uninstall.sh` reverses it and unwrites the desktop integration first.
- `lumanin update` pulls, rebuilds in place and restarts, with your say-so.
- `lumanin doctor --fix` and `--unfix` install and remove the compositor rule, keybind and
  autostart entry.
- No online services, no accounts, no telemetry. Plugin tokens are stored on this machine
  only, in files readable by your user alone.
