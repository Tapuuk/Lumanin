#!/bin/sh
# Runs as root before the .deb/.rpm files are removed. The keybind, the
# compositor rule and the autostart entry live in the *user's* config, which
# root must not touch; the user unwrites them with `lumanin doctor --unfix`.
# Said here because after this script there is no `lumanin` left to say it.
cat <<'MSG'
Lumanin's hotkey, compositor rule and autostart entry are in your user config
and are not removed by the package. If you have not already, run
`lumanin doctor --unfix` as your user - it names every line it would remove.
Your configuration under ~/.config/lumanin is left alone either way.
MSG
exit 0
