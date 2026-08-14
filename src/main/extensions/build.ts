import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build, type BuildOptions } from 'esbuild'
import { parseManifest, type CommandSpec, type Manifest } from '../../shared/extension'
import { ASSETS_DIRNAME, COMMANDS_DIRNAME, MANIFEST_BASENAME, SRC_DIRNAME, SUPPORT_DIRNAME } from './registry'

/**
 * Building an extension from source.
 *
 * RAYCAST-COMPAT.md §"Store & install" makes this the **primary** install path,
 * not a fallback: the `raycast/extensions` monorepo is MIT-licensed, so
 * compiling and running it is squarely permitted, while the store's own API is
 * private and undocumented. Everything here therefore has to work offline
 * against a directory on disk.
 *
 * The esbuild configuration mirrors `ray`'s own — platform node, CJS, automatic
 * JSX — with one addition that is ours and load-bearing: the externals list.
 */

/** Modules the bundle must never contain a copy of. See ARCHITECTURE.md §single-React. */
export const ALWAYS_EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'lumanin'
] as const

/**
 * The manifest's `dependencies`, minus the ones the worker provides — counting
 * `lumanin` or `react` would tell the user this needs packages when it needs
 * none, and a consent screen that overstates is one people learn to skim.
 * Shared by every consent surface (CLI install, GUI install, the store menu).
 */
export function thirdPartyDependencies(manifestPath: string): readonly string[] {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    const dependencies = raw['dependencies']
    if (typeof dependencies !== 'object' || dependencies === null) return []
    return Object.keys(dependencies as Record<string, string>).filter(
      (name) => !(ALWAYS_EXTERNAL as readonly string[]).includes(name)
    )
  } catch {
    return []
  }
}

/**
 * The scope that marks a plugin as written for a different launcher.
 *
 * `@raycast/*` were the specifiers our worker answered to before the API became
 * the single `lumanin` module; today the only code importing them is code from
 * the old ecosystem, which we deliberately no longer run. The check exists so
 * the person installing one gets one honest sentence instead of a resolver
 * error naming a module they never typed. The message itself stays name-free —
 * user-facing text does not mention the old ecosystem.
 */
const FOREIGN_SCOPE = '@raycast/'

export const FOREIGN_PLUGIN_MESSAGE =
  "this plugin was written for a different launcher's API and cannot run here - Lumanin plugins import from `lumanin`"

/** Whether a manifest declares runtime dependencies from the old ecosystem. */
export function foreignManifest(manifestPath: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    const dependencies = raw['dependencies']
    if (typeof dependencies !== 'object' || dependencies === null) return false
    return Object.keys(dependencies).some((name) => name.startsWith(FOREIGN_SCOPE))
  } catch {
    return false
  }
}

/** Where a command's entry file may live, in the order `ray` looks. */
const ENTRY_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'] as const

export interface BuildRequest {
  /** The extension's source directory: the one with `package.json` and `src/`. */
  readonly source: string
  /** Where the built extension goes: `<extensionsDir>/<name>`. */
  readonly destination: string
  /** Minify and drop sourcemaps. Off during `ext dev`, where the stack matters more. */
  readonly production?: boolean
  /** Run `npm install --ignore-scripts` when `node_modules` is missing. */
  readonly installDependencies?: boolean
  readonly onProgress?: (message: string) => void
}

export interface BuildResult {
  readonly manifest: Manifest
  readonly built: readonly string[]
  /** Commands that could not be built, and why. The rest still install. */
  readonly failures: readonly { readonly command: string; readonly reason: string }[]
}

export async function buildExtension(request: BuildRequest): Promise<BuildResult> {
  const manifestPath = join(request.source, MANIFEST_BASENAME)
  if (!existsSync(manifestPath)) {
    throw new Error(`${request.source} has no package.json - is that an extension directory?`)
  }

  const { manifest, problems } = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  if (manifest === null) {
    throw new Error(`that extension's manifest cannot be used: ${problems.join('; ')}`)
  }

  if (foreignManifest(manifestPath)) {
    throw new Error(FOREIGN_PLUGIN_MESSAGE)
  }

  if (request.installDependencies === true && !existsSync(join(request.source, 'node_modules'))) {
    await installDependencies(request.source, request.onProgress)
  }

  mkdirSync(join(request.destination, COMMANDS_DIRNAME), { recursive: true, mode: 0o700 })
  mkdirSync(join(request.destination, SUPPORT_DIRNAME), { recursive: true, mode: 0o700 })

  const built: string[] = []
  const failures: { command: string; reason: string }[] = []

  for (const command of manifest.commands) {
    const entry = findEntry(request.source, command)
    if (entry === null) {
      failures.push({
        command: command.name,
        reason: `no entry file - expected src/${command.name}${ENTRY_EXTENSIONS.join(' or src/' + command.name)}`
      })
      continue
    }

    try {
      request.onProgress?.(`building ${command.name}`)
      await build(bundleOptions(entry, join(request.destination, COMMANDS_DIRNAME, `${command.name}.js`), manifest, request.production === true))
      built.push(command.name)
    } catch (error) {
      // One command that does not compile must not cost the user the other five.
      failures.push({ command: command.name, reason: describe(error) })
    }
  }

  // The manifest is copied verbatim rather than re-serialised from our parse:
  // fields we do not model yet (`ai`, `tools` details, anything Raycast adds
  // next month) have to survive an install, or upgrading Lumanin would silently
  // strip them from every extension already on disk.
  writeFileSync(join(request.destination, MANIFEST_BASENAME), readFileSync(manifestPath), {
    mode: 0o600
  })

  const assets = join(request.source, ASSETS_DIRNAME)
  if (isDirectory(assets)) {
    const target = join(request.destination, ASSETS_DIRNAME)
    rmSync(target, { recursive: true, force: true })
    cpSync(assets, target, { recursive: true })
  }

  // The source ships with the install. The built bundles cannot be published —
  // nothing rebuilds from them — so without this, `lumanin plugin-export` would
  // have nothing to hand back for the plugins people most want to share: the
  // ones generated on this machine, whose working directory is long gone.
  const source = join(request.source, SRC_DIRNAME)
  if (isDirectory(source)) {
    const target = join(request.destination, SRC_DIRNAME)
    rmSync(target, { recursive: true, force: true })
    cpSync(source, target, { recursive: true })
  }

  return { manifest, built, failures }
}

/**
 * The esbuild configuration.
 *
 * `platform: 'node'` and `format: 'cjs'` because the worker's module hook works
 * by patching `Module._resolveFilename`, which only sees CommonJS requires
 * (ARCHITECTURE.md §"Interception mechanism" — if we ever emit ESM this becomes
 * a `module.register()` loader, decided once rather than per extension).
 *
 * `external` is the whole of the single-React rule's build half: React and the
 * API must come from the worker, and the manifest's own `external[]` names
 * modules the author needs resolved from their `node_modules` at runtime —
 * usually native ones, which are exactly the extensions that break most
 * confusingly when the field is ignored.
 */
function bundleOptions(
  entry: string,
  outfile: string,
  manifest: Manifest,
  production: boolean
): BuildOptions {
  return {
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    jsx: 'automatic',
    // The entry's default export is what the worker mounts, so it has to survive
    // bundling — `treeShaking` with no `mainFields` hint has been known to drop
    // a default export that nothing inside the bundle references.
    treeShaking: true,
    minify: production,
    sourcemap: production ? false : 'inline',
    logLevel: 'silent',
    external: [...ALWAYS_EXTERNAL, ...manifest.external],
    define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
    // Extensions are written against browser-ish globals in places (`fetch`,
    // `AbortController`); Node 24 has all of them, so nothing is polyfilled and
    // nothing needs to be.
    banner: {
      js: '/* built by lumanin - do not edit; reinstall the extension instead */'
    }
  }
}

function findEntry(source: string, command: CommandSpec): string | null {
  for (const extension of ENTRY_EXTENSIONS) {
    const candidate = join(source, 'src', `${command.name}${extension}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * `npm install --ignore-scripts`.
 *
 * SECURITY.md calls install scripts "the sharpest edge in the whole product" and
 * requires `--ignore-scripts` by **default**. Installing an extension already
 * means running its author's code — but only when you run the extension, and
 * only in a worker. A postinstall script runs at install time, as your user, in
 * the daemon's environment, before you have seen anything.
 *
 * An extension whose build genuinely needs scripts fails here with its own error,
 * and enabling them is a per-extension decision with its own consent screen — not
 * a flag we quietly set for everyone.
 */
function installDependencies(source: string, onProgress?: (message: string) => void): Promise<void> {
  onProgress?.('installing dependencies (scripts disabled)')

  return new Promise((resolve, reject) => {
    // An argv array, never a shell string (SECURITY.md §"Rules for reviewers").
    const child = spawn('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: source,
      stdio: 'ignore'
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm install failed with exit code ${String(code)}`))
    })
  })
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // esbuild puts the useful part in `errors[].text`; its `message` is a count.
    const errors = (error as { errors?: { text?: string; location?: { file?: string; line?: number } }[] })
      .errors
    if (Array.isArray(errors) && errors.length > 0) {
      // A source file importing the old ecosystem's modules without declaring
      // them fails resolution here; say the honest sentence, not the specifier.
      if (errors.some((entry) => entry.text?.includes(`resolve "${FOREIGN_SCOPE}`) === true)) {
        return FOREIGN_PLUGIN_MESSAGE
      }
      return errors
        .map((entry) =>
          entry.location?.file === undefined
            ? (entry.text ?? 'build failed')
            : `${entry.location.file}:${String(entry.location.line ?? 0)}: ${entry.text ?? 'build failed'}`
        )
        .join('; ')
    }
    return error.message
  }
  return String(error)
}
