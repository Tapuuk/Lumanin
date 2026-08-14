import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ICON_SCHEME } from '../../shared/identity'
import { parseManifest, type CommandSpec, type Manifest, type PreferenceSpec } from '../../shared/extension'
import { readProvenance, type Provenance } from '../../store/plugin'
import type { Logger } from '../../node/logger'
import type { RootCommand } from '../root-search'

/**
 * What is installed, and what it offers at the root.
 *
 * An installed extension is a directory under `$XDG_DATA_HOME/lumanin/extensions/`
 * holding the manifest it was published with, its assets, and one built entry file
 * per command. Nothing here builds anything — `build.ts` does that at install time
 * — so a scan is a handful of `readFile`s and can be redone whenever the directory
 * changes.
 *
 * ```
 *   extensions/<name>/
 *     package.json        the manifest, verbatim from the source
 *     assets/             environment.assetsPath
 *     commands/<cmd>.js   the built entry, CommonJS, externals per the single-React rule
 *     support/            environment.supportPath — the extension's own scratch space
 * ```
 */

export const COMMANDS_DIRNAME = 'commands'
export const SRC_DIRNAME = 'src'
export const ASSETS_DIRNAME = 'assets'
export const SUPPORT_DIRNAME = 'support'
export const MANIFEST_BASENAME = 'package.json'

export interface InstalledCommand {
  readonly extension: InstalledExtension
  readonly spec: CommandSpec
  /** Absolute path to the built entry. Never crosses to the renderer. */
  readonly entryPath: string
  /** `<extension>/<command>`, which is also the alias target and the id suffix. */
  readonly id: string
}

export interface InstalledExtension {
  readonly manifest: Manifest
  readonly directory: string
  readonly assetsPath: string
  readonly supportPath: string
  /**
   * Where it came from, for anything installed with `plugin-install`.
   *
   * `null` for one built from a local directory, which is the honest answer
   * rather than a fabricated origin. Kept on the index because "which of these
   * did I get off the internet, and from whom" is a question a person should be
   * able to answer without opening a file.
   */
  readonly source: Provenance | null
  /**
   * Shipped inside the application rather than installed by the user.
   *
   * Some of the launcher's own features are plugins — file search is the first
   * — because they are searches over something the machine already knows, which
   * is exactly what the plugin API is for. Writing them any other way would mean
   * a second way to build a searchable view, and the second one would be worse:
   * everything `List` already does (filtering by the launcher's rules, the
   * action panel, the dropdown, empty states) would have to exist twice.
   *
   * Two consequences, both deliberate. A bundled plugin can be **disabled** like
   * any other but not **removed** — it lives in the application directory and
   * would come back on the next upgrade, so offering removal would be offering
   * something that does not stick. And a user-installed plugin of the same name
   * **wins**, which is what makes ours replaceable rather than privileged.
   */
  readonly bundled: boolean
}

export interface ExtensionIndex {
  readonly extensions: readonly InstalledExtension[]
  readonly commands: readonly InstalledCommand[]
  /** Extensions that are present but unusable, and why. Surfaced by `lumanin doctor`. */
  readonly problems: readonly { readonly name: string; readonly problem: string }[]
}

export function emptyIndex(): ExtensionIndex {
  return { extensions: [], commands: [], problems: [] }
}

/**
 * Scan the extensions directory.
 *
 * Every failure is per-extension. One unreadable manifest must not cost the user
 * the other twelve, and the reason it could not be read is kept rather than
 * logged and dropped — "my extension disappeared" is otherwise unanswerable.
 */
export function scanExtensions(
  directory: string,
  logger?: Logger,
  options: {
    readonly bundled?: boolean
    /**
     * Where `environment.supportPath` goes instead of inside the extension.
     *
     * Required for a bundled plugin and meaningless for an installed one. A
     * packaged application directory is read-only — owned by the package
     * manager, and inside the AppImage mount on the AppImage build — so a
     * bundled plugin writing to `<its dir>/support` fails on exactly the
     * installs real users have and works on every developer's machine.
     */
    readonly supportRoot?: string
  } = {}
): ExtensionIndex {
  const extensions: InstalledExtension[] = []
  const commands: InstalledCommand[] = []
  const problems: { name: string; problem: string }[] = []

  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    // No extensions directory is the normal state before the first install.
    return emptyIndex()
  }

  for (const name of entries.sort()) {
    const extensionDir = join(directory, name)
    try {
      if (!statSync(extensionDir).isDirectory()) continue
    } catch {
      continue
    }

    const raw = readJson(join(extensionDir, MANIFEST_BASENAME))
    if (raw === null) {
      problems.push({ name, problem: 'its package.json is missing or not valid JSON' })
      continue
    }

    const { manifest, problems: parsed } = parseManifest(raw)
    if (manifest === null) {
      problems.push({ name, problem: parsed.join('; ') })
      continue
    }
    for (const problem of parsed) {
      logger?.warn('extension manifest problem', { extension: manifest.name, problem })
    }

    const extension: InstalledExtension = {
      manifest,
      directory: extensionDir,
      assetsPath: join(extensionDir, ASSETS_DIRNAME),
      supportPath:
        options.supportRoot === undefined
          ? join(extensionDir, SUPPORT_DIRNAME)
          : join(options.supportRoot, manifest.name),
      source: readProvenance(extensionDir),
      bundled: options.bundled === true
    }
    extensions.push(extension)

    for (const spec of manifest.commands) {
      if (spec.disabledByDefault) continue
      const entryPath = join(extensionDir, COMMANDS_DIRNAME, `${spec.name}.js`)
      if (!exists(entryPath)) {
        // Declared but never built. Naming it is the difference between "that
        // command is missing" and a root list that is quietly one row short.
        problems.push({
          name: manifest.name,
          problem: `command "${spec.name}" has no built entry - reinstall the extension`
        })
        continue
      }
      commands.push({ extension, spec, entryPath, id: `${manifest.name}/${spec.name}` })
    }
  }

  return { extensions, commands, problems }
}

/**
 * Everything the launcher can run: what the user installed, then what we ship.
 *
 * The one place that answers "which plugins are there", so that the daemon, the
 * `plugins` screen, `ext list` and the pin picker cannot disagree about it. They
 * did while `plugin-install` was the only source; the moment a plugin could also
 * arrive inside the application, four call sites each scanning one directory
 * would have meant file search running at the root but absent from every screen
 * that manages plugins.
 */
export function scanAllExtensions(options: {
  readonly extensionsDir: string
  readonly bundledDir: string
  /** `paths.data` — bundled plugins get their scratch space under here. */
  readonly dataDir: string
  readonly logger?: Logger
}): ExtensionIndex {
  return mergeIndexes(
    scanExtensions(options.extensionsDir, options.logger),
    scanExtensions(options.bundledDir, options.logger, {
      bundled: true,
      supportRoot: join(options.dataDir, 'plugin-support')
    })
  )
}

/**
 * The bundled plugins under whatever the user installed.
 *
 * Name collisions resolve to the **installed** one, in full: its commands, its
 * problems, its preferences. That is what makes a bundled plugin a default
 * rather than a fixture — somebody who wants file search to work differently
 * writes their own `files` plugin, installs it, and ours steps aside without a
 * flag to find or a setting to know about.
 *
 * The bundled one is dropped entirely rather than merged command-by-command. A
 * half-and-half index would run two authors' code under one name, and the first
 * time their command lists differed the user would be looking at a plugin that
 * exists nowhere on disk.
 */
export function mergeIndexes(installed: ExtensionIndex, bundled: ExtensionIndex): ExtensionIndex {
  const taken = new Set(installed.extensions.map((extension) => extension.manifest.name))
  const kept = bundled.extensions.filter((extension) => !taken.has(extension.manifest.name))
  const keptNames = new Set(kept.map((extension) => extension.manifest.name))

  return {
    extensions: [...installed.extensions, ...kept],
    commands: [
      ...installed.commands,
      ...bundled.commands.filter((command) => keptNames.has(command.extension.manifest.name))
    ],
    problems: [
      ...installed.problems,
      ...bundled.problems.filter((problem) => !taken.has(problem.name))
    ]
  }
}

/**
 * Extension commands as root rows.
 *
 * They go through the *same* scoring as the launcher's own commands — one list,
 * one relative cutoff, one order — because a root that ranked extensions
 * separately would show a weak extension match above a strong application one
 * purely for being the best of its kind. That was the M3 lesson with built-in
 * commands (`root-search.ts` §"ranked together") and it does not stop applying
 * because the command came from somewhere else.
 *
 * The subtitle names the extension, which is what makes two extensions' "Search"
 * commands tellable apart.
 */
export function extensionRootCommands(
  index: ExtensionIndex,
  /**
   * Which commands the user has switched off (`[extensions].disabled`).
   *
   * Filtered here rather than in `scanExtensions` on purpose: a disabled command
   * is still *installed*, and the store screen has to list it in order to offer
   * turning it back on. Only the root list hides it.
   */
  isEnabled: (commandId: string) => boolean = () => true
): readonly RootCommand[] {
  return index.commands
    .filter((command) => isEnabled(command.id))
    // `lumanin.root: false` — a command that is its own surface rather than a
    // row here. Filtered at the source, so it is absent from the ranking, from
    // pins (they resolve against this list), and from aliases alike.
    .filter((command) => command.spec.root)
    .map((command) => ({
      id: command.id,
      title: command.spec.title,
      subtitle: command.spec.subtitle ?? command.extension.manifest.title,
      keywords: [
        ...command.spec.keywords,
        ...command.extension.manifest.keywords,
        command.extension.manifest.title
      ],
      kind: 'extension' as const,
      extensionTitle: command.extension.manifest.title,
      categories: command.spec.categories,
      ...commandIcon(command)
    }))
}

/**
 * A command's icon as the root list draws it: a `lumanin-icon:` URL the renderer
 * can put in an `<img>`, never a filesystem path (SECURITY.md §Renderer).
 *
 * The manifest `icon` (command first, then the extension's) is one of three
 * forms, and the form decides both where the image comes from and whether the
 * search mark goes over it:
 *
 * - `search:<name>[,<fallback>…]` — the desktop's own icon for the application
 *   the plugin fronts, resolved from the icon theme, with the three-dot search
 *   mark drawn over it. What an app-connected "Search X" command declares: the
 *   row is Godot's face plus the mark that says "a search of it, not it".
 * - `system:<name>[,<fallback>…]` — a theme icon with no mark.
 * - anything else — a file in the extension's `assets/`, badge-free. What a
 *   standalone plugin ships as its own identity.
 *
 * An icon the theme cannot resolve 404s at the protocol and the renderer falls
 * back to the row glyph — the row an uninstalled app leaves behind is the plain
 * chevron, never a broken image.
 */
function commandIcon(command: InstalledCommand): { icon?: string; badge?: 'search' } {
  const raw = command.spec.icon ?? command.extension.manifest.icon
  if (raw === undefined || raw.length === 0) return {}
  if (raw.startsWith('search:')) {
    return { icon: themeIconUrl(raw.slice('search:'.length)), badge: 'search' }
  }
  if (raw.startsWith('system:')) return { icon: themeIconUrl(raw.slice('system:'.length)) }
  return {
    icon: `${ICON_SCHEME}://ext/${encodeURIComponent(command.extension.manifest.name)}/${raw
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')}`
  }
}

function themeIconUrl(names: string): string {
  return `${ICON_SCHEME}://theme/${encodeURIComponent(names)}`
}

/**
 * Resolve a command's preferences: manifest defaults, then what the user set.
 *
 * Command preferences shadow extension ones of the same name, which is the
 * spec's own precedence — `getPreferenceValues()` inside a command sees one flat
 * object, and the more specific declaration is the one that should win.
 */
export function resolvePreferences(
  command: InstalledCommand,
  stored: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const values: Record<string, unknown> = {}

  const apply = (specs: readonly PreferenceSpec[]): void => {
    for (const spec of specs) {
      if (spec.default !== undefined) values[spec.name] = spec.default
      // A checkbox with no default is `false`, not `undefined`: extensions write
      // `if (prefs.showDetail)` and an absent value would read the same as off
      // anyway — but `Boolean` is what the type says, and a shim that returns
      // `undefined` where a boolean is declared is a lie the compiler cannot see.
      else if (spec.type === 'checkbox') values[spec.name] = false
    }
  }

  apply(command.extension.manifest.preferences)
  apply(command.spec.preferences)

  for (const [key, value] of Object.entries(stored)) {
    if (value !== undefined) values[key] = value
  }
  return values
}

/** Every preference a command can be configured with, in declaration order. */
export function preferenceSpecs(command: InstalledCommand): readonly PreferenceSpec[] {
  const seen = new Set<string>()
  const specs: PreferenceSpec[] = []
  for (const spec of [...command.extension.manifest.preferences, ...command.spec.preferences]) {
    if (seen.has(spec.name)) continue
    seen.add(spec.name)
    specs.push(spec)
  }
  return specs
}

/**
 * Preferences that are `required` and still unset.
 *
 * Raycast blocks a command until these are filled in, and RAYCAST-COMPAT asks us
 * to mirror that. Running anyway is worse than it sounds: an extension whose
 * required API key is missing does not fail cleanly, it makes an unauthenticated
 * request and shows the user an error from someone else's server.
 */
export function missingRequiredPreferences(
  command: InstalledCommand,
  values: Readonly<Record<string, unknown>>
): readonly PreferenceSpec[] {
  return preferenceSpecs(command).filter((spec) => {
    if (!spec.required) return false
    const value = values[spec.name]
    return value === undefined || value === null || value === ''
  })
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

function exists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
