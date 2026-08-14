import { existsSync, readFileSync, rmSync, statSync, watch } from 'node:fs'
import { basename, resolve } from 'node:path'
import { buildExtension } from '../main/extensions/build'
import { scanAllExtensions } from '../main/extensions/registry'
import { bundledPluginsDir, resolvePaths } from '../node/paths'
import { parseManifest } from '../shared/extension'
import { APP_ID } from '../shared/identity'
import { request } from './client'

/**
 * `lumanin ext` — list, remove and develop extensions. Installing moved to
 * `lumanin plugin-install`; the `install` verb here only prints that spelling.
 *
 * Everything here is deliberately **local**: a directory on disk goes in, a
 * built extension comes out, and nothing is fetched from anywhere.
 *
 * Loaded through a dynamic import from `tools.ts`, like `doctor` and `config`,
 * so none of it — nor esbuild, which it pulls in — sits on the toggle path.
 */

const USAGE = `Usage: ${APP_ID} ext <command>

  list                    show installed extensions and their commands
  remove <name>           uninstall an extension and forget its data
  dev <directory>         rebuild and reload on every change (Ctrl-C to stop)

Installing is \`${APP_ID} plugin-install\`, which takes a repository URL or a
directory. There is one install command rather than two.
`

export async function runExt(rest: readonly string[]): Promise<number> {
  const [subcommand, ...args] = rest

  switch (subcommand) {
    case undefined:
    case 'list':
      return list()
    case 'install':
      // Kept as a signpost rather than an alias. Someone typing the old spelling
      // should be told the new one, not silently served by it — otherwise both
      // stay in circulation forever and every doc has to pick a side.
      process.stderr.write(
        `${APP_ID}: installing is \`${APP_ID} plugin-install\` now - it takes a URL or a directory.\n\n` +
          `  ${APP_ID} plugin-install ${args[0] ?? '<repository|directory>'}\n`
      )
      return 2
    case 'remove':
      return remove(args[0])
    case 'dev':
      return await dev(args[0])
    default:
      process.stderr.write(`${APP_ID}: unknown ext command '${subcommand}'\n\n${USAGE}`)
      return 2
  }
}

function list(): number {
  const paths = resolvePaths()
  const index = scanAllExtensions({
    extensionsDir: paths.extensionsDir,
    bundledDir: bundledPluginsDir(__dirname),
    dataDir: paths.data
  })

  if (index.extensions.length === 0 && index.problems.length === 0) {
    process.stdout.write(
      `No extensions installed.\n\nInstall one with:  ${APP_ID} plugin-install <repository|directory>\n`
    )
    return 0
  }

  for (const extension of index.extensions) {
    const commands = index.commands.filter((command) => command.extension === extension)
    process.stdout.write(`${extension.manifest.title}  (${extension.manifest.name})\n`)
    if (extension.source !== null) {
      process.stdout.write(
        `    from ${extension.source.label} @ ${extension.source.commit.slice(0, 12)}\n`
      )
    }
    for (const command of commands) {
      process.stdout.write(`    ${command.spec.title.padEnd(28)} ${command.id}\n`)
    }
    if (commands.length === 0) process.stdout.write('    (no runnable commands)\n')
    process.stdout.write('\n')
  }

  // Problems are printed even when everything else worked, and to stderr, so a
  // half-broken install is visible without making `ext list | grep` useless.
  for (const problem of index.problems) {
    process.stderr.write(`${problem.name}: ${problem.problem}\n`)
  }
  return index.problems.length > 0 ? 1 : 0
}

function remove(name: string | undefined): number {
  if (name === undefined) {
    process.stderr.write(`${APP_ID}: ext remove needs an extension name\n\n${USAGE}`)
    return 2
  }

  const paths = resolvePaths()
  const directory = resolve(paths.extensionsDir, name)

  // `basename` rather than a path check: the argument is a *name*, and one that
  // resolves anywhere other than directly inside the extensions directory is not
  // one — `ext remove ../../..` must not be a way to delete a home directory.
  if (basename(directory) !== name || !isDirectory(directory)) {
    // A plugin that ships inside the application is not installed here and
    // cannot be deleted — the next upgrade would put it back. Say which of the
    // two "not installed" means, and name the thing that does work.
    if (isDirectory(resolve(bundledPluginsDir(__dirname), name))) {
      process.stderr.write(
        `${APP_ID}: '${name}' ships with ${APP_ID} and cannot be removed.\n` +
          `Turn it off instead:  ${APP_ID} plugins\n`
      )
      return 1
    }
    process.stderr.write(`${APP_ID}: no extension called '${name}' is installed\n`)
    return 1
  }

  rmSync(directory, { recursive: true, force: true })
  process.stdout.write(`Removed ${name}\n`)
  // Its LocalStorage and preferences stay in the database until the daemon is
  // asked to forget them; `ext remove` deletes the code, and the daemon drops
  // the rest when it rescans. Said out loud because "I reinstalled it and my
  // settings came back" should be a documented behaviour, not a surprise.
  process.stdout.write(`Its stored data is kept, in case you reinstall it.\n`)
  void reloadDaemon()
  return 0
}

/**
 * `ext dev` — rebuild on change and reload the running session.
 *
 * The reload is a fresh worker rather than a re-require, so a rebuilt bundle
 * actually takes effect (Node's module cache would otherwise hand back the old
 * one, and the reload would look like it did nothing).
 */
async function dev(directory: string | undefined): Promise<number> {
  if (directory === undefined) {
    process.stderr.write(`${APP_ID}: ext dev needs a directory\n\n${USAGE}`)
    return 2
  }

  const source = resolve(directory)
  const name = manifestName(source)
  if (name === null) {
    process.stderr.write(`${APP_ID}: ${source} has no usable package.json\n`)
    return 1
  }

  const paths = resolvePaths()
  const destination = resolve(paths.extensionsDir, name)

  const rebuild = async (): Promise<void> => {
    const started = Date.now()
    try {
      const result = await buildExtension({
        source,
        destination,
        production: false,
        onProgress: () => {}
      })
      const failed = result.failures.length
      process.stdout.write(
        `  rebuilt ${String(result.built.length)} command${result.built.length === 1 ? '' : 's'}` +
          ` in ${String(Date.now() - started)}ms${failed > 0 ? ` (${String(failed)} failed)` : ''}\n`
      )
      for (const failure of result.failures) {
        process.stderr.write(`    ${failure.command}: ${failure.reason}\n`)
      }
      await reloadDaemon()
    } catch (error) {
      // A syntax error must not stop the watcher: the next save is usually the fix.
      process.stderr.write(`    ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  process.stdout.write(`Watching ${source} for changes. Ctrl-C to stop.\n`)
  await rebuild()

  let pending: NodeJS.Timeout | null = null
  const watcher = watch(source, { recursive: true }, (_event, filename) => {
    // The build writes into the source's own tree in some layouts, and a rebuild
    // triggered by its own output is a loop that never settles.
    if (filename !== null && /(^|[/\\])(node_modules|\.git|dist)([/\\]|$)/.test(filename)) return
    if (pending !== null) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      void rebuild()
    }, 120)
  })

  await new Promise<void>((resolveWatch) => {
    process.on('SIGINT', () => {
      watcher.close()
      process.stdout.write('\nStopped watching.\n')
      resolveWatch()
    })
  })
  return 0
}

/**
 * Tell a running daemon to re-scan.
 *
 * Best-effort by design: installing an extension with no daemon running is a
 * perfectly normal thing to do, and the next start will find it.
 */
async function reloadDaemon(): Promise<void> {
  const reply = await request(resolvePaths().socket, { kind: 'reload' })
  if (reply !== null) process.stdout.write('Reloaded the running daemon.\n')
}

function manifestName(source: string): string | null {
  try {
    const { manifest } = parseManifest(JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8')))
    return manifest?.name ?? null
  } catch {
    return null
  }
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}
