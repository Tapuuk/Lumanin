# Contributing to Lumanin

Thanks for looking under the hood. This page is how the project works day to day; the deeper why of each subsystem is written in the source files it belongs to.

## Building from source

You need `git`, Node 22.12 or newer, and `npm`.

```bash
git clone https://github.com/Tapuuk/Lumanin.git
cd Lumanin
npm ci
npm ci --prefix spec   # the pinned plugin-API type definitions - typechecking needs them
npm run build
```

Run it with `npm run dev` for a hot-reloading window, or start the built daemon with `node bin/lumanin.js`. `scripts/install.sh` is the same build wired into a systemd user service.

## Packages

`scripts/package.sh` builds the distro packages from a built tree: one staged layout (`usr/lib/lumanin` with the app, its runtime `node_modules` and an unmodified Electron beside it; `usr/bin/lumanin` a shell wrapper running the CLI on that Electron's Node), then `.deb` and `.rpm` through `fpm`, and a `.tar.gz` of the same tree. `packaging/aur/PKGBUILD` stages the same layout for Arch. Electron is bundled rather than taken from a distro package because Debian, Fedora and Arch Linux ARM have none; the zip's checksum is pinned in the script per version and architecture.

`.github/workflows/release.yml` runs it on an x86_64 and an aarch64 runner for every pushed `v*` tag, installs the `.deb` it built and starts the daemon from it, then attaches all six files to the tag's GitHub Release (created as a draft if it does not exist).

### Cutting a release

1. Set the version in all five places: `package.json`, `npm-package/package.json`, `packaging/aur/PKGBUILD` (`pkgver`), `packaging/aur/.SRCINFO` (`pkgver`), and the `CHANGELOG.md` heading, with its date. `npm test` proves they agree (`tests/version.test.ts`). Commit.
2. Tag `vX.Y.Z` and push the tag. The Release workflow builds and attaches the packages.
3. Read the draft release, paste the changelog entry into it, publish.
4. After the release, refresh `packaging/aur`: run `updpkgsums` (the tarball sum is per tag) and `makepkg --printsrcinfo > .SRCINFO`, and commit the two files. The AUR package itself comes later: the AUR is not registering accounts at the moment, so pushing to it is not part of a release. Until then the PKGBUILD is built locally with `makepkg`.

## Tests

Two suites, different jobs:

- `npm test` - Vitest. Fast, no window, runs on every save. Unit and logic tests, render-tree goldens, and the desktop-config writers asserted as text.
- `npm run test:e2e` - Playwright driving the real Electron window. Boots an actual daemon against a throwaway XDG profile, so it costs seconds and proves things a unit test cannot: that typing produces results, that Enter launches, that the panel behaves.

`npm run typecheck` gates both TypeScript projects. All three must pass before a change is done; CI runs exactly these.

## How the code is laid out

The `src/` tree is split by process and responsibility: `main/` is the Electron daemon (window, indexing, extension lifecycle), `renderer/` the React UI, `host/` the extension host and its per-command workers, `api-shim/` the plugin API implementation, `platform/` every OS integration behind swappable per-desktop backends, `shared/` code both sides may import, `cli/` the `lumanin` command. The source files carry unusually thorough comments - the *why* of each subsystem is written where the code is, so read the file header before changing a file.

## The platform rule

Every desktop backend is written against primary documentation (the compositor's source, the spec, the desktop's own config format) and asserted as text in unit tests. Whether the key then actually fires on that desktop is a question only a human at that desktop can answer - until someone has, the backend reports `UNVERIFIED` in `lumanin doctor`, and that honesty is a feature. If you run an unverified path on real hardware, saying so in an issue is a contribution.

## Conventions that will come up in review

- TypeScript strict; no `any` in `api-shim/` - its types come from the pinned spec verbatim.
- Platform backends implement their interface fully or throw `Unsupported` at probe time, never at call time.
- Processes are spawned with argv arrays, never shell strings.
- No em dashes in anything a person reads - UI strings, CLI output, docs. A plain `-` does the job.
- The renderer runs with context isolation on and node integration off; everything crosses the preload bridge.

## Plugins

If what you want to build is a feature *for* the launcher rather than a change *to* it, it is probably a plugin. Anyone can publish one as a public git repository; `lumanin plugin-install <url>` installs it. The generator skill in `.claude/skills/lumanin-plugin/` writes one interactively if you use Claude Code, and its `reference.md` documents the whole API surface.

## What stays stable

Three things outlive any one release, and each has a rule.

**The plugin API** (`import ... from 'lumanin'`). Its shape is the pinned type definitions in `spec/`, and `.claude/skills/lumanin-plugin/reference.md` documents what is built. From 1.0: an exported name that is built keeps its signature and behaviour within a major version. New exports and new optional props may land in a minor version. Removing or changing a built export is a major version, announced in `CHANGELOG.md` one minor version ahead with the replacement named. Exports that throw a "not supported" sentence are not part of the promise; they may start working in any release. Manifest fields under `lumanin` follow the same rule as exports.

**`config.toml`.** Keys a release does not recognise are preserved on write, never dropped. When a key moves, the new code reads both spellings and `lumanin doctor` reports the old one. A key is removed from the reader no sooner than one major version after it moved. `lumanin config` and the settings window keep a backup before every write.

**The SQLite files** under `~/.local/share/lumanin/`. Each schema is created with `CREATE TABLE IF NOT EXISTS` and grows by adding columns or tables, never by renaming or dropping in place. A change that cannot be additive is a new file with a one-time copy from the old one, and the old file is left where it was.

## License

MIT. The pinned `@raycast/api` type definitions in `spec/` keep their own attribution; it stays.
