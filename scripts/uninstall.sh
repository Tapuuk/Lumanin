#!/usr/bin/env bash
#
# Remove a Lumanin source install made by scripts/install.sh.
#
#   curl -fsSL https://raw.githubusercontent.com/Tapuuk/Lumanin/main/scripts/uninstall.sh | bash
#
# or, from the installed checkout:
#
#   ~/.local/share/lumanin/src/scripts/uninstall.sh
#
# Steps, in order:
#   1. `lumanin doctor --unfix` - unwrites the keybind, window rule and
#      autostart entry from your desktop's own config files. It shows every
#      diff and asks first; it is the same consent model as --fix.
#   2. stops the daemon
#   3. removes the ~/.local/bin/lumanin symlink, the icon and the settings
#      .desktop entry, and the source checkout
#
# Your config (~/.config/lumanin) and data (~/.local/share/lumanin, minus the
# checkout) stay unless you pass --purge. Plugins you installed and their
# stored preferences live there; a reinstall picks them back up.
#
# No sudo. Nothing under /usr is touched because nothing under /usr was written.

set -uo pipefail

SRC="${LUMANIN_SRC:-${XDG_DATA_HOME:-$HOME/.local/share}/lumanin/src}"
BIN_DIR="${LUMANIN_BIN_DIR:-$HOME/.local/bin}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/lumanin"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/lumanin"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/lumanin"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/lumanin"
ICON="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps/lumanin.svg"
DESKTOP="${XDG_DATA_HOME:-$HOME/.local/share}/applications/lumanin-settings.desktop"

PURGE=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help)
      sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[36m::\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$1" >&2; }

LUMANIN="$BIN_DIR/lumanin"
[ -x "$LUMANIN" ] || LUMANIN="$SRC/bin/lumanin"

# 1. Unwrite the desktop integration while the binary that knows how still
#    exists. Skipping this leaves a keybind pointing at a command that is gone.
if [ -x "$LUMANIN" ]; then
  say "removing the keybind, window rule and autostart entry (lumanin doctor --unfix)"
  if [ "$YES" = 1 ]; then
    "$LUMANIN" doctor --unfix --yes || warn "doctor --unfix did not finish; check the output above"
  elif [ -t 0 ] && [ -t 1 ]; then
    "$LUMANIN" doctor --unfix || warn "doctor --unfix did not finish; check the output above"
  else
    warn "no terminal to answer doctor --unfix on; run it yourself before removing the checkout, or re-run with --yes"
    exit 1
  fi
  # 2. Stop the daemon so the files below are not in use.
  "$LUMANIN" quit >/dev/null 2>&1 || true
else
  warn "no lumanin binary found; the desktop integration (keybind, autostart) may still point at it"
fi
pkill -f "$SRC/" 2>/dev/null || true

# 3. Our own files.
if [ -L "$BIN_DIR/lumanin" ] || [ -e "$BIN_DIR/lumanin" ]; then
  rm -f "$BIN_DIR/lumanin" && say "removed $BIN_DIR/lumanin"
fi
if [ -e "$ICON" ]; then
  rm -f "$ICON" && say "removed $ICON"
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t -f "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" 2>/dev/null || true
fi
if [ -e "$DESKTOP" ]; then
  rm -f "$DESKTOP" && say "removed $DESKTOP"
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$(dirname "$DESKTOP")" 2>/dev/null || true
fi
if [ -d "$SRC" ]; then
  rm -rf "$SRC" && say "removed the checkout at $SRC"
fi
rm -f "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/lumanin.sock" 2>/dev/null || true

if [ "$PURGE" = 1 ]; then
  for dir in "$DATA_DIR" "$CONFIG_DIR" "$STATE_DIR" "$CACHE_DIR"; do
    [ -d "$dir" ] && rm -rf "$dir" && say "removed $dir"
  done
else
  say "kept your config and data:"
  for dir in "$CONFIG_DIR" "$DATA_DIR" "$STATE_DIR"; do
    [ -d "$dir" ] && printf '   %s\n' "$dir"
  done
  printf '   Re-run with --purge to delete them too.\n'
fi

say "Lumanin is uninstalled"
