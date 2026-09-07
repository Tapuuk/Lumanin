import { existsSync, readFileSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, join, resolve } from 'node:path'
import {
  FOREIGN_PLUGIN_MESSAGE,
  buildExtension,
  foreignManifest,
  thirdPartyDependencies
} from '../main/extensions/build'
import { MANIFEST_BASENAME } from '../main/extensions/registry'
import { resolvePaths } from '../node/paths'
import { parseManifest, type Manifest } from '../shared/extension'
import { APP_ID } from '../shared/identity'
import {
  fetchPlugin,
  PluginChoiceError,
  writeProvenance,
  type PluginCandidate,
  type PluginCheckout,
  type Provenance
} from '../store/plugin'
import type { PluginSource } from '../store/plugin-source'
import { parsePluginSource, PluginSourceError } from '../store/plugin-source'
import { request } from './client'

/**
 * `lumanin plugin-install <repository|directory>` — the one way to install.
 *
 * There used to be two: `ext install <dir>` for something local and this for
 * something remote. Two commands for one operation is a real cost in a CLI —
 * every message that mentions installing has to pick one, and the user has to
 * learn which. So this takes both, and the argument decides: an existing
 * directory is built from where it sits, anything else is a repository.
 *
 * Publishing needs nothing from us. A Raycast-shaped `package.json` and a `src/`
 * in a public repository, and the URL is the whole distribution mechanism — no
 * registry, no account, no review queue, no server for us to pay for or take
 * down.
 *
 * The consequence is that this is the highest-consequence command in the
 * product — a URL goes in and code that runs as the user comes out — so it is
 * also the most talkative. Before anything is built it prints who published it,
 * which commit is being installed, what the manifest says it is, whether it
 * pulls in third-party dependencies, and what "not sandboxed" actually means.
 * Then it asks.
 */

const USAGE = `Usage: ${APP_ID} plugin-install <repository|directory> [--yes] [--deps] [--all]

  From any public git repository over https:

    ${APP_ID} plugin-install owner/name
    ${APP_ID} plugin-install https://github.com/owner/name
    ${APP_ID} plugin-install https://github.com/owner/name/tree/main/plugins/thing

  The last form is the URL your browser shows while looking at a directory, so a
  repository holding several plugins works by pasting what you are looking at.
  A root URL still works when the plugin lives a folder down - it is found; a
  repository holding several is listed so you can pick one.

  Or from a directory you already have - one with a \`package.json\` and a \`src/\`:

    ${APP_ID} plugin-install ./my-plugin

  --yes    skip the confirmation (for scripts; you are still shown what it does)
  --deps   allow it to install npm dependencies, with scripts disabled
  --all    when a repository holds several plugins, install every one of them

Installing builds the plugin on this machine. Building runs none of its code;
running the plugin does - with the same access to your files, network and
session that you have.

While writing one, \`${APP_ID} ext dev <directory>\` rebuilds and reloads on every
save instead of reinstalling by hand.
`

export async function runPluginInstall(
  rest: readonly string[],
  flags: ReadonlySet<string>
): Promise<number> {
  const target = rest[0]
  if (target === undefined) {
    process.stderr.write(`${APP_ID}: plugin-install needs a repository or a directory\n\n${USAGE}`)
    return 2
  }

  const paths = resolvePaths()
  const out = process.stdout

  // A directory that exists wins over the `owner/name` shorthand. Least
  // surprising: someone standing in a directory that contains `foo/bar` and
  // typing it meant the one they can see.
  const local = localDirectory(target)

  let directory: string
  let provenance: Provenance | null = null

  if (local !== null) {
    out.write(`\nInstalling from ${local}\n`)
    directory = local
  } else {
    let source
    try {
      source = parsePluginSource(target)
    } catch (error) {
      process.stderr.write(
        `${APP_ID}: ${error instanceof PluginSourceError ? error.message : String(error)}\n`
      )
      return 2
    }

    out.write(`\nInstalling from ${source.label}`)
    if (source.ref !== null) out.write(` at ${source.ref}`)
    if (source.subdirectory !== null) out.write(`, directory ${source.subdirectory}`)
    out.write('\n\n')

    try {
      let checkout: PluginCheckout
      try {
        checkout = await fetchPlugin({
          source,
          cacheDir: paths.cache,
          onProgress: (message) => out.write(`  ${message}\n`)
        })
      } catch (error) {
        // Several plugins, none named: list them and ask — one, or all of
        // them. Guessing would install code the user did not choose, so on a
        // stdin nobody can answer the list itself is the whole reply, unless
        // --all said the answer in advance.
        if (!(error instanceof PluginChoiceError)) throw error
        if (flags.has('--all')) {
          return await installMany(source, error.candidates, paths, flags, out)
        }
        if (!process.stdin.isTTY) throw error
        out.write(`\n  ${source.label} holds ${String(error.candidates.length)} plugins:\n\n`)
        for (const [index, candidate] of error.candidates.entries()) {
          out.write(`    ${String(index + 1)}. ${candidate.subdirectory}  (${candidate.name})\n`)
        }
        const answer = await ask(
          `\n  Which one? [1-${String(error.candidates.length)}, a = all] `
        )
        if (/^a(ll)?$/i.test(answer)) {
          return await installMany(source, error.candidates, paths, flags, out)
        }
        const chosen = error.candidates[Number.parseInt(answer, 10) - 1]
        if (chosen === undefined) {
          out.write('Nothing was installed.\n')
          return 1
        }
        checkout = await fetchPlugin({
          source: { ...source, subdirectory: chosen.subdirectory },
          cacheDir: paths.cache,
          onProgress: (message) => out.write(`  ${message}\n`)
        })
      }
      directory = checkout.directory
      provenance = {
        label: source.label,
        remote: source.remote,
        ref: source.ref,
        subdirectory: checkout.subdirectory,
        commit: checkout.commit,
        installedAt: new Date().toISOString()
      }
    } catch (error) {
      process.stderr.write(`${APP_ID}: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  const manifestPath = join(directory, MANIFEST_BASENAME)
  if (!existsSync(manifestPath)) {
    process.stderr.write(
      `${APP_ID}: ${directory} has no package.json - is that a plugin directory?\n`
    )
    return 1
  }

  const { manifest, problems } = parseManifest(
    JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
  )
  if (manifest === null) {
    process.stderr.write(`${APP_ID}: that package.json cannot be used: ${problems.join('; ')}\n`)
    return 1
  }

  // Caught before the consent screen, not after it: a foreign plugin would
  // otherwise list its launcher's packages as things to fetch, get a yes, and
  // then fail the build anyway.
  if (foreignManifest(manifestPath)) {
    process.stderr.write(`${APP_ID}: ${FOREIGN_PLUGIN_MESSAGE}\n`)
    return 1
  }

  const destination = resolve(paths.extensionsDir, manifest.name)
  const dependencies = thirdPartyDependencies(manifestPath)

  describe(out, manifest, directory, provenance, dependencies, existsSync(destination))

  if (dependencies.length > 0 && !flags.has('--deps')) {
    out.write(
      `  It needs ${String(dependencies.length)} npm package(s), which are not installed by default.\n` +
        `  Re-run with --deps to fetch them (their install scripts stay disabled).\n\n`
    )
  }

  if (!flags.has('--yes') && !(await confirm('  Install it? [y/N] '))) {
    out.write('Nothing was installed.\n')
    return 1
  }

  try {
    const result = await buildExtension({
      source: directory,
      destination,
      production: true,
      installDependencies: flags.has('--deps'),
      onProgress: (message) => out.write(`  ${message}\n`)
    })

    if (provenance !== null) writeProvenance(destination, provenance)

    out.write(
      `\nInstalled ${result.manifest.title} - ${String(result.built.length)} command${
        result.built.length === 1 ? '' : 's'
      }: ${result.built.join(', ')}\n`
    )
    for (const failure of result.failures) {
      process.stderr.write(`  ${failure.command}: ${failure.reason}\n`)
    }
    out.write(`Remove it again with:  ${APP_ID} ext remove ${manifest.name}\n`)

    const reply = await request(paths.socket, { kind: 'reload' })
    if (reply !== null) out.write('Reloaded the running daemon.\n')

    return result.built.length > 0 ? 0 : 1
  } catch (error) {
    process.stderr.write(`${APP_ID}: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/**
 * Install every plugin a repository holds, behind one consent.
 *
 * Each candidate is fetched and described first — the same facts the single
 * install shows, per plugin — then one yes covers the batch. A candidate that
 * fails to prepare is reported and skipped rather than sinking the rest, and
 * one that needs npm packages follows the same rule as a single install: it
 * is skipped unless --deps was given.
 */
async function installMany(
  source: PluginSource,
  candidates: readonly PluginCandidate[],
  paths: ReturnType<typeof resolvePaths>,
  flags: ReadonlySet<string>,
  out: NodeJS.WriteStream
): Promise<number> {
  interface Prepared {
    readonly directory: string
    readonly destination: string
    readonly manifest: Manifest
    readonly provenance: Provenance
    readonly needsDeps: boolean
  }

  const prepared: Prepared[] = []
  for (const candidate of candidates) {
    try {
      const checkout = await fetchPlugin({
        source: { ...source, subdirectory: candidate.subdirectory },
        cacheDir: paths.cache
      })
      const manifestPath = join(checkout.directory, MANIFEST_BASENAME)
      const { manifest, problems } = parseManifest(
        JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
      )
      if (manifest === null) {
        out.write(`  ${candidate.subdirectory}: skipped - ${problems.join('; ')}\n`)
        continue
      }
      if (foreignManifest(manifestPath)) {
        out.write(`  ${candidate.subdirectory}: skipped - ${FOREIGN_PLUGIN_MESSAGE}\n`)
        continue
      }
      const destination = resolve(paths.extensionsDir, manifest.name)
      if (basename(destination) !== manifest.name) {
        out.write(`  ${candidate.subdirectory}: skipped - "${manifest.name}" is not a usable name\n`)
        continue
      }
      const dependencies = thirdPartyDependencies(manifestPath)
      describe(out, manifest, checkout.directory, null, dependencies, existsSync(destination))
      const needsDeps = dependencies.length > 0
      if (needsDeps && !flags.has('--deps')) {
        out.write(`  Skipped without --deps: it needs npm packages.\n`)
        continue
      }
      prepared.push({
        directory: checkout.directory,
        destination,
        manifest,
        needsDeps,
        provenance: {
          label: source.label,
          remote: source.remote,
          ref: source.ref,
          subdirectory: checkout.subdirectory,
          commit: checkout.commit,
          installedAt: new Date().toISOString()
        }
      })
    } catch (error) {
      out.write(
        `  ${candidate.subdirectory}: skipped - ${error instanceof Error ? error.message : String(error)}\n`
      )
    }
  }

  if (prepared.length === 0) {
    out.write('Nothing was installed.\n')
    return 1
  }

  if (
    !flags.has('--yes') &&
    !(await confirm(`  Install all ${String(prepared.length)}? [y/N] `))
  ) {
    out.write('Nothing was installed.\n')
    return 1
  }

  let installed = 0
  for (const plugin of prepared) {
    try {
      const result = await buildExtension({
        source: plugin.directory,
        destination: plugin.destination,
        production: true,
        installDependencies: plugin.needsDeps,
        onProgress: (message) => out.write(`  ${message}\n`)
      })
      if (result.built.length === 0) {
        for (const failure of result.failures) {
          process.stderr.write(`  ${plugin.manifest.name}/${failure.command}: ${failure.reason}\n`)
        }
        continue
      }
      writeProvenance(plugin.destination, plugin.provenance)
      installed += 1
      out.write(
        `Installed ${plugin.manifest.title} - ${String(result.built.length)} command${
          result.built.length === 1 ? '' : 's'
        }: ${result.built.join(', ')}\n`
      )
    } catch (error) {
      process.stderr.write(
        `  ${plugin.manifest.name}: ${error instanceof Error ? error.message : String(error)}\n`
      )
    }
  }

  if (installed > 0) {
    const reply = await request(paths.socket, { kind: 'reload' })
    if (reply !== null) out.write('Reloaded the running daemon.\n')
  }
  out.write(`\n${String(installed)} of ${String(candidates.length)} plugins installed.\n`)
  return installed > 0 ? 0 : 1
}

/** Everything the user needs in order to decide, before anything is built. */
function describe(
  out: NodeJS.WriteStream,
  manifest: Manifest,
  directory: string,
  provenance: Provenance | null,
  dependencies: readonly string[],
  replacing: boolean
): void {
  out.write(
    `\n  ${manifest.title}  (${manifest.name})\n` +
      `  ${manifest.description}\n` +
      `  by ${manifest.author}\n\n` +
      (provenance === null ? '' : `  commit    ${provenance.commit.slice(0, 12)}\n`) +
      `  commands  ${manifest.commands.map((command) => command.name).join(', ') || 'none'}\n` +
      `  packages  ${
        dependencies.length === 0
          ? 'none - it depends on nothing outside Lumanin'
          : `${String(dependencies.length)}: ${dependencies.join(', ')}`
      }\n`
  )

  if (replacing) {
    // A repository can call itself anything, including the name of something
    // already installed. Silently overwriting would make "install this plugin"
    // a way to replace a different one.
    out.write(`\n  ! This replaces the "${manifest.name}" you already have installed.\n`)
  }

  out.write(
    `\n  A plugin is a program. Running one gives its code the same access to your\n` +
      `  files, your network and your session that you have - the same trust as\n` +
      `  \`npm install\`, an AUR package, or \`curl | sh\`. Nothing here is sandboxed\n` +
      `  and Lumanin does not claim otherwise.` +
      (provenance === null ? '\n\n' : ' Nobody has reviewed this code.\n\n') +
      `  Read it first if you do not know the author:\n` +
      `    ${directory}\n\n`
  )
}

/** The argument as a local directory, or `null` if it does not name one. */
function localDirectory(target: string): string | null {
  // A URL is never a directory, and `new URL()` on a Windows-ish path is not
  // something to find out about here.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return null
  try {
    const path = resolve(target)
    return statSync(path).isDirectory() ? path : null
  } catch {
    return null
  }
}

/** Named for the error message, so `./` and a trailing slash both read right. */
export function directoryLabel(path: string): string {
  return basename(path)
}

/**
 * A yes/no on the terminal.
 *
 * Defaults to **no**, and a non-interactive stdin answers no rather than
 * defaulting to yes — a prompt nobody can answer must never become an implied
 * consent, which is the same rule `scripts/install.sh` follows when it is piped
 * from `curl`.
 */
/** A free-text question on the terminal. Only ever called when stdin is a TTY. */
function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((settle) => {
    rl.question(question, (answer) => {
      rl.close()
      settle(answer.trim())
    })
  })
}

function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stdout.write(`${question}\n  (not a terminal - pass --yes if you meant to)\n`)
    return Promise.resolve(false)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((settle) => {
    rl.question(question, (answer) => {
      rl.close()
      settle(/^y(es)?$/i.test(answer.trim()))
    })
  })
}
