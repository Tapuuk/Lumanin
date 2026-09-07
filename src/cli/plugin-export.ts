import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  ASSETS_DIRNAME,
  MANIFEST_BASENAME,
  SRC_DIRNAME
} from '../main/extensions/registry'
import { readProvenance } from '../store/plugin'
import { APP_ID } from '../shared/identity'
import { resolvePaths } from '../node/paths'

/**
 * `lumanin plugin-export <name>` — an installed plugin back as a publishable
 * directory.
 *
 * Publishing needs the *source* — `package.json`, `src/`, assets — and installs
 * keep exactly that alongside the built bundles (build.ts). What is exported is
 * therefore what `plugin-install <directory>` accepts, which closes the loop:
 * generate, install, export, push, and anyone installs it from the URL.
 *
 * The built `commands/`, the `support/` directory and the provenance record
 * stay behind on purpose. The first two are machine output this machine made;
 * the last says where *you* got it, which is nobody else's metadata.
 */

/** Where exports land unless the user says otherwise: the XDG downloads dir. */
export function resolveDownloadsDir(configHome: string, home: string): string {
  try {
    // The file is shell syntax by specification, but only ever of the shape
    // XDG_DOWNLOAD_DIR="$HOME/…" or an absolute quoted path — parsed, not run.
    const text = readFileSync(join(configHome, 'user-dirs.dirs'), 'utf8')
    const match = /^XDG_DOWNLOAD_DIR="(.+)"/m.exec(text)
    if (match?.[1] !== undefined) {
      const value = match[1].replace(/^\$HOME/, home)
      if (value.startsWith('/')) return value
    }
  } catch {
    // No file is the normal state outside full desktops; the fallback stands.
  }
  return join(home, 'Downloads')
}

export interface ExportResult {
  /** The directory the plugin now sits in. */
  readonly directory: string
  /** The remote it was originally installed from, when that is on record. */
  readonly publishedAt: string | null
}

export interface ExportOptions {
  /** Write a LICENSE file. Only MIT is offered — short, and what Lumanin uses. */
  readonly license?: 'mit'
}

/** Copy one installed plugin's publishable half into `destinationDir/<name>`. */
export function exportPlugin(
  extensionsDir: string,
  name: string,
  destinationDir: string,
  options: ExportOptions = {}
): ExportResult {
  const installed = join(extensionsDir, name)
  // The same rule as removal in the plugins menu: a name is a *name*, and one
  // that resolves anywhere but directly inside the extensions directory is not
  // one we accept.
  if (basename(installed) !== name || !existsSync(join(installed, MANIFEST_BASENAME))) {
    throw new Error(`no plugin called '${name}' is installed - \`${APP_ID} ext list\` shows what is.`)
  }

  const source = join(installed, SRC_DIRNAME)
  if (!isDirectory(source)) {
    throw new Error(
      `'${name}' was installed before Lumanin kept plugin source, so there is nothing here to publish.\n` +
        `Reinstall it - \`${APP_ID} plugin-install <its directory or URL>\` - and export again.`
    )
  }

  const target = join(destinationDir, name)
  if (existsSync(target)) {
    throw new Error(`${target} already exists - move it out of the way first.`)
  }

  mkdirSync(target, { recursive: true })
  cpSync(join(installed, MANIFEST_BASENAME), join(target, MANIFEST_BASENAME))
  cpSync(source, join(target, SRC_DIRNAME), { recursive: true })
  const assets = join(installed, ASSETS_DIRNAME)
  if (isDirectory(assets)) cpSync(assets, join(target, ASSETS_DIRNAME), { recursive: true })

  scaffoldRepository(target, name, options)

  const provenance = readProvenance(installed)
  return { directory: target, publishedAt: provenance?.remote ?? null }
}

/**
 * What a publishable repository needs and a working plugin does not: a README
 * naming the plugin and the install command, a `.gitignore`, and — when asked —
 * a LICENSE. Written only where the plugin did not bring its own: an exported
 * fork keeps the original author's files.
 */
function scaffoldRepository(target: string, name: string, options: ExportOptions): void {
  const manifest = readManifestLoosely(join(target, MANIFEST_BASENAME), name)

  if (!existsSync(join(target, 'README.md'))) {
    writeFileSync(
      join(target, 'README.md'),
      `# ${manifest.title}\n\n` +
        `${manifest.description}\n\n` +
        `A plugin for [Lumanin](https://github.com/Tapuuk/Lumanin). Install it with:\n\n` +
        `\`\`\`sh\n${APP_ID} plugin-install <this repository's URL>\n\`\`\`\n\n` +
        `(Replace the placeholder with the URL of wherever you publish this.)\n`
    )
  }

  if (!existsSync(join(target, '.gitignore'))) {
    writeFileSync(join(target, '.gitignore'), 'node_modules/\n')
  }

  if (options.license === 'mit' && !existsSync(join(target, 'LICENSE'))) {
    writeFileSync(join(target, 'LICENSE'), mitLicense(manifest.author))
  }
}

/** Title, description and author for the scaffold; blanks over a throw. */
function readManifestLoosely(
  path: string,
  name: string
): { title: string; description: string; author: string } {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    return {
      title: typeof raw['title'] === 'string' ? raw['title'] : name,
      description: typeof raw['description'] === 'string' ? raw['description'] : '',
      author: typeof raw['author'] === 'string' ? raw['author'] : ''
    }
  } catch {
    return { title: name, description: '', author: '' }
  }
}

function mitLicense(author: string): string {
  return `MIT License

Copyright (c) ${String(new Date().getFullYear())}${author === '' ? '' : ` ${author}`}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
}

export async function runPluginExport(rest: readonly string[]): Promise<number> {
  const paths = resolvePaths()
  const mit = rest.includes('--mit')
  const positional = rest.filter((argument) => argument !== '--mit')
  const name = positional[0]

  if (name === undefined) {
    process.stderr.write(EXPORT_USAGE)
    return 2
  }

  const destinationDir = positional[1] ?? resolveDownloadsDir(paths.configHome, paths.home)

  let result: ExportResult
  try {
    result = exportPlugin(paths.extensionsDir, name, destinationDir, mit ? { license: 'mit' } : {})
  } catch (error) {
    process.stderr.write(`${APP_ID}: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  process.stdout.write(`Exported to ${result.directory}\n`)
  if (result.publishedAt !== null) {
    process.stdout.write(
      `\nNote: this plugin was installed from ${result.publishedAt},\n` +
        `so it is already published there. Exporting makes sense for a fork.\n`
    )
  }
  process.stdout.write(
    `\nA README and .gitignore are scaffolded${mit ? ', and an MIT LICENSE written' : ''}.\n` +
      (mit ? '' : `Add a LICENSE before publishing (re-run with --mit for MIT), and `) +
      `fill in the README's placeholder URL once you know it.\n` +
      `\nTo publish it:\n\n` +
      `  1. Create an empty public repository (for GitHub: https://github.com/new).\n` +
      `  2. cd '${result.directory}'\n` +
      `     git init && git add . && git commit -m '${name}'\n` +
      `     git remote add origin <your repository URL>\n` +
      `     git push -u origin main\n` +
      `  3. Anyone installs it with:  ${APP_ID} plugin-install <your repository URL>\n`
  )
  return 0
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export const EXPORT_USAGE = `Usage: ${APP_ID} plugin-export <name> [directory] [--mit]

  Copy an installed plugin's source into your Downloads folder (or [directory])
  as a directory ready to publish: push it to any public git repository and
  anyone installs it with \`${APP_ID} plugin-install <url>\`. A README stub and
  a .gitignore are added; --mit writes an MIT LICENSE too.

  \`${APP_ID} ext list\` shows the names of what is installed.
`
