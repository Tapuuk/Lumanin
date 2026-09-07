#!/usr/bin/env bash
#
# Install the Lumanin plugin-generator skill into YOUR Claude Code - nothing else.
#
#   curl -fsSL https://raw.githubusercontent.com/Tapuuk/Lumanin/main/scripts/install-skill.sh | bash
#
# or, from a clone:
#
#   ./scripts/install-skill.sh
#
# Why this exists: the skill lives in the repository at .claude/skills/lumanin-plugin/,
# which Claude Code only discovers when you run it *inside this repository*. Installing
# the launcher does not touch your Claude setup. This script copies the skill into your
# personal skills directory (~/.claude/skills by default) so `claude` finds it in any
# project - say "make me a Lumanin plugin for X" and it takes over.
#
# It copies three things and nothing more: SKILL.md, reference.md, example/.
# No root, no config edits. Uninstall: rm -rf ~/.claude/skills/lumanin-plugin
# Update: run it again.

set -euo pipefail

REPO="${LUMANIN_REPO:-https://github.com/Tapuuk/Lumanin.git}"
BRANCH="${LUMANIN_BRANCH:-main}"
SKILL_NAME="lumanin-plugin"
SKILLS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"

say() { printf '\033[36m::\033[0m %s\n' "$1"; }
die() { printf '\033[31m!!\033[0m %s\n' "$1" >&2; exit 1; }

# Find the skill: the clone this script lives in, the launcher's own source
# checkout if install.sh made one, or a throwaway shallow clone as a last resort.
src=""
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || true)"
app_src="${LUMANIN_SRC:-${XDG_DATA_HOME:-$HOME/.local/share}/lumanin/src}"
tmp=""
if [ -n "$here" ] && [ -f "$here/.claude/skills/$SKILL_NAME/SKILL.md" ]; then
  src="$here/.claude/skills/$SKILL_NAME"
  say "using the clone at $here"
elif [ -f "$app_src/.claude/skills/$SKILL_NAME/SKILL.md" ]; then
  src="$app_src/.claude/skills/$SKILL_NAME"
  say "using the launcher source at $app_src"
else
  command -v git >/dev/null || die "git is required"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  say "fetching the skill from $REPO"
  git clone --quiet --depth 1 --branch "$BRANCH" --filter=blob:none --sparse "$REPO" "$tmp"
  git -C "$tmp" sparse-checkout set ".claude/skills/$SKILL_NAME"
  src="$tmp/.claude/skills/$SKILL_NAME"
  [ -f "$src/SKILL.md" ] || die "the skill was not found in the repository"
fi

target="$SKILLS_DIR/$SKILL_NAME"
verb="installed"
[ -d "$target" ] && verb="updated"
mkdir -p "$SKILLS_DIR"
rm -rf "$target"
cp -R "$src" "$target"
say "$verb $target"

cat <<'DONE'

Done. In any Claude Code session, ask for a plugin in plain words -

  "make me a Lumanin plugin that shows my docker containers"

- and the skill interviews you, writes it (zero dependencies and no network
access unless you say yes to more), installs it with `lumanin plugin-install`,
and verifies it renders in the real window.

To remove the skill: rm -rf ~/.claude/skills/lumanin-plugin
To update it later:  run this script again.
DONE
