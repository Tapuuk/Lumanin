#!/usr/bin/env bash
#
# Build a throwaway profile with a set of plugins installed into it, for
# `scripts/verify-plugins.mjs` to drive.
#
#   scripts/install-plugins.sh <profile-root> <plugins-dir> <name> [name...]
#
# Keep <profile-root> SHORT (e.g. under /tmp): unix sockets cap their path at
# ~108 bytes, and both lumanin's own socket and the session-bus symlink the
# verify harness makes live under <profile-root>/run.
#
# `<plugins-dir>` is any directory of plugin directories. Each name goes through
# the *real* install path — `lumanin plugin-install --deps` — because verifying a
# bundle built some other way would verify a bundle nobody installs.
set -u

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <profile-root> <plugins-dir> <name> [name...]" >&2
  exit 2
fi

ROOT=$1
SRC=$2
shift 2

REPO=$(cd "$(dirname "$0")/.." && pwd)

# Resolved *before* the XDG overrides below, and used absolutely thereafter.
# `node` is frequently a version-manager shim (mise, asdf, volta) that resolves
# the real binary through XDG_DATA_HOME — so overriding XDG_DATA_HOME and then
# calling `node` breaks node itself. That failure is silent and total: every
# install "succeeds" having run nothing.
NODE=$(node -e 'process.stdout.write(process.execPath)')
NODE_BIN=$(dirname "$NODE")

mkdir -p "$ROOT"/{config,data,cache,state,run}
chmod 700 "$ROOT/run"

# `npm` is spawned by the build for `--deps`, and is a shim for the same reason.
export PATH="$NODE_BIN:$PATH"
export XDG_CONFIG_HOME="$ROOT/config"
export XDG_DATA_HOME="$ROOT/data"
export XDG_CACHE_HOME="$ROOT/cache"
export XDG_STATE_HOME="$ROOT/state"
export XDG_RUNTIME_DIR="$ROOT/run"

cd "$REPO"

failed=0
for name in "$@"; do
  printf '\n=== %s\n' "$name"
  if output=$(timeout 600 "$NODE" out/main/cli.js plugin-install "$SRC/$name" --deps --yes 2>&1); then
    printf '%s\n' "$output" | tail -3
  else
    failed=$((failed + 1))
    printf '%s\n' "$output" | tail -6
    printf 'FAILED %s\n' "$name"
  fi
done

printf '\n%s installed, %s failed\n' "$(($# - failed))" "$failed"
