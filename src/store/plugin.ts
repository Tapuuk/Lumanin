import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { firstLine, hasGit, must, runCommand, type Run } from './git'
import { checkoutName, type PluginSource } from './plugin-source'

/**
 * Fetching a plugin from a public repository.
 *
 * Different from the catalogue's fetch in `source.ts` in every way that matters,
 * which is why it is a separate function rather than a flag on that one:
 *
 *  - **the repository is arbitrary**, so nothing about its layout is assumed;
 *  - **there is no pinned commit**, because the author has not published one to
 *    us — we take whatever the ref resolves to *now* and record it, so the
 *    install is reproducible afterwards even though it was not beforehand;
 *  - **a subdirectory makes the fetch sparse and blobless**, so pasting the URL
 *    of one plugin inside `raycast/extensions` costs that plugin rather than
 *    several gigabytes of working tree. A repository with a plugin at its root
 *    is fetched whole, because it is small by construction.
 *
 * What it shares is the rule that matters: git is spawned with an argv array and
 * with prompting disabled, so a repository that does not exist fails cleanly
 * instead of stopping on a credential prompt nobody can see.
 */

const STORE_DIRNAME = 'store'
const PLUGINS_DIRNAME = 'plugins'

/** Written beside an installed plugin so we know where it came from. */
export const PROVENANCE_BASENAME = '.lumanin-source.json'

export interface Provenance {
  /** `github.com/owner/repo`, as shown to the user. */
  readonly label: string
  readonly remote: string
  readonly ref: string | null
  readonly subdirectory: string | null
  /** The commit actually installed. Recorded even though it was not chosen. */
  readonly commit: string
  readonly installedAt: string
}

export class PluginFetchError extends Error {}

/** One plugin found below a repository root that has no manifest of its own. */
export interface PluginCandidate {
  /** Repository-relative path, `/`-separated — pasteable into a URL. */
  readonly subdirectory: string
  /** The manifest's `name`, so a list of candidates reads as plugins. */
  readonly name: string
}

/**
 * The repository holds several plugins and named none. Choosing one here would
 * install code the user did not pick, so the caller asks instead — the CLI with
 * a numbered prompt, the GUI by listing them in the error.
 */
export class PluginChoiceError extends PluginFetchError {
  constructor(
    label: string,
    readonly candidates: readonly PluginCandidate[]
  ) {
    super(
      `${label} holds ${String(candidates.length)} plugins and its root is none of them:\n` +
        candidates.map((candidate) => `  ${candidate.subdirectory}  (${candidate.name})`).join('\n') +
        `\nPaste the URL of the directory you want - the repository URL with /tree/<branch>/<directory> on the end.`
    )
  }
}

export interface PluginFetchRequest {
  readonly source: PluginSource
  /** `paths.cache`. */
  readonly cacheDir: string
  readonly onProgress?: (message: string) => void
  readonly run?: Run
}

export interface PluginCheckout {
  /** The directory holding the plugin's `package.json`. */
  readonly directory: string
  readonly commit: string
  /**
   * The subdirectory the plugin actually lives in — the one the URL named, or
   * the one discovery found under a rootless repository. Provenance records
   * this rather than the URL's, so a reinstall repeats the same choice.
   */
  readonly subdirectory: string | null
}

/**
 * Clone or update the repository, and return the directory to build from.
 *
 * Re-running for a repository already fetched updates it rather than starting
 * over, which is what makes this usable as the update path later.
 */
export async function fetchPlugin(request: PluginFetchRequest): Promise<PluginCheckout> {
  const run = request.run ?? runCommand
  const root = join(request.cacheDir, STORE_DIRNAME, PLUGINS_DIRNAME)
  const checkout = join(root, checkoutName(request.source))

  mkdirSync(root, { recursive: true, mode: 0o700 })

  if (!(await hasGit(run, root))) {
    throw new PluginFetchError(
      'git is not installed, and a plugin is installed by cloning its repository.\n' +
        'Install git, or clone it yourself and run `lumanin plugin-install <directory>`.'
    )
  }

  const fresh = !existsSync(join(checkout, '.git'))
  if (fresh) {
    request.onProgress?.(`fetching ${request.source.label}`)
    mkdirSync(checkout, { recursive: true, mode: 0o700 })
    await must(run('git', ['init', '--quiet'], checkout), 'could not create the local clone')
    await must(
      run('git', ['remote', 'add', 'origin', request.source.remote], checkout),
      'could not set the remote'
    )
  } else {
    request.onProgress?.('updating the local clone')
  }

  // A subdirectory means a monorepo, and a monorepo means never checking the
  // whole thing out. `raycast/extensions` is several gigabytes of working tree
  // and around five thousand plugins; asking for one of them should cost one of
  // them. Blobless + sparse is the same trick `source.ts` uses on that same
  // repository, and it is what makes "paste the URL of the directory you are
  // looking at" a reasonable thing to offer for a repository of any size.
  if (request.source.subdirectory !== null) {
    await must(
      run('git', ['config', 'core.sparseCheckout', 'true'], checkout),
      'could not configure the local clone'
    )
    writeSparsePatterns(checkout, request.source.subdirectory)
  }

  const ref = request.source.ref ?? 'HEAD'
  const fetched = await run(
    'git',
    [
      'fetch',
      '--quiet',
      '--depth',
      '1',
      ...(request.source.subdirectory === null ? [] : ['--filter=blob:none']),
      'origin',
      // The URL parser refuses an option-shaped ref, but a source rebuilt from
      // provenance on disk never went through it; `--` holds either way.
      '--',
      ref
    ],
    checkout
  )
  if (!fetched.ok) {
    // A half-made clone is worth less than none: leaving it behind would make
    // the next attempt take the "update" path against a repository that was
    // never fetched.
    if (fresh) rmSync(checkout, { recursive: true, force: true })
    throw new PluginFetchError(
      `could not fetch ${request.source.label}${request.source.ref === null ? '' : ` at ${request.source.ref}`} - ${firstLine(fetched.output)}\n` +
        'Check the URL, that the repository is public, and that you are online.'
    )
  }

  await must(
    run('git', ['read-tree', '-mu', 'FETCH_HEAD'], checkout),
    'could not check out the plugin'
  )

  const head = await run('git', ['rev-parse', 'FETCH_HEAD'], checkout)
  const commit = head.ok ? head.output.trim() : 'unknown'

  const directory = pluginDirectory(checkout, request.source.subdirectory)

  // A repository root that is not itself a plugin often *contains* one — nobody
  // publishing a plugin thinks of themselves as publishing a monorepo, so look
  // one or two levels down before giving up. Bounded on purpose: a manifest six
  // levels deep is not something somebody meant to publish.
  if (request.source.subdirectory === null && !isPluginManifest(join(directory, 'package.json'))) {
    const candidates = findPluginDirectories(directory)
    if (candidates.length === 1 && candidates[0] !== undefined) {
      const found = candidates[0]
      request.onProgress?.(`the plugin lives in ${found.subdirectory}/ - using it`)
      return {
        directory: join(directory, ...found.subdirectory.split('/')),
        commit,
        subdirectory: found.subdirectory
      }
    }
    if (candidates.length > 1) throw new PluginChoiceError(request.source.label, candidates)
  }

  if (!existsSync(join(directory, 'package.json'))) {
    throw new PluginFetchError(
      request.source.subdirectory === null
        ? `${request.source.label} has no package.json at its root.\n` +
            'If the plugin lives in a subdirectory, paste the URL of that directory\n' +
            'instead of the repository root.'
        : `${request.source.label} has no package.json in ${request.source.subdirectory}.`
    )
  }

  return { directory, commit, subdirectory: request.source.subdirectory }
}

/** A `package.json` that declares commands — the shape every plugin has. */
function isPluginManifest(path: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null) return false
    return Array.isArray((raw as Record<string, unknown>)['commands'])
  } catch {
    return false
  }
}

/**
 * Directories one or two levels below `root` that hold a plugin manifest,
 * sorted so the list (and the "exactly one" answer) is stable across machines.
 * Dot-directories and `node_modules` are nobody's published plugin.
 */
export function findPluginDirectories(root: string): readonly PluginCandidate[] {
  const found: PluginCandidate[] = []
  const scan = (relative: string, depth: number): void => {
    const absolute = join(root, ...relative.split('/').filter(Boolean))
    let entries
    try {
      entries = readdirSync(absolute, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const sub = relative === '' ? entry.name : `${relative}/${entry.name}`
      const manifest = join(absolute, entry.name, 'package.json')
      if (isPluginManifest(manifest)) {
        const raw = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
        found.push({ subdirectory: sub, name: typeof raw['name'] === 'string' ? raw['name'] : sub })
      } else if (depth < 2) {
        scan(sub, depth + 1)
      }
    }
  }
  scan('', 1)
  return found.sort((a, b) => a.subdirectory.localeCompare(b.subdirectory))
}

/**
 * Join a subdirectory to the checkout, and refuse anything that leaves it.
 *
 * The third check on the same thing — `new URL()` normalises `..` away first and
 * `parsePluginSource` rejects what is left. Deliberate: this is the one that
 * still holds if the path ever reaches here without going through either.
 */
function pluginDirectory(checkout: string, subdirectory: string | null): string {
  if (subdirectory === null) return checkout
  const joined = resolve(checkout, subdirectory)
  if (joined !== checkout && !joined.startsWith(`${resolve(checkout)}${sep}`)) {
    throw new PluginFetchError('that path is not inside the repository')
  }
  return joined
}

/** Record where an installed plugin came from. */
export function writeProvenance(destination: string, provenance: Provenance): void {
  writeFileSync(join(destination, PROVENANCE_BASENAME), `${JSON.stringify(provenance, null, 2)}\n`, {
    mode: 0o600
  })
}

/** Read it back. `null` for anything installed from a local directory. */
export function readProvenance(directory: string): Provenance | null {
  try {
    const raw = JSON.parse(readFileSync(join(directory, PROVENANCE_BASENAME), 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null) return null
    const record = raw as Record<string, unknown>
    if (typeof record['label'] !== 'string' || typeof record['remote'] !== 'string') return null
    return {
      label: record['label'],
      remote: record['remote'],
      ref: typeof record['ref'] === 'string' ? record['ref'] : null,
      subdirectory: typeof record['subdirectory'] === 'string' ? record['subdirectory'] : null,
      commit: typeof record['commit'] === 'string' ? record['commit'] : 'unknown',
      installedAt: typeof record['installedAt'] === 'string' ? record['installedAt'] : 'unknown'
    }
  } catch {
    return null
  }
}

/**
 * Sparse patterns for one directory inside a repository.
 *
 * Non-cone patterns written straight to the file, as in `source.ts`: cone mode
 * cannot express "this directory and nothing else at any level", and the pattern
 * file is the documented interface to the same machinery.
 */
function writeSparsePatterns(checkout: string, subdirectory: string): void {
  mkdirSync(join(checkout, '.git', 'info'), { recursive: true })
  const parts = subdirectory.split('/')

  // Walk down: allow each directory on the way, exclude its siblings, and take
  // the target whole. Without the intermediate negations git materialises every
  // sibling at every level, which for a monorepo is the entire repository.
  const lines = ['/*', '!/*/']
  let prefix = ''
  for (const [index, part] of parts.entries()) {
    prefix += `/${part}`
    lines.push(`${prefix}/`)
    if (index < parts.length - 1) lines.push(`!${prefix}/*/`)
  }

  writeFileSync(join(checkout, '.git', 'info', 'sparse-checkout'), `${lines.join('\n')}\n`, {
    mode: 0o600
  })
}
