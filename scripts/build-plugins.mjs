/**
 * Build the plugins that ship inside the application.
 *
 *     node scripts/build-plugins.mjs [outDir]
 *
 * Every directory under `plugins/` is built into `<outDir>/<name>/` — default
 * `out/plugins` — with the *same* code path `lumanin plugin-install` uses on a
 * user's machine. Not a similar one: `buildExtension` is imported and called.
 *
 * That matters more than it looks. The externals list is half of the
 * single-React rule, the manifest parser is what decides
 * which commands exist, and a bundled plugin built by a second, simpler script
 * would be the one plugin in the world that was never built the way plugins are
 * built — so it would be the one that breaks when either changes.
 *
 * Run from `npm run build`. `out/main` must already exist, which it does: this
 * runs after electron-vite, and `buildExtension` is loaded from the built
 * bundle rather than from TypeScript source so there is no second toolchain
 * here either.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const repoRoot = resolve(import.meta.dirname, '..')
const source = join(repoRoot, 'plugins')
const outDir = resolve(process.argv[2] ?? join(repoRoot, 'out', 'plugins'))

if (!existsSync(source)) {
  process.stdout.write('no plugins/ directory — nothing to bundle\n')
  process.exit(0)
}

const require = createRequire(import.meta.url)
const { buildExtension } = require(join(repoRoot, 'out', 'main', 'plugin-build.js'))

if (typeof buildExtension !== 'function') {
  process.stderr.write(
    'out/main/plugin-build.js does not export buildExtension — run `npm run build` first\n'
  )
  process.exit(1)
}

let failed = false
for (const name of readdirSync(source).sort()) {
  const directory = join(source, name)
  if (!statSync(directory).isDirectory()) continue

  const destination = join(outDir, name)
  // A stale command left over from a rename would still be indexed and still
  // appear at the root, so the destination is replaced rather than written into.
  rmSync(destination, { recursive: true, force: true })

  const result = await buildExtension({
    source: directory,
    destination,
    production: true,
    // Bundled plugins depend on nothing outside the API by policy, so there is
    // never an install to run — and a build step that can reach the network is
    // a build step that can fail offline.
    installDependencies: false
  })

  for (const failure of result.failures) {
    process.stderr.write(`  ✘ ${name}/${failure.command} — ${failure.reason}\n`)
    failed = true
  }
  process.stdout.write(`  ${name} — ${result.built.join(', ') || 'nothing built'}\n`)
  if (result.built.length === 0) failed = true
}

process.exit(failed ? 1 : 0)
