/**
 * The extension manifest — Raycast's `package.json` fields.
 *
 * Parsed here rather than in main because three places need it and none of them
 * should re-derive it: main (to list commands at the root), the host (to launch
 * one), and the build path (to know what to compile). Pure and renderer-safe:
 * reading the file is the caller's job, understanding it is this file's.
 *
 * The field list is RAYCAST-COMPAT.md §Manifest, which is itself checked against
 * developers.raycast.com. Unknown fields are **preserved, never rejected** — the
 * manifest is a third party's document that gains fields on Raycast's schedule,
 * and refusing to load an extension over a field we have not heard of is the one
 * failure mode with no workaround for the user.
 */

export type CommandMode = 'view' | 'no-view' | 'menu-bar'

export const PREFERENCE_TYPES = [
  'textfield',
  'password',
  'checkbox',
  'dropdown',
  'appPicker',
  'file',
  'directory'
] as const
export type PreferenceType = (typeof PREFERENCE_TYPES)[number]

export interface PreferenceSpec {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly type: PreferenceType
  readonly required: boolean
  readonly placeholder?: string
  /** Checkbox label; the manifest's `label`. */
  readonly label?: string
  readonly data?: readonly { readonly title: string; readonly value: string }[]
  readonly default?: string | number | boolean
}

export interface CommandArgumentSpec {
  readonly name: string
  readonly type: 'text' | 'password' | 'dropdown'
  readonly placeholder: string
  readonly required: boolean
  readonly data?: readonly { readonly title: string; readonly value: string }[]
}

/**
 * A category a command's view is divided into — Logins, Friends, Timers.
 *
 * Ours, not the spec's: declared under the command entry's `lumanin` namespace
 * so `ray` tooling ignores it. Declared statically so the config can list a
 * plugin's categories without running its code; at launch the chosen category
 * arrives in `LaunchProps.launchContext.category` and the command's dropdown is
 * expected to start there.
 */
export interface CommandCategorySpec {
  /** `^[a-z0-9-]+$` — the charset is what keeps pin keys parseable. */
  readonly id: string
  readonly title: string
}

export interface CommandSpec {
  /** Also the entry file's basename: `name: "search"` → `src/search.{ts,tsx,js,jsx}`. */
  readonly name: string
  readonly title: string
  readonly subtitle?: string
  readonly description?: string
  readonly icon?: string
  readonly mode: CommandMode
  readonly keywords: readonly string[]
  readonly interval?: string
  readonly disabledByDefault: boolean
  readonly arguments: readonly CommandArgumentSpec[]
  readonly preferences: readonly PreferenceSpec[]
  /** From `commands[].lumanin.categories`. Empty when the command declares none. */
  readonly categories: readonly CommandCategorySpec[]
  /**
   * Whether this command is reachable from the root list. `commands[].lumanin.root`.
   *
   * True for everything anyone writes — a plugin exists to be found by typing
   * its name. The exception it was added for is Search Files, which is a search
   * surface of its own with a key of its own: a filesystem is neither small
   * enough to rank against your applications nor fast enough to re-scan per
   * keystroke, so mixing it into the root is how a root list starts to stutter.
   *
   * `false` means *nothing at the root*: no row, no pin, no alias, no place in
   * the pin browser. It does not mean hidden — `lumanin open extension:<id>` and
   * a key bound to it work exactly as before, and that is how such a command is
   * meant to be reached.
   */
  readonly root: boolean
}

export interface ToolSpec {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly icon?: string
}

export interface Manifest {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly icon?: string
  readonly author: string
  readonly owner?: string
  readonly categories: readonly string[]
  /**
   * `"macOS" | "Windows"` only — **`"Linux"` is not a legal value**, so an absent
   * or macOS-only field says nothing about us either way. RAYCAST-COMPAT.md
   * §"Signal 1" is explicit that we must never warn merely because a field cannot
   * contain a value that does not exist.
   */
  readonly platforms: readonly string[]
  readonly commands: readonly CommandSpec[]
  readonly tools: readonly ToolSpec[]
  readonly preferences: readonly PreferenceSpec[]
  /** Modules esbuild must not bundle; they resolve from the extension's own `node_modules`. */
  readonly external: readonly string[]
  readonly keywords: readonly string[]
  /** Our own optional namespace, for Linux hints that `ray` tooling ignores. */
  readonly lumanin: Readonly<Record<string, unknown>>
}

export interface ManifestParse {
  readonly manifest: Manifest | null
  /** Why it could not be read. Empty when `manifest` is non-null. */
  readonly problems: readonly string[]
}

/**
 * Parse a `package.json` into a manifest.
 *
 * Two classes of outcome, kept distinct on purpose: a *problem* that leaves
 * `manifest` null means the extension cannot be loaded at all (no name, no
 * commands); anything softer is repaired with a documented default. An extension
 * with one malformed command still offers its other five.
 */
export function parseManifest(raw: unknown): ManifestParse {
  const problems: string[] = []
  if (typeof raw !== 'object' || raw === null) {
    return { manifest: null, problems: ['package.json is not an object'] }
  }
  const pkg = raw as Record<string, unknown>

  const name = str(pkg['name'])
  if (name === null) return { manifest: null, problems: ['package.json has no "name"'] }

  const rawCommands = Array.isArray(pkg['commands']) ? pkg['commands'] : []
  const commands: CommandSpec[] = []
  for (const [index, entry] of rawCommands.entries()) {
    const command = parseCommand(entry, problems, index)
    if (command !== null) commands.push(command)
  }
  if (commands.length === 0) {
    // Not a judgement call: an extension with no runnable command has nothing to
    // put at the root, so loading it would add an entry that cannot be activated.
    return { manifest: null, problems: [...problems, `"${name}" declares no usable commands`] }
  }

  return {
    manifest: {
      name,
      title: str(pkg['title']) ?? name,
      description: str(pkg['description']) ?? '',
      ...optional('icon', str(pkg['icon'])),
      author: str(pkg['author']) ?? '',
      ...optional('owner', str(pkg['owner'])),
      categories: strings(pkg['categories']),
      platforms: strings(pkg['platforms']),
      commands,
      tools: parseTools(pkg['tools']),
      preferences: parsePreferences(pkg['preferences'], problems, name),
      external: strings(pkg['external']),
      keywords: strings(pkg['keywords']),
      lumanin: typeof pkg['lumanin'] === 'object' && pkg['lumanin'] !== null
        ? (pkg['lumanin'] as Record<string, unknown>)
        : {}
    },
    problems
  }
}

function parseCommand(raw: unknown, problems: string[], index: number): CommandSpec | null {
  if (typeof raw !== 'object' || raw === null) {
    problems.push(`commands[${index}] is not an object`)
    return null
  }
  const entry = raw as Record<string, unknown>
  const name = str(entry['name'])
  if (name === null) {
    problems.push(`commands[${index}] has no "name"`)
    return null
  }

  const mode = str(entry['mode'])
  if (mode !== 'view' && mode !== 'no-view' && mode !== 'menu-bar') {
    // `mode` decides whether the command renders or just runs, so guessing is
    // worse than declining this one command.
    problems.push(`command "${name}" has an unknown mode: ${String(entry['mode'])}`)
    return null
  }

  return {
    name,
    title: str(entry['title']) ?? name,
    ...optional('subtitle', str(entry['subtitle'])),
    ...optional('description', str(entry['description'])),
    ...optional('icon', str(entry['icon'])),
    ...optional('interval', str(entry['interval'])),
    mode,
    keywords: strings(entry['keywords']),
    disabledByDefault: entry['disabledByDefault'] === true,
    arguments: parseArguments(entry['arguments']),
    preferences: parsePreferences(entry['preferences'], problems, name),
    categories: parseCategories(entry['lumanin'], problems, name),
    // Opt-*out*, and only the exact literal counts: a manifest that says nothing
    // — every manifest anyone else writes — is a command at the root.
    root: lumaninField(entry['lumanin'], 'root') !== false
  }
}

/** One key out of a command's `lumanin` namespace, without trusting its shape. */
function lumaninField(raw: unknown, key: string): unknown {
  if (typeof raw !== 'object' || raw === null) return undefined
  return (raw as Record<string, unknown>)[key]
}

/** The id charset is load-bearing: it is what makes `extension:…#<id>:<item>` parseable. */
const CATEGORY_ID = /^[a-z0-9-]+$/

function parseCategories(raw: unknown, problems: string[], owner: string): CommandCategorySpec[] {
  if (typeof raw !== 'object' || raw === null) return []
  const list = (raw as Record<string, unknown>)['categories']
  if (!Array.isArray(list)) return []

  const parsed: CommandCategorySpec[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = str(record['id'])
    if (id === null) continue
    if (!CATEGORY_ID.test(id)) {
      problems.push(
        `category "${id}" of "${owner}" is not lowercase letters, digits and dashes, so it was dropped`
      )
      continue
    }
    parsed.push({ id, title: str(record['title']) ?? id })
  }
  return parsed
}

function parseArguments(raw: unknown): CommandArgumentSpec[] {
  if (!Array.isArray(raw)) return []
  const parsed: CommandArgumentSpec[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const name = str(record['name'])
    if (name === null) continue
    const type = str(record['type'])
    parsed.push({
      name,
      type: type === 'password' || type === 'dropdown' ? type : 'text',
      placeholder: str(record['placeholder']) ?? name,
      required: record['required'] === true,
      ...optional('data', choices(record['data']))
    })
  }
  return parsed
}

function parsePreferences(raw: unknown, problems: string[], owner: string): PreferenceSpec[] {
  if (!Array.isArray(raw)) return []
  const parsed: PreferenceSpec[] = []

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const name = str(record['name'])
    if (name === null) continue

    const type = str(record['type']) ?? ''
    if (!(PREFERENCE_TYPES as readonly string[]).includes(type)) {
      problems.push(`preference "${name}" of "${owner}" has an unknown type: ${type}`)
      continue
    }

    parsed.push({
      name,
      ...optional('title', str(record['title'])),
      ...optional('description', str(record['description'])),
      type: type as PreferenceType,
      required: record['required'] === true,
      ...optional('placeholder', str(record['placeholder'])),
      ...optional('label', str(record['label'])),
      ...optional('data', choices(record['data'])),
      ...optional('default', defaultValue(record['default']))
    })
  }
  return parsed
}

function parseTools(raw: unknown): ToolSpec[] {
  if (!Array.isArray(raw)) return []
  const parsed: ToolSpec[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const name = str(record['name'])
    if (name === null) continue
    parsed.push({
      name,
      ...optional('title', str(record['title'])),
      ...optional('description', str(record['description'])),
      ...optional('icon', str(record['icon']))
    })
  }
  return parsed
}

/**
 * A preference default may be a **platform-keyed object** (`{macOS: …, Windows: …}`)
 * rather than a value. Neither key is ours, so such a default has no value for us
 * and is treated as absent — which is what "no default on this platform" means.
 */
function defaultValue(raw: unknown): string | number | boolean | null {
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw
  return null
}

function choices(raw: unknown): { title: string; value: string }[] | null {
  if (!Array.isArray(raw)) return null
  const parsed: { title: string; value: string }[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const value = str(record['value'])
    if (value === null) continue
    parsed.push({ title: str(record['title']) ?? value, value })
  }
  return parsed.length > 0 ? parsed : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Spread an optional field only when it has a value.
 *
 * `exactOptionalPropertyTypes` is on, so `{icon: undefined}` is not the same as
 * an absent `icon` — and the difference shows up as a type error at every
 * consumer rather than being silently tolerated.
 */
function optional<K extends string, V>(key: K, value: V | null): { [P in K]?: V } {
  return (value === null ? {} : { [key]: value }) as { [P in K]?: V }
}
