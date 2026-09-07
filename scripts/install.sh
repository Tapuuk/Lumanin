#!/usr/bin/env bash
#
# Build Lumanin from source and put `lumanin` on your PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/Tapuuk/Lumanin/main/scripts/install.sh | bash
#
# or, from a clone:
#
#   ./Lumanin/scripts/install.sh
#
# Everything it does is reversible and stays inside your home directory - no
# sudo, nothing under /usr:
#   • clones (or updates) the repo under ~/.local/share/lumanin/src
#   • installs dependencies, downloads the Electron binary (~220 MB, once, into
#     node_modules/electron - nothing system-wide) and builds
#   • symlinks ~/.local/bin/lumanin at it
#
# It deliberately stops there. Compositor rules, the keybind and the autostart
# entry are `lumanin doctor --fix`, which shows you the exact diff of every file
# it would touch and asks first - an installer that edits your window manager
# config unasked is not one you should be piping into bash.
#
# Distro packages (AUR, AppImage, .deb, .rpm) come later; until then this is
# the supported path.

set -euo pipefail

REPO="${LUMANIN_REPO:-https://github.com/Tapuuk/Lumanin.git}"
BRANCH="${LUMANIN_BRANCH:-main}"
SRC="${LUMANIN_SRC:-${XDG_DATA_HOME:-$HOME/.local/share}/lumanin/src}"
BIN_DIR="${LUMANIN_BIN_DIR:-$HOME/.local/bin}"

say() { printf '\033[36m::\033[0m %s\n' "$1"; }
die() { printf '\033[31m!!\033[0m %s\n' "$1" >&2; exit 1; }

command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "node is required (22.12 or newer)"
command -v npm >/dev/null || die "npm is required"

node_ok="$(node -p 'const [a,b]=process.versions.node.split(".").map(Number); a>22||(a===22&&b>=12)')"
[ "$node_ok" = "true" ] || die "node $(node -v) is too old; 22.12 or newer is required"

# Run from a clone if that is where this script lives, rather than cloning a
# second copy of the tree the user is already standing in.
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/package.json" ] && grep -q '"name": "lumanin"' "$here/package.json"; then
  SRC="$here"
  say "building the clone at $SRC"
elif [ -d "$SRC/.git" ]; then
  say "updating $SRC"
  git -C "$SRC" fetch --depth 1 origin "$BRANCH"
  git -C "$SRC" reset --hard "origin/$BRANCH"
else
  say "cloning into $SRC"
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$SRC"
fi

# `npm ci` wipes node_modules, and the Electron binary lives inside it. On a
# re-run keep the binary already downloaded aside and put it back, so a second
# install neither downloads 220 MB again nor makes anyone wait to find out.
ELECTRON_DIR="$SRC/node_modules/electron"
ELECTRON_BIN="$ELECTRON_DIR/dist/electron"
KEPT=""
if [ -x "$ELECTRON_BIN" ] && [ -f "$ELECTRON_DIR/path.txt" ]; then
  KEPT="$SRC/.electron-kept"
  rm -rf "$KEPT" && mkdir -p "$KEPT"
  mv "$ELECTRON_DIR/dist" "$ELECTRON_DIR/path.txt" "$KEPT/"
fi

say "installing dependencies"
(cd "$SRC" && npm ci)

if [ -n "$KEPT" ]; then
  # Only if it is the version the tree now wants; a bumped Electron must be fetched.
  wanted="$(node -p "require('$ELECTRON_DIR/package.json').version" 2>/dev/null || true)"
  if [ -d "$ELECTRON_DIR" ] && [ "$(cat "$KEPT/dist/version" 2>/dev/null)" = "$wanted" ]; then
    mv "$KEPT/dist" "$KEPT/path.txt" "$ELECTRON_DIR/"
  fi
  rm -rf "$KEPT"
fi
# The plugin API's pinned type definitions are a separate npm tree under spec/;
# the build's type gate imports them, so a build without this step fails on
# the first `import type` in src/api-shim.
(cd "$SRC/spec" && npm ci)

# Electron 43+ no longer downloads its binary during `npm ci`; it fetches on the
# first `require('electron')`, which nothing in the launcher does - the daemon
# is spawned by path. Without this step there is no binary, no daemon, and a
# `lumanin` that reports "none could be started" for no visible reason.
# A tree copied over from another machine carries that machine's Electron, so
# "present" is not enough: the binary has to run here (a foreign architecture
# fails with "Exec format error", which systemd then retries forever).
if [ -x "$ELECTRON_BIN" ] && ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" -e 0 >/dev/null 2>&1; then
  say "Electron binary already present, skipping the download"
else
  if [ -x "$ELECTRON_BIN" ]; then
    say "Electron binary present but does not run on this machine ($(uname -m)); replacing it"
    rm -rf "$SRC/node_modules/electron/dist"
  fi
  say "downloading the Electron binary (about 220 MB, once)"
  (cd "$SRC" && node node_modules/electron/install.js) || die "the Electron download failed; check your network and re-run"
  [ -x "$ELECTRON_BIN" ] || die "Electron binary missing at $ELECTRON_BIN after the download"
fi

say "building"
(cd "$SRC" && npm run build)

mkdir -p "$BIN_DIR"
# bin/lumanin, not bin/lumanin.js: the shell shim finds a Node runtime itself
# (PATH, then the Electron the build already installed). The `#!/usr/bin/env
# node` script fails silently from a .desktop entry or a compositor bind on any
# machine where node comes from a version manager, because those only put node
# on the PATH of interactive shells.
ln -sfn "$SRC/bin/lumanin" "$BIN_DIR/lumanin"
say "linked $BIN_DIR/lumanin"
"$BIN_DIR/lumanin" --version >/dev/null || die "$BIN_DIR/lumanin does not run; see the errors above"

# The icon, into the user's icon theme where every desktop looks for it by
# name. Scalable SVG is enough - hicolor scales it down for every size a shell
# asks for.
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
mkdir -p "$ICON_DIR"
cp "$SRC/resources/lumanin.svg" "$ICON_DIR/lumanin.svg"
say "installed $ICON_DIR/lumanin.svg"
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t -f "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" 2>/dev/null || true

# The settings app in the app grid. Generated rather than shipped as a static
# file so Exec can be an absolute path - a GUI session does not always have
# ~/.local/bin on PATH, and a .desktop entry that silently does nothing when
# clicked is worse than none. Name must stay "Lumanin Settings": it is the
# window's title too, and the compositor rules tell the two windows apart by it.
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS_DIR"
cat > "$APPS_DIR/lumanin-settings.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Lumanin Settings
Comment=Configure the Lumanin launcher
Exec=$BIN_DIR/lumanin settings
Icon=lumanin
Terminal=false
Categories=Settings;Utility;
EOF
say "installed $APPS_DIR/lumanin-settings.desktop"
# Some app grids read the cache rather than the directory; refresh it where the
# tool exists, and do nothing where it does not.
command -v update-desktop-database >/dev/null && update-desktop-database -q "$APPS_DIR" 2>/dev/null || true

# `lumanin update` re-runs this script to rebuild in place. It has already
# been through the PATH advice and the epilogue once; a second copy of both
# would bury the one line that matters ("updated to ...").
if [ "${LUMANIN_UPDATE:-}" = "1" ]; then
  say "rebuilt in place"
  exit 0
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\033[33m!!\033[0m %s is not on your PATH, so `lumanin` will not be found until it is.\n' "$BIN_DIR"
    case "$(basename "${SHELL:-sh}")" in
      fish) printf '   fish:  fish_add_path %s\n' "$BIN_DIR" ;;
      zsh)  printf '   zsh:   echo '"'"'export PATH="%s:$PATH"'"'"' >> ~/.zshrc && exec zsh\n' "$BIN_DIR" ;;
      *)    printf '   bash:  echo '"'"'export PATH="%s:$PATH"'"'"' >> ~/.bashrc && exec bash\n' "$BIN_DIR" ;;
    esac
    printf '   The settings entry in your app grid uses the full path and works either way.\n'
    ;;
esac

# Setting up the desktop integration is the difference between a launcher that
# is instant and one that cold-starts Electron on the first press of the hotkey.
# It is still not done behind your back: `--fix` prints every diff and asks per
# run. So this offers, and only when there is somebody there to answer - a
# `curl | bash` has no terminal on stdin, and a prompt nobody can answer must
# never become an implied yes.
if [ -t 0 ] && [ -t 1 ]; then
  printf '\n'
  say "set up the compositor rules, hotkey and autostart now? It shows every diff first."
  printf '   [Y/n] '
  read -r answer
  case "$answer" in
    [Nn]*) ;;
    *) "$BIN_DIR/lumanin" doctor --fix || true ;;
  esac
fi

cat <<'DONE'

Installed. Next:

  lumanin doctor          what your desktop supports, and which backend won
  lumanin doctor --fix    write the compositor rules, the hotkey bind, a systemd
                          user unit and the autostart entry - every diff shown
                          before anything is touched
  lumanin config          every setting, in a menu
  lumanin                 open the panel

Until autostart is set up, the first press after login pays a cold start; after
it, the daemon is already running and the panel is instant.

Optional, and deliberately not done here: if you use Claude Code and want it to
write Lumanin plugins for you from any project, install the generator skill into
your personal Claude setup with scripts/install-skill.sh (same repo, same
curl-able form). This installer never touches ~/.claude.

To uninstall: `lumanin doctor --unfix`, then remove the symlink, the
lumanin-settings.desktop entry under ~/.local/share/applications, the icon at
~/.local/share/icons/hicolor/scalable/apps/lumanin.svg, and the source
directory. Your configuration lives in $XDG_CONFIG_HOME/lumanin and is
left alone either way.
DONE
