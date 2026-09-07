#!/usr/bin/env bash
#
# Build the distro packages: one staged tree, three wrappers around it.
#
#   scripts/package.sh                 # deb + rpm + tar.gz for this machine's architecture
#   scripts/package.sh deb             # just one format (deb | rpm | tar)
#   scripts/package.sh stage --dest D  # only stage the tree into D (what the PKGBUILD does)
#
# Options:
#   --dest DIR           where `stage` writes (default release/stage)
#   --out DIR            where packages land (default release/)
#   --electron-zip FILE  an already-downloaded electron-v<ver>-linux-<arch>.zip
#   --no-build           trust the existing out/ instead of running the build
#
# The staged tree is the same for every package:
#
#   usr/lib/lumanin/            package.json, out/, bin/, settings-shell/, and the
#                               runtime node_modules (npm ci --omit=dev)
#   usr/lib/lumanin/electron/   the unmodified Electron of the pinned version, for
#                               this architecture - the same one the dev tree runs
#   usr/bin/lumanin             a shell wrapper: the CLI on Electron's Node
#   usr/share/applications/lumanin-settings.desktop
#   usr/share/icons/hicolor/scalable/apps/lumanin.svg
#   usr/share/licenses/lumanin/LICENSE
#
# Why bundle Electron instead of depending on a distro's: Debian and Fedora
# have none, and Arch Linux ARM (an aarch64 target of ours) has none either.
# One layout that works everywhere beats a per-distro special case, and
# src/cli/client.ts resolves `<root>/electron/electron` before the dev tree's
# node_modules copy so the CLI, the daemon and the settings app all find it.
#
# Packages need `fpm` (deb, rpm) and, for rpm, `rpmbuild`; `stage` and `tar`
# need neither. Everything runs unprivileged.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\033[36m::\033[0m %s\n' "$1"; }
die() { printf '\033[31m!!\033[0m %s\n' "$1" >&2; exit 1; }

FORMATS=()
DEST=""
OUT="$ROOT/release"
ELECTRON_ZIP=""
BUILD=1
while [ $# -gt 0 ]; do
  case "$1" in
    stage|deb|rpm|tar) FORMATS+=("$1") ;;
    --dest) DEST="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    --electron-zip) ELECTRON_ZIP="$2"; shift ;;
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[ ${#FORMATS[@]} -gt 0 ] || FORMATS=(deb rpm tar)
[ -n "$DEST" ] || DEST="$OUT/stage"

command -v node >/dev/null || die "node is required"
command -v npm >/dev/null || die "npm is required"

VERSION="$(node -p "require('./package.json').version")"
ELECTRON_VERSION="$(node -p "require('./node_modules/electron/package.json').version" 2>/dev/null || true)"
[ -n "$ELECTRON_VERSION" ] || die "node_modules/electron is missing - run npm ci first"
NODE_ARCH="$(node -p process.arch)"          # x64 | arm64
case "$NODE_ARCH" in
  x64)   DEB_ARCH=amd64; RPM_ARCH=x86_64 ;;
  arm64) DEB_ARCH=arm64; RPM_ARCH=aarch64 ;;
  *) die "unsupported architecture: $NODE_ARCH" ;;
esac

# Checksums of the Electron zips we ship, by version and architecture. A
# version not listed here is downloaded and its sum printed, so bumping
# Electron means adding two lines - never shipping a binary nobody checked.
electron_sha256() {
  case "$1-$2" in
    43.3.0-x64)   echo f4987e9f045e46b117f0805d6ba4dc524e2abb2c2e33660f175bb39564bd3dae ;;
    43.3.0-arm64) echo 3e89a62c345d8171bf54f77df5b3d8216c492847eed00ae59cadd78d6f5535f7 ;;
    *) echo "" ;;
  esac
}

if [ "$BUILD" = 1 ]; then
  say "building (electron-vite + bundled plugins)"
  npm run --silent build:app
fi
[ -f out/main/cli.js ] || die "out/main/cli.js is missing - build first (or drop --no-build)"
[ -d out/plugins ] || die "out/plugins is missing - the bundled plugins did not build"

# ---- the Electron binary -----------------------------------------------------
# Prefer the zip (what the PKGBUILD hands over, what CI caches); otherwise the
# dev tree's own download when it is the pinned version for this architecture;
# otherwise fetch the zip and verify it.
fetch_electron_zip() {
  local zip="$OUT/cache/electron-v$ELECTRON_VERSION-linux-$NODE_ARCH.zip"
  local url="https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-linux-$NODE_ARCH.zip"
  mkdir -p "$(dirname "$zip")"
  if [ ! -f "$zip" ]; then
    say "downloading Electron $ELECTRON_VERSION for $NODE_ARCH"
    curl -fsSL "$url" -o "$zip.part" && mv "$zip.part" "$zip"
  fi
  local want have
  want="$(electron_sha256 "$ELECTRON_VERSION" "$NODE_ARCH")"
  have="$(sha256sum "$zip" | cut -d' ' -f1)"
  if [ -z "$want" ]; then
    printf '\033[33m!!\033[0m no recorded checksum for Electron %s %s; it is %s - add it to electron_sha256 in %s\n' \
      "$ELECTRON_VERSION" "$NODE_ARCH" "$have" "scripts/package.sh" >&2
  elif [ "$want" != "$have" ]; then
    die "Electron zip checksum mismatch: expected $want, got $have ($zip)"
  fi
  ELECTRON_ZIP="$zip"
}

install_electron() {
  local target="$1/usr/lib/lumanin/electron"
  rm -rf "$target"
  mkdir -p "$target"
  if [ -n "$ELECTRON_ZIP" ]; then
    command -v unzip >/dev/null || command -v bsdtar >/dev/null || die "unzip or bsdtar is required to unpack $ELECTRON_ZIP"
    if command -v unzip >/dev/null; then unzip -q "$ELECTRON_ZIP" -d "$target"; else bsdtar -xf "$ELECTRON_ZIP" -C "$target"; fi
  else
    local dist="$ROOT/node_modules/electron/dist"
    if [ -x "$dist/electron" ] && [ "$(cat "$dist/version" 2>/dev/null)" = "$ELECTRON_VERSION" ] \
       && ELECTRON_RUN_AS_NODE=1 "$dist/electron" -p process.arch 2>/dev/null | grep -qx "$NODE_ARCH"; then
      say "using the dev tree's Electron $ELECTRON_VERSION ($NODE_ARCH)"
      cp -a "$dist/." "$target/"
    else
      fetch_electron_zip
      install_electron "$1"
      return
    fi
  fi
  [ -x "$target/electron" ] || die "no electron binary at $target after unpacking"
  # The SUID bit is a package post-install job (needs root). Unzip leaves the
  # helper 755, which is right for a tarball too.
  chmod 755 "$target/chrome-sandbox" 2>/dev/null || true
}

# ---- the staged tree ---------------------------------------------------------
stage() {
  local dest="$1"
  local app="$dest/usr/lib/lumanin"
  say "staging into $dest"
  rm -rf "$dest"
  mkdir -p "$app" "$dest/usr/bin" "$dest/usr/share/applications" \
    "$dest/usr/share/icons/hicolor/scalable/apps" "$dest/usr/share/licenses/lumanin"

  cp package.json package-lock.json LICENSE "$app/"
  cp -R out bin settings-shell "$app/"
  # The runtime dependencies only. `--ignore-scripts` because nothing needs a
  # script: better-sqlite3 ships Node-API prebuilds inside its tarball, esbuild's
  # postinstall only re-checks its own binary, and Electron is a devDependency
  # that --omit=dev leaves out.
  say "installing runtime dependencies"
  (cd "$app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent)
  rm -f "$app/package-lock.json"
  [ -f "$app/node_modules/better-sqlite3/prebuilds/linux-$NODE_ARCH.node" ] \
    || die "better-sqlite3 has no prebuild for linux-$NODE_ARCH; the package would fail at first launch"
  [ -d "$app/node_modules/@esbuild/linux-$NODE_ARCH" ] \
    || die "esbuild has no binary for linux-$NODE_ARCH; plugin builds would fail"
  # The other platforms' prebuilds are dead weight in a Linux package.
  find "$app/node_modules/better-sqlite3/prebuilds" -type f ! -name "linux-$NODE_ARCH.node" -delete

  install_electron "$dest"

  install -m755 packaging/lumanin "$dest/usr/bin/lumanin"
  install -m644 packaging/lumanin-settings.desktop "$dest/usr/share/applications/"
  install -m644 resources/lumanin.svg "$dest/usr/share/icons/hicolor/scalable/apps/lumanin.svg"
  install -m644 LICENSE "$dest/usr/share/licenses/lumanin/LICENSE"

  # Proof the tree runs before anything is wrapped around it.
  local reported
  reported="$("$dest/usr/bin/lumanin" --version)" || die "the staged lumanin does not run"
  say "staged lumanin $reported ($NODE_ARCH, Electron $ELECTRON_VERSION)"
}

# ---- the packages ------------------------------------------------------------
DESCRIPTION="Keyboard-first launcher for Linux with a plugin API"
URL="https://github.com/Tapuuk/Lumanin"
MAINTAINER="Tapuuk <tapuuk@users.noreply.github.com>"

fpm_common() {
  echo -n "-s dir -n lumanin -v $VERSION --iteration 1 --license MIT --url $URL"
  echo -n " --maintainer '$MAINTAINER' --vendor Tapuuk --description '$DESCRIPTION'"
  echo -n " --after-install packaging/after-install.sh --before-remove packaging/before-remove.sh"
}

build_deb() {
  command -v fpm >/dev/null || die "fpm is required for .deb (gem install fpm)"
  local out="$OUT/lumanin_${VERSION}-1_${DEB_ARCH}.deb"
  rm -f "$out"
  # Ubuntu 24.04 renamed the 64-bit-time_t libraries; both spellings accepted.
  eval fpm "$(fpm_common)" -t deb -a "$DEB_ARCH" --category utils --deb-no-default-config-files \
    --depends "'libgtk-3-0 | libgtk-3-0t64'" --depends libnss3 --depends libxss1 --depends libnotify4 \
    --depends "'libasound2 | libasound2t64'" --depends libxkbcommon0 \
    --depends "'libatspi2.0-0 | libatspi2.0-0t64'" --depends libdrm2 --depends libgbm1 --depends xdg-utils \
    -p "$out" -C "$DEST" usr
  say "wrote $out"
}

build_rpm() {
  command -v fpm >/dev/null || die "fpm is required for .rpm (gem install fpm)"
  command -v rpmbuild >/dev/null || die "rpmbuild is required for .rpm (apt install rpm / dnf install rpm-build)"
  local out="$OUT/lumanin-${VERSION}-1.${RPM_ARCH}.rpm"
  rm -f "$out"
  eval fpm "$(fpm_common)" -t rpm -a "$RPM_ARCH" --rpm-os linux \
    --depends gtk3 --depends nss --depends libXScrnSaver --depends libnotify --depends alsa-lib \
    --depends libxkbcommon --depends at-spi2-core --depends libdrm --depends mesa-libgbm --depends xdg-utils \
    -p "$out" -C "$DEST" usr
  say "wrote $out"
}

build_tar() {
  local out="$OUT/lumanin-${VERSION}-linux-${NODE_ARCH}.tar.gz"
  rm -f "$out"
  tar -C "$DEST" -czf "$out" usr
  say "wrote $out"
}

mkdir -p "$OUT"
stage "$DEST"
for format in "${FORMATS[@]}"; do
  case "$format" in
    stage) ;;
    deb) build_deb ;;
    rpm) build_rpm ;;
    tar) build_tar ;;
  esac
done
