#!/bin/sh
# Runs as root after the .deb/.rpm is unpacked.
set -e
# Chromium's SUID sandbox helper. Without the setuid bit Electron refuses to
# start on distros that lock down unprivileged user namespaces (Ubuntu 24.04
# does through AppArmor), and the failure is a wall of text, not a launcher.
chmod 4755 /usr/lib/lumanin/electron/chrome-sandbox 2>/dev/null || true
command -v update-desktop-database >/dev/null && update-desktop-database -q /usr/share/applications 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
cat <<'MSG'
Lumanin is installed. As your user, `lumanin doctor --fix` writes the hotkey,
the compositor rule and autostart (every diff is shown first), or open
"Lumanin Settings" from the app grid. A daemon left running from a previous
version restarts itself on the next press of the hotkey.
MSG
