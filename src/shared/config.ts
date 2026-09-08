import { parse as parseToml, TomlError } from 'smol-toml'
import { DEFAULT_ENGINE_IDS, engineById } from './engines'
import { DEFAULT_PANEL_TOP_PERCENT } from './placement'
import {
  DEFAULT_KEYS,
  KEY_ACTIONS,
  KEY_ACTION_INFO,
  keyConflicts,
  parseKeyChord,
  type KeyMap
} from './keys'
import type { Shortcut } from './shortcut'
import {
  completeFileOrder,
  DEFAULT_FILE_ORDER,
  FILE_CATEGORIES,
  type FileCategory
} from './files'
import { ENV_PREFIX } from './identity'
import { parseHotkey } from './hotkey'
import { normalizeSearchTemplate } from './websearch'

/**
 * `config.toml` loading and the precedence chain:
 *
 *     CLI flag → env var (LUMANIN_*) → config.toml → detected default
 *
 * Every resolved value carries the layer that produced it, because "I set that and
 * it didn't apply" is the most common configuration complaint in tools like this
 * and `lumanin doctor` is required to answer it. That provenance is the reason
 * this is a resolver rather than an `Object.assign` of defaults.
 *
 * The `[general]` and `[appearance]` keys the window needs are resolved here.
 * Sections not yet read by anything are preserved verbatim in `raw` and reported
 * as recognised-but-unused, so a later feature can adopt them without a migration.
 */

export type Layer = 'flag' | 'env' | 'file' | 'default'

export interface Resolved<T> {
  readonly value: T
  readonly layer: Layer
  /** Where the winning value came from, phrased for `doctor` output. */
  readonly origin: string
}

export const ESC_AT_ROOT_VALUES = ['hide', 'clear', 'none'] as const
export type EscAtRoot = (typeof ESC_AT_ROOT_VALUES)[number]

export const OPEN_ON_MONITOR_VALUES = ['cursor', 'focused', 'primary'] as const
export type OpenOnMonitor = (typeof OPEN_ON_MONITOR_VALUES)[number]

/**
 * The result groups the root search can produce, in the order the default
 * `fallback_order` lists them. Every value here is accepted; not every value
 * still fills anything — see `INERT_RESULT_GROUPS`. A config naming a group the
 * root cannot fill must not be an error, or a user's config breaks on the
 * release that moves one.
 *
 * `plugins` is first, and that is a decision rather than an accident of
 * alphabet. A plugin's view command is the *specific* answer to the query that
 * named it: typing "godot" with a Godot plugin installed means the projects
 * list far more often than it means the editor's own launcher. Ranked in with
 * the applications — which is where these rows lived until this group existed —
 * the application won on a prefix match every time, so reaching the plugin cost
 * an arrow key on every single use.
 */
export const RESULT_GROUPS = ['plugins', 'apps', 'commands', 'calculator', 'files', 'web'] as const
export type ResultGroup = (typeof RESULT_GROUPS)[number]

/**
 * The groups as the settings screens spell them. The lowercase ids stay what a
 * config file says; a list row is a label, and labels are capitalised.
 */
export const RESULT_GROUP_LABELS: Readonly<Record<ResultGroup, string>> = {
  plugins: 'Plugins',
  apps: 'Apps',
  commands: 'Commands',
  calculator: 'Calculator',
  files: 'Files',
  web: 'Web'
}


/**
 * Groups that are still accepted here but no longer answer to the order.
 *
 * Neither is a feature that was dropped. `files` moved: file search is a plugin
 * now (`plugins/files/`), reached as its own view rather than mixed into the
 * root, because a filesystem is neither small enough to rank against a few
 * thousand application names nor fast enough to re-scan on every keystroke.
 * `calculator` stopped being a position (user decision): a query
 * that is a calculation has exactly one right answer, so the row sits above
 * everything, always, and offering a lever to move it was offering a way to
 * make the launcher worse.
 *
 * Accepted rather than rejected because both were in the **default** order we
 * shipped: they are in configs that were never edited, so warning about them
 * would be warning people about a decision they never made. They simply do
 * nothing.
 */
export const INERT_RESULT_GROUPS: readonly ResultGroup[] = ['files', 'calculator']

/**
 * The groups worth *offering*, which is no longer all of them.
 *
 * `files` and `calculator` are still names a config may use — they were in the
 * default we shipped — but neither answers to its position: file search is a
 * plugin whose rows arrive in `plugins`, and the calculator always sits above
 * everything. Listing them in the settings menu meant offering the user a lever
 * attached to nothing, so the menu asks this rather than {@link RESULT_GROUPS}.
 * Reading a config still accepts both.
 */
export const OFFERED_RESULT_GROUPS: readonly ResultGroup[] = RESULT_GROUPS.filter(
  (group) => !INERT_RESULT_GROUPS.includes(group)
)

/** The order a config that says nothing gets. */
export const DEFAULT_RESULT_ORDER: readonly ResultGroup[] = RESULT_GROUPS.filter(
  (group) => !INERT_RESULT_GROUPS.includes(group)
)

export interface WebSearch {
  /**
   * Stable identity, independent of the URL: a catalog id (`google`) for a
   * built-in, the keyword for a user-defined one. This is what `[search].engines`
   * selects and what a pin names — the row's own id carries the built URL, which
   * changes with every keystroke and so can never identify anything.
   */
  readonly id: string
  /** Typed as the first word to target this search directly. */
  readonly keyword: string
  readonly name: string
  /** `{}` is replaced with the URL-encoded query. */
  readonly url: string
}

/**
 * A per-query exception: "when I type this, show exactly these, in this order".
 *
 * The ranking is a heuristic and heuristics are wrong sometimes; a rule is how a
 * user overrules one permanently for a query they type every day, without having
 * to accept a different ranking everywhere else.
 */
export interface SearchRule {
  /** The query this fires for. Case-insensitive; see `matchRule`. */
  readonly match: string
  /**
   * The rows it wants first, in order. These are *injected*, not merely
   * hoisted: a rule names things it wants shown whether or not the fuzzy matcher
   * would have found them, which is the entire point of an exception.
   *
   * The same entries a pin takes — a bare key, or an `{ id, title }` table —
   * because a rule may name anything a pin may, including one row of a plugin
   * or one action on it, and those carry a title that only exists while the
   * plugin runs.
   */
  readonly first: readonly PinEntry[]
  /** Overrides `[search].order` for this query only. `null` = leave it alone. */
  readonly order: readonly ResultGroup[] | null
}

/**
 * What a pin or a rule may name. A calculation is an answer, not a thing to pin.
 *
 * `extension` was missing until it was needed: an extension command's row id is
 * `extension:<ext>/<cmd>` — that is what `pinKeyOf` produces and what the pin
 * picker writes — so leaving it out meant every extension pin was dropped by the
 * validator below and silently never appeared.
 *
 * `shell` is a command line the user typed into the config themselves. It is the
 * one kind whose payload is not an id looked up somewhere: it is the thing to
 * run, which is why it is checked against this list again before anything is
 * spawned.
 */
const PINNABLE_KINDS = new Set(['app', 'command', 'web', 'extension', 'shell'])

/**
 * One pinned row.
 *
 * Most pins are a bare key and carry no title — the row's name resolves from
 * whatever the key points at. A pinned plugin *item* is the exception: it only
 * exists while its plugin is running, so the title is captured at pin time and
 * stored beside the key (`{ id = "extension:1password/search#logins:a1b2",
 * title = "GitHub" }` in the TOML), or the root list could not draw the row
 * without launching the plugin first.
 */
export interface PinEntry {
  readonly key: string
  readonly title: string | null
  /** The row's own face, kept at pin time as a URL the root can draw; `null` means the command's icon. */
  readonly icon: string | null
}

/**
 * `[[hotkeys]]` — a key bound straight to one target, compositor-side.
 *
 * The target is a pin key (`extension:1password/search#logins`, `app:…`), and
 * the bind becomes a real compositor bind running `lumanin open '<target>'` —
 * written with consent and a diff, exactly like the main hotkey. Which is why
 * targets containing a quote or a newline are rejected at parse: they would
 * otherwise be spliced into a config line.
 */
export interface HotkeyBinding {
  readonly bind: string
  readonly target: string
  /**
   * What to call the target, for the screens that list these.
   *
   * Same reason a pinned item stores one: a plugin item's name exists only
   * while its plugin runs, so a binding that points at one would otherwise be
   * listed by its raw id. Never used to launch anything.
   */
  readonly title: string | null
}

export interface ResolvedConfig {
  readonly general: {
    readonly hotkey: Resolved<string>
    readonly hideOnBlur: Resolved<boolean>
    readonly escAtRoot: Resolved<EscAtRoot>
    readonly openOnMonitor: Resolved<OpenOnMonitor>
    readonly width: Resolved<number>
    readonly height: Resolved<number>
    /** Where the panel's top edge sits, as a percentage of the screen height from the top. */
    readonly top: Resolved<number>
  }
  readonly appearance: {
    /** `null` means "use the resolution chain" rather than a forced theme. */
    readonly theme: Resolved<string | null>
    readonly followSystem: Resolved<boolean>
    readonly animations: Resolved<boolean>
    /** `null` means "follow the desktop's text size"; a number is a fixed factor. */
    readonly textScale: Resolved<number | null>
  }
  /**
   * `[file_search]`: the one plugin that is also a section of the settings.
   *
   * File search ships inside the application and is reached by a key of its own
   * rather than through the root list, which makes it the launcher's second
   * search surface rather than a
   * plugin the user happens to have. Both halves of it that a person wants to
   * change are here: the key that opens it, and the order its results come back
   * in.
   */
  readonly fileSearch: {
    /** `[file_search].hotkey`. Empty string means "no bind". */
    readonly hotkey: Resolved<string>
    /** `[file_search].order`: the categories, first to last. Always complete. */
    readonly order: Resolved<readonly FileCategory[]>
    /** `[file_search].hide_on_open`: close the panel when a file is handed off. */
    readonly hideOnOpen: Resolved<boolean>
  }
  readonly search: {
    /** `[search].order`, still readable as `fallback_order`. */
    readonly fallbackOrder: Resolved<readonly ResultGroup[]>
    readonly frecencyWeight: Resolved<number>
    /** The enabled searches: catalog picks from `engines`, then `web_searches`. */
    readonly webSearches: Resolved<readonly WebSearch[]>
    /** Pins (`app:firefox.desktop`), in the order the user put them. */
    readonly pins: Resolved<readonly PinEntry[]>
    readonly rules: Resolved<readonly SearchRule[]>
  }
  /** `[[hotkeys]]`: extra global binds, each opening one target. */
  readonly hotkeys: Resolved<readonly HotkeyBinding[]>
  /**
   * `[keys]`: the panel's own keys, while its window has focus.
   *
   * A different thing from `[general].hotkey` and from `[[hotkeys]]`, and the
   * difference is who has to agree with us. Those two are chords in *someone
   * else's* config — a compositor's, kglobalaccel's, dconf's — so setting one
   * means writing a file we do not own and reporting honestly whether the write
   * happened. These are ours end to end: the window has focus, the renderer
   * reads the event, and a change takes effect on the next keystroke with
   * nothing to install and nobody to ask.
   */
  readonly keys: Resolved<KeyMap>
  /**
   * `[aliases]`: typed alias → target. A whole section of user-chosen keys
   * rather than a fixed set, so it is resolved as one value with one origin.
   *
   * The value is a {@link PinEntry} because an alias may point as deep as a pin
   * may — `god = "extension:godot/search#project:dawnline!Open Project"` — and
   * anything below the command level needs the stored title for the same reason
   * a pin does. A plain `ff = "firefox.desktop"` resolves to a title-less entry,
   * which is every alias written before this and the common case still.
   */
  readonly aliases: Resolved<Readonly<Record<string, PinEntry>>>
  readonly extensions: {
    /**
     * `[extensions].disabled`: extension names and `<extension>/<command>` ids
     * that are installed but should not appear.
     *
     * A list rather than a per-extension `enabled = false` table because the
     * common case is that it is empty, and an empty list writes as one absent
     * key rather than as a section per extension that says nothing.
     */
    readonly disabled: Resolved<readonly string[]>
  }
  /** The parsed file, kept whole so a future writer can round-trip unknown keys. */
  readonly raw: Readonly<Record<string, unknown>>
  /** Keys in the file that belong to no section we know about. */
  readonly unrecognized: readonly string[]
  /** Non-fatal problems. The app always starts; `doctor` surfaces these. */
  readonly problems: readonly string[]
}

/** The sections `config.toml` may contain, whether or not anything reads them yet. */
const KNOWN_SECTIONS = new Set([
  'general',
  'appearance',
  'search',
  'file_search',
  'aliases',
  'hotkeys',
  'keys',
  'clipboard',
  'extensions',
  'platform'
])

export interface LoadOptions {
  /**
   * The environment to read `LUMANIN_*` overrides from. Required rather than
   * defaulted to `process.env` because `src/shared` is renderer-safe by
   * construction and must not reference Node globals — see `src/node/` for the
   * modules that may.
   */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Raw `config.toml` contents, or `null` when the file does not exist. */
  readonly fileContents?: string | null
  /** Why the file could not be read, when it exists but could not be; reported, not swallowed. */
  readonly readProblem?: string | null
  /** Values from parsed CLI flags; highest precedence. */
  readonly flags?: Readonly<Record<string, string | undefined>>
}

type ConfigSection = 'general' | 'appearance' | 'search' | 'file_search'

interface Sources<T> {
  readonly flagKey?: string
  readonly envKey: string
  readonly section: ConfigSection
  /**
   * The key in that section. A list accepts more than one spelling, first match
   * winning — which is how `order` supersedes `fallback_order` without breaking
   * a config someone already wrote.
   */
  readonly fileKey: string | readonly string[]
  /**
   * Where this setting used to live, read only when the current key is absent.
   *
   * A key that moves between sections is not a rename we can do with `fileKey`:
   * the section is part of the address. Written down rather than dropped,
   * because a config file is something a person edited by hand and a setting
   * that silently reverts to its default is worse than one that refuses to load.
   */
  readonly movedFrom?: { readonly section: ConfigSection; readonly fileKey: string }
  readonly fallback: T
  /** Returns `undefined` when the input is not a valid value for this setting. */
  readonly coerce: (raw: unknown) => T | undefined
}

class Resolver {
  private readonly problems: string[] = []

  constructor(
    private readonly file: Record<string, unknown>,
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly flags: Readonly<Record<string, string | undefined>>
  ) {}

  get collectedProblems(): readonly string[] {
    return this.problems
  }

  resolve<T>(s: Sources<T>): Resolved<T> {
    const envKey = `${ENV_PREFIX}${s.envKey}`

    if (s.flagKey !== undefined) {
      const raw = this.flags[s.flagKey]
      if (raw !== undefined) {
        const value = s.coerce(raw)
        if (value !== undefined) return { value, layer: 'flag', origin: `--${s.flagKey}` }
        this.problems.push(`--${s.flagKey}: ignored invalid value ${JSON.stringify(raw)}`)
      }
    }

    const fromEnv = this.env[envKey]
    if (fromEnv !== undefined) {
      const value = s.coerce(fromEnv)
      if (value !== undefined) return { value, layer: 'env', origin: envKey }
      this.problems.push(`${envKey}: ignored invalid value ${JSON.stringify(fromEnv)}`)
    }

    const addresses: readonly { section: ConfigSection; fileKey: string }[] = [
      ...(typeof s.fileKey === 'string' ? [s.fileKey] : s.fileKey).map((fileKey) => ({
        section: s.section,
        fileKey
      })),
      ...(s.movedFrom === undefined ? [] : [s.movedFrom])
    ]

    for (const address of addresses) {
      const section = this.file[address.section]
      if (typeof section !== 'object' || section === null) continue
      const raw = (section as Record<string, unknown>)[address.fileKey]
      if (raw === undefined) continue

      const value = s.coerce(raw)
      if (value !== undefined) {
        return {
          value,
          layer: 'file',
          origin: `config.toml [${address.section}].${address.fileKey}`
        }
      }
      this.problems.push(
        `config.toml [${address.section}].${address.fileKey}: ignored invalid value ${JSON.stringify(raw)}`
      )
    }

    return { value: s.fallback, layer: 'default', origin: 'built-in default' }
  }
}

function asBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  return undefined
}

/**
 * Window dimensions are clamped rather than merely type-checked: a 0×0 or
 * 40000px window is a valid integer and an unusable app.
 */
function asDimension(min: number, max: number): (raw: unknown) => number | undefined {
  return (raw) => {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
    if (n < min || n > max) return undefined
    return n
  }
}

/** A positive multiplier, fractional allowed - `1.25`, `"1.5"`. */
function asFactor(min: number, max: number): (raw: unknown) => number | undefined {
  return (raw) => {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    if (!Number.isFinite(n) || n < min || n > max) return undefined
    return n
  }
}

function asNonEmptyString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

/** A chord `parseHotkey` accepts, returned unchanged; a typo is reported, not written. */
function asHotkey(raw: unknown): string | undefined {
  return typeof raw === 'string' && parseHotkey(raw) !== null ? raw : undefined
}

/**
 * The empty string, or a chord `parseHotkey` accepts. Empty is a value here
 * rather than an absence: `hotkey = ""` means "do not bind one", and it has to
 * be distinguishable from the key not being in the file at all, which takes
 * the default.
 */
function asOptionalHotkey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  return raw.trim().length === 0 || parseHotkey(raw) !== null ? raw : undefined
}

function asEnum<T extends string>(allowed: readonly T[]): (raw: unknown) => T | undefined {
  return (raw) => (typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined)
}

function asUnitInterval(raw: unknown): number | undefined {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
}

/**
 * The ordered group list. Unknown names are dropped rather than rejecting the
 * whole list: a config written against a later version that names a group we do
 * not have yet should lose that entry, not its ordering.
 */
function asGroupOrder(raw: unknown): readonly ResultGroup[] | undefined {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',').map((part) => part.trim())
      : undefined
  if (parts === undefined) return undefined

  const groups = parts.filter((part): part is ResultGroup =>
    (RESULT_GROUPS as readonly unknown[]).includes(part)
  )
  return groups.length === 0 ? undefined : [...new Set(groups)]
}

/**
 * `[file_search].order`: the categories, first to last.
 *
 * Always completed rather than taken literally — {@link completeFileOrder} —
 * because unlike `[search].order` there is no "off" here. Every file is in
 * exactly one category, so a category left out of the list still has to sort
 * somewhere, and appending it is the only answer that does not hide files.
 */
function asFileOrder(raw: unknown): readonly FileCategory[] | undefined {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',').map((part) => part.trim())
      : undefined
  if (parts === undefined) return undefined

  const listed = parts.filter((part): part is string => typeof part === 'string')
  const order = completeFileOrder(listed)
  // Nothing recognised is a typo, not an order — better to say so and use the
  // default than to answer "images, videos, …" to a list that said none of that.
  return listed.some((part) => (FILE_CATEGORIES as readonly string[]).includes(part))
    ? order
    : undefined
}

/**
 * `web_searches`. Every entry is validated whole; a malformed one is dropped and
 * the rest kept, because losing every search over one typo is a worse answer
 * than losing the typo'd one.
 *
 * The URL must be `https:` (or `http:`, grudgingly). This is the one config
 * value that becomes a URL we hand to the system opener, and a `file:` or
 * `javascript:` template there would make a search keyword into a way to open
 * anything on the machine.
 */
function asWebSearches(raw: unknown): readonly WebSearch[] | undefined {
  if (!Array.isArray(raw)) return undefined

  const searches: WebSearch[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, keyword, name, url } = entry as Record<string, unknown>
    if (typeof keyword !== 'string' || typeof name !== 'string' || typeof url !== 'string') continue
    if (keyword.length === 0 || /\s/.test(keyword)) continue
    // Normalised rather than merely validated, so `url = "raycast.com"` in a
    // hand-written file means what it obviously means. The scheme check has not
    // gone anywhere — it lives in `normalizeSearchTemplate`, which returns null
    // for anything that is not http(s).
    const template = normalizeSearchTemplate(url)
    if (template === null) continue
    searches.push({
      id: typeof id === 'string' && id.length > 0 ? id : keyword,
      keyword,
      name,
      url: template
    })
  }
  return searches
}

/** A list of strings from either a TOML array or a comma-separated env var. */
function asStringList(raw: unknown): readonly string[] | undefined {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : undefined
  if (parts === undefined) return undefined

  return parts
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/**
 * A pin key: `<kind>:<payload>`, where the kind is one we can actually resolve.
 *
 * Validated here rather than at use so that a typo shows up in `doctor` as a
 * rejected line, instead of as a pin that silently never appears.
 */
export function isPinKey(raw: string): boolean {
  const separator = raw.indexOf(':')
  if (separator <= 0 || separator === raw.length - 1) return false
  return PINNABLE_KINDS.has(raw.slice(0, separator))
}

/**
 * A list of pin entries: each one a bare key, or a table carrying the title a
 * plugin row was named under. Anything else is dropped by name through
 * `report`, so a typo'd table costs one entry rather than the whole list.
 *
 * Shared by `[search].pins` and a rule's `first`, which are the same thing with
 * different scope — a rule may name anything a pin may.
 */
export function pinEntriesOf(raw: unknown, report: (message: string) => void = () => {}): PinEntry[] {
  if (!Array.isArray(raw)) return []

  const entries: PinEntry[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const key = entry.trim()
      if (key.length > 0) entries.push({ key, title: null, icon: null })
      continue
    }
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      const { id, title, icon } = entry as Record<string, unknown>
      if (typeof id === 'string' && id.trim().length > 0) {
        entries.push({
          key: id.trim(),
          title: typeof title === 'string' && title.length > 0 ? title : null,
          icon: typeof icon === 'string' && icon.length > 0 ? icon : null
        })
        continue
      }
    }
    report('dropped an entry that is neither a key nor an { id, title } table')
  }
  return entries
}

/**
 * The pieces of an `extension:` pin payload that names a category, an item, or
 * one action on an item:
 *
 *     <extension>/<command>#<category>                    a category
 *     <extension>/<command>#<category>:<itemId>           one item in it
 *     <extension>/<command>#<category>:<itemId>!<Action>  one action on that item
 *
 * The first `:` after the `#` is the delimiter, which is safe because category
 * ids are `[a-z0-9-]+` by manifest contract — the item id after it may contain
 * anything. Returns `null` for a payload with no fragment (a plain command
 * pin), which callers treat as "not one of these".
 *
 * An action is named by its **title**, because that is the only stable identity
 * an action has: the spec's `Action` takes no id, and its handler id is minted
 * per render. The split is at the **last** `!` rather than the first, which is
 * the choice that costs least: item ids come from a plugin's own data and can
 * contain anything, while an action title is a label a person wrote. The picker
 * refuses to write an action whose title contains `!`, so every key we generate
 * parses back unambiguously.
 */
export function parseExtensionPin(payload: string): {
  commandId: string
  category: string
  item: string | null
  action: string | null
} | null {
  const hash = payload.indexOf('#')
  if (hash <= 0 || hash === payload.length - 1) return null
  const commandId = payload.slice(0, hash)

  let rest = payload.slice(hash + 1)
  let action: string | null = null
  const bang = rest.lastIndexOf('!')
  if (bang !== -1) {
    action = rest.slice(bang + 1)
    rest = rest.slice(0, bang)
    if (action.length === 0 || rest.length === 0) return null
  }

  const colon = rest.indexOf(':')
  // An action belongs to a row, so a key naming one without an item is not a
  // key we can act on — better rejected here than resolved into a launch that
  // silently does nothing.
  if (colon === -1) return action === null ? { commandId, category: rest, item: null, action } : null
  const category = rest.slice(0, colon)
  const item = rest.slice(colon + 1)
  // An empty *category* is legal and means "this command declares none" —
  // `extension:units/list#:nginx.service`. An empty item is not: there would be
  // no row for the key to name.
  if (item.length === 0) return null
  return { commandId, category, item, action }
}

/**
 * The enabled searches, assembled from two keys that mean different things:
 * `engines` picks from the built-in catalog, `web_searches` adds ones we do not
 * ship. Setting *either* replaces the default selection — a config that lists
 * only its own searches gets exactly those, which is what it meant before this
 * key existed and must keep meaning.
 */
function searchesFrom(
  file: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
  problems: string[]
): Resolved<readonly WebSearch[]> {
  const pick = (ids: readonly string[], origin: string): readonly WebSearch[] => {
    const picked: WebSearch[] = []
    for (const id of ids) {
      const engine = engineById(id)
      if (engine === undefined) {
        problems.push(`${origin}: no built-in search engine called ${JSON.stringify(id)}`)
        continue
      }
      picked.push(engine)
    }
    return picked
  }

  const envKey = `${ENV_PREFIX}ENGINES`
  const fromEnv = env[envKey]
  if (fromEnv !== undefined) {
    const ids = asStringList(fromEnv) ?? []
    return { value: dedupeById(pick(ids, envKey)), layer: 'env', origin: envKey }
  }

  const section = file['search']
  const search = typeof section === 'object' && section !== null ? (section as Record<string, unknown>) : {}
  const ids = search['engines']
  const custom = search['web_searches']

  if (ids === undefined && custom === undefined) {
    return {
      value: dedupeById(pick(DEFAULT_ENGINE_IDS, 'built-in default')),
      layer: 'default',
      origin: 'built-in default'
    }
  }

  const chosen: WebSearch[] = []
  const origins: string[] = []

  if (ids !== undefined) {
    const list = asStringList(ids)
    if (list === undefined) {
      problems.push('config.toml [search].engines: ignored, expected a list of engine ids')
    } else {
      chosen.push(...pick(list, 'config.toml [search].engines'))
      origins.push('[search].engines')
    }
  }

  if (custom !== undefined) {
    const parsed = asWebSearches(custom)
    if (parsed === undefined) {
      problems.push('config.toml [search].web_searches: ignored, expected a list of tables')
    } else {
      if (parsed.length !== (custom as unknown[]).length) {
        problems.push(
          'config.toml [search].web_searches: dropped entries that were not an http(s) template containing {}'
        )
      }
      chosen.push(...parsed)
      origins.push('[search].web_searches')
    }
  }

  const value = dedupeById(chosen)
  if (value.length === 0) {
    // Legal, and worth saying out loud: with no engines enabled the root list
    // has no search row at all, which is a surprising thing to arrive at by
    // accident and a reasonable thing to ask for on purpose.
    problems.push('config.toml [search]: no usable search engines, so no web search will be offered')
  }

  return {
    value,
    layer: 'file',
    origin: origins.length === 0 ? 'config.toml [search]' : `config.toml ${origins.join(' + ')}`
  }
}

/** First id wins, so `engines` order is preserved and a duplicate is not a row twice. */
function dedupeById(searches: readonly WebSearch[]): readonly WebSearch[] {
  const byId = new Map<string, WebSearch>()
  for (const search of searches) if (!byId.has(search.id)) byId.set(search.id, search)
  return [...byId.values()]
}

/**
 * `[search].pins`. Order matters and is the user's, so this keeps it verbatim
 * apart from removing duplicates.
 */
function pinsFrom(
  file: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
  problems: string[]
): Resolved<readonly PinEntry[]> {
  const clean = (list: readonly PinEntry[], origin: string): readonly PinEntry[] => {
    const seen = new Set<string>()
    return list.filter((entry) => {
      if (!isPinKey(entry.key)) {
        problems.push(`${origin}: ignored pin ${JSON.stringify(entry.key)}, not a <kind>:<id> key`)
        return false
      }
      if (seen.has(entry.key)) return false
      seen.add(entry.key)
      return true
    })
  }

  const parseEntries = (raw: readonly unknown[], origin: string): readonly PinEntry[] =>
    pinEntriesOf(raw, (message) => problems.push(`${origin}: ${message}`))

  const envKey = `${ENV_PREFIX}PINS`
  const fromEnv = env[envKey]
  if (fromEnv !== undefined) {
    const keys = (asStringList(fromEnv) ?? []).map((key) => ({ key, title: null, icon: null }))
    return { value: clean(keys, envKey), layer: 'env', origin: envKey }
  }

  const section = file['search']
  const raw =
    typeof section === 'object' && section !== null
      ? (section as Record<string, unknown>)['pins']
      : undefined
  if (raw === undefined) return { value: [], layer: 'default', origin: 'built-in default' }

  if (!Array.isArray(raw)) {
    problems.push('config.toml [search].pins: ignored, expected a list of pin keys')
    return { value: [], layer: 'default', origin: 'built-in default' }
  }

  return {
    value: clean(parseEntries(raw, 'config.toml [search].pins'), 'config.toml [search].pins'),
    layer: 'file',
    origin: 'config.toml [search].pins'
  }
}

/**
 * `[[hotkeys]]`. A malformed binding is dropped, not fatal, same policy as
 * every other list here. The quote/newline rejection is the security-relevant
 * part — see {@link HotkeyBinding}.
 */
function hotkeysFrom(
  file: Record<string, unknown>,
  problems: string[]
): Resolved<readonly HotkeyBinding[]> {
  const none: Resolved<readonly HotkeyBinding[]> = {
    value: [],
    layer: 'default',
    origin: 'built-in default'
  }

  const raw = file['hotkeys']
  if (raw === undefined) return none
  if (!Array.isArray(raw)) {
    problems.push('config.toml [[hotkeys]]: ignored, expected a list of { bind, target } tables')
    return none
  }

  const bindings: HotkeyBinding[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const { bind, target, title } = entry as Record<string, unknown>
    if (typeof bind !== 'string' || bind.trim().length === 0) {
      problems.push('config.toml [[hotkeys]]: dropped a binding with no `bind`')
      continue
    }
    if (parseHotkey(bind) === null) {
      problems.push(
        `config.toml [[hotkeys]] bind = ${JSON.stringify(bind)}: dropped, that is not a key combination this can write`
      )
      continue
    }
    if (typeof target !== 'string' || !isPinKey(target)) {
      problems.push(
        `config.toml [[hotkeys]] bind = ${JSON.stringify(bind)}: dropped, target is not a <kind>:<id> key`
      )
      continue
    }
    if (/['\n\r]/.test(target)) {
      problems.push(
        `config.toml [[hotkeys]] bind = ${JSON.stringify(bind)}: dropped, the target contains a quote or a newline`
      )
      continue
    }
    bindings.push({
      bind: bind.trim(),
      target,
      // The title is spliced into compositor config lines (a `bindd` label, a
      // KConfig `_k_friendly_name`) whose writers escape everything *but* line
      // breaks — a newline here would inject whole lines into someone else's
      // config format. Same trust boundary as the target check above.
      title:
        typeof title === 'string' && title.length > 0 ? title.replace(/[\r\n]+/g, ' ') : null
    })
  }

  return bindings.length === 0
    ? none
    : { value: bindings, layer: 'file', origin: 'config.toml [[hotkeys]]' }
}

/**
 * `[[search.rules]]`. A malformed rule is dropped rather than rejecting the
 * list, for the same reason a malformed search is: one bad entry should cost
 * only itself.
 */
function rulesFrom(
  file: Record<string, unknown>,
  problems: string[]
): Resolved<readonly SearchRule[]> {
  const none: Resolved<readonly SearchRule[]> = {
    value: [],
    layer: 'default',
    origin: 'built-in default'
  }

  const section = file['search']
  if (typeof section !== 'object' || section === null) return none
  const raw = (section as Record<string, unknown>)['rules']
  if (raw === undefined) return none
  if (!Array.isArray(raw)) {
    problems.push('config.toml [[search.rules]]: ignored, expected a list of rules')
    return none
  }

  const rules: SearchRule[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const { match, first, order } = entry as Record<string, unknown>
    if (typeof match !== 'string' || match.trim().length === 0) {
      problems.push('config.toml [[search.rules]]: dropped a rule with no `match`')
      continue
    }

    const keys = pinEntriesOf(first).filter((entry) => {
      if (isPinKey(entry.key)) return true
      problems.push(
        `config.toml [[search.rules]] match = ${JSON.stringify(match)}: dropped ${JSON.stringify(entry.key)}`
      )
      return false
    })

    const ruleOrder = order === undefined ? null : (asGroupOrder(order) ?? null)
    if (order !== undefined && ruleOrder === null) {
      problems.push(
        `config.toml [[search.rules]] match = ${JSON.stringify(match)}: ignored an unusable \`order\``
      )
    }

    rules.push({ match: match.trim().toLowerCase(), first: keys, order: ruleOrder })
  }

  return rules.length === 0
    ? none
    : { value: rules, layer: 'file', origin: 'config.toml [[search.rules]]' }
}

/**
 * `[extensions].disabled` — installed, kept, and not shown.
 *
 * Distinct from uninstalling, and the distinction is the point: an extension
 * usually holds state — a token, a cache, a list of favourites — and "I do not
 * want this in my results right now" should not be a decision that throws that
 * away. Disabling leaves the code and the database exactly where they are.
 *
 * An entry is either an extension name (`hacker-news`, which hides all of it) or
 * a command id (`hacker-news/frontpage`, which hides one command). One list for
 * both, because a command id already contains the extension name and a reader
 * can tell them apart by eye.
 */
function disabledExtensionsFrom(
  file: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
  problems: string[]
): Resolved<readonly string[]> {
  const envKey = `${ENV_PREFIX}DISABLED_EXTENSIONS`
  const fromEnv = env[envKey]
  if (fromEnv !== undefined) {
    return { value: asStringList(fromEnv) ?? [], layer: 'env', origin: envKey }
  }

  const section = file['extensions']
  const raw =
    typeof section === 'object' && section !== null && !Array.isArray(section)
      ? (section as Record<string, unknown>)['disabled']
      : undefined
  if (raw === undefined) return { value: [], layer: 'default', origin: 'built-in default' }

  const list = asStringList(raw)
  if (list === undefined) {
    problems.push('config.toml [extensions].disabled: ignored, expected a list of names')
    return { value: [], layer: 'default', origin: 'built-in default' }
  }
  return { value: [...new Set(list)], layer: 'file', origin: 'config.toml [extensions].disabled' }
}

/**
 * Whether a command should appear, given the disabled list.
 *
 * Takes the command id (`<extension>/<command>`) and checks both it and the
 * extension it belongs to, so disabling an extension disables its commands
 * without the list having to name every one of them.
 */
export function isExtensionCommandEnabled(
  disabled: readonly string[],
  commandId: string
): boolean {
  if (disabled.includes(commandId)) return false
  const separator = commandId.indexOf('/')
  return separator === -1 || !disabled.includes(commandId.slice(0, separator))
}

/**
 * `[aliases]`: a flat table of alias → target.
 *
 * A value is a bare target, or the same `{ id, title }` table a pinned plugin
 * item uses. Anything else is dropped, one alias at a time.
 */
function readAliases(file: Record<string, unknown>): Readonly<Record<string, PinEntry>> | undefined {
  const section = file['aliases']
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined

  const aliases: Record<string, PinEntry> = {}
  for (const [alias, value] of Object.entries(section as Record<string, unknown>)) {
    if (alias.length === 0 || /\s/.test(alias)) continue

    if (typeof value === 'string') {
      if (value.length > 0) aliases[alias.toLowerCase()] = { key: value, title: null, icon: null }
      continue
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const { id, title } = value as Record<string, unknown>
      if (typeof id === 'string' && id.trim().length > 0) {
        aliases[alias.toLowerCase()] = {
          key: id.trim(),
          title: typeof title === 'string' && title.length > 0 ? title : null,
          icon: null
        }
      }
    }
  }
  return aliases
}

export function loadConfig(options: LoadOptions): ResolvedConfig {
  const { fileContents = null, env, flags = {}, readProblem = null } = options

  const problems: string[] = []
  if (readProblem !== null) problems.push(readProblem)
  let file: Record<string, unknown> = {}

  if (fileContents !== null) {
    try {
      const parsed = parseToml(fileContents)
      if (typeof parsed === 'object' && parsed !== null) {
        file = parsed as Record<string, unknown>
      }
    } catch (error) {
      // A broken config must never prevent startup — the launcher is the thing
      // the user reaches for when something else is broken.
      const detail = error instanceof TomlError ? error.message : String(error)
      problems.push(`config.toml could not be parsed, using defaults: ${detail}`)
    }
  }

  const unrecognized = Object.keys(file).filter((key) => !KNOWN_SECTIONS.has(key))

  const r = new Resolver(file, env, flags)

  const config: ResolvedConfig = {
    general: {
      hotkey: r.resolve({
        envKey: 'HOTKEY',
        section: 'general',
        fileKey: 'hotkey',
        fallback: 'Super+R',
        coerce: asHotkey
      }),
      hideOnBlur: r.resolve({
        envKey: 'HIDE_ON_BLUR',
        section: 'general',
        fileKey: 'hide_on_blur',
        fallback: true,
        coerce: asBoolean
      }),
      escAtRoot: r.resolve({
        envKey: 'ESC_AT_ROOT',
        section: 'general',
        fileKey: 'esc_at_root',
        fallback: 'hide',
        coerce: asEnum(ESC_AT_ROOT_VALUES)
      }),
      openOnMonitor: r.resolve({
        envKey: 'OPEN_ON_MONITOR',
        section: 'general',
        fileKey: 'open_on_monitor',
        fallback: 'cursor',
        coerce: asEnum(OPEN_ON_MONITOR_VALUES)
      }),
      width: r.resolve({
        flagKey: 'width',
        envKey: 'WIDTH',
        section: 'general',
        fileKey: 'width',
        fallback: 760,
        coerce: asDimension(320, 4096)
      }),
      height: r.resolve({
        flagKey: 'height',
        envKey: 'HEIGHT',
        section: 'general',
        fileKey: 'height',
        fallback: 480,
        coerce: asDimension(240, 4096)
      }),
      top: r.resolve({
        flagKey: 'top',
        envKey: 'TOP',
        section: 'general',
        fileKey: 'top',
        fallback: DEFAULT_PANEL_TOP_PERCENT,
        coerce: asDimension(0, 90)
      })
    },
    appearance: {
      theme: r.resolve<string | null>({
        envKey: 'THEME',
        section: 'appearance',
        fileKey: 'theme',
        fallback: null,
        coerce: asNonEmptyString
      }),
      followSystem: r.resolve({
        envKey: 'FOLLOW_SYSTEM',
        section: 'appearance',
        fileKey: 'follow_system',
        fallback: true,
        coerce: asBoolean
      }),
      animations: r.resolve({
        envKey: 'ANIMATIONS',
        section: 'appearance',
        fileKey: 'animations',
        fallback: true,
        coerce: asBoolean
      }),
      textScale: r.resolve<number | null>({
        envKey: 'TEXT_SCALE',
        section: 'appearance',
        fileKey: 'text_scale',
        fallback: null,
        coerce: asFactor(0.5, 3)
      })
    },
    fileSearch: {
      /**
       * `[file_search].hotkey` — the key that opens Search Files.
       *
       * The *only* way in, which is what makes it a second search rather than a
       * plugin: file search does not appear at the root, cannot be pinned there,
       * and is not something a query can reach. A filesystem is neither small
       * enough to rank against your applications nor fast enough to re-scan per
       * keystroke, and a root list that tries becomes a root list that stutters.
       *
       * Written into the same managed block by the same planner as the toggle —
       * `bindSpecs` turns it into `lumanin open 'extension:files/search'` — so
       * it is bound wherever the toggle is bound and reported the same way.
       * Empty means "do not bind one", which is how someone who does not want it
       * turns it off; it is also the one way to make file search unreachable, so
       * the settings screen says so rather than offering it as a plain "off".
       */
      hotkey: r.resolve({
        envKey: 'FILE_SEARCH_HOTKEY',
        section: 'file_search',
        fileKey: 'hotkey',
        // It lived in `[general]` for one day, before file search had a section
        // of its own. A config written in that window still works.
        movedFrom: { section: 'general', fileKey: 'file_search_hotkey' },
        fallback: 'Super+Shift+R',
        coerce: asOptionalHotkey
      }),
      order: r.resolve<readonly FileCategory[]>({
        envKey: 'FILE_ORDER',
        section: 'file_search',
        fileKey: 'order',
        fallback: DEFAULT_FILE_ORDER,
        coerce: asFileOrder
      }),
      /**
       * Close the panel when a file search result is handed to another program.
       *
       * On by default, and the default is the interesting part. Opening a file
       * is the *end* of a file search — the thing you came for is now in an
       * editor or a viewer, and that program has the keyboard. A launcher left
       * on screen behind it is a window that looks alive and is not: its arrow
       * keys do nothing, because the keyboard is somewhere else. That was the
       * reported bug, and hiding is the answer to it rather than trying to take
       * the focus back (which was tried, and removed).
       *
       * Off is for browsing: open a few images in turn without the panel
       * disappearing between them.
       */
      hideOnOpen: r.resolve({
        envKey: 'FILE_HIDE_ON_OPEN',
        section: 'file_search',
        fileKey: 'hide_on_open',
        fallback: true,
        coerce: asBoolean
      })
    },
    search: {
      fallbackOrder: r.resolve<readonly ResultGroup[]>({
        envKey: 'ORDER',
        section: 'search',
        // `fallback_order` was the original name, from when the web search was
        // the only thing this ordered. Both are read; the new one wins.
        fileKey: ['order', 'fallback_order'],
        fallback: DEFAULT_RESULT_ORDER,
        coerce: asGroupOrder
      }),
      frecencyWeight: r.resolve({
        envKey: 'FRECENCY_WEIGHT',
        section: 'search',
        fileKey: 'frecency_weight',
        fallback: 0.6,
        coerce: asUnitInterval
      }),
      webSearches: searchesFrom(file, env, problems),
      pins: pinsFrom(file, env, problems),
      rules: rulesFrom(file, problems)
    },
    hotkeys: hotkeysFrom(file, problems),
    keys: keysFrom(file, problems),
    aliases: aliasesFrom(file),
    extensions: { disabled: disabledExtensionsFrom(file, env, problems) },
    raw: file,
    unrecognized,
    problems: [...problems, ...r.collectedProblems]
  }

  return config
}

/**
 * `[keys]`: one setting per panel action, each a chord or a list of them.
 *
 * Unparseable chords are dropped with a problem and the action keeps its
 * default, rather than the section being refused. The failure this avoids is the
 * worst one available here: a typo in `back` leaving the panel with no way out.
 * Every action always has at least the binding it shipped with.
 */
function keysFrom(file: Record<string, unknown>, problems: string[]): Resolved<KeyMap> {
  const section = file['keys']
  if (section === undefined) return { value: DEFAULT_KEYS, layer: 'default', origin: 'built-in default' }
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    problems.push('config.toml [keys]: ignored, expected a table of action = "chord"')
    return { value: DEFAULT_KEYS, layer: 'default', origin: 'built-in default' }
  }

  const table = section as Record<string, unknown>
  const bindings: Record<string, readonly Shortcut[]> = {}
  let touched = false

  for (const action of KEY_ACTIONS) {
    const info = KEY_ACTION_INFO[action]
    const raw = table[info.setting]
    bindings[action] = DEFAULT_KEYS[action]
    if (raw === undefined) continue

    // A single chord or a list of them: `open = "Enter"` and
    // `secondary = ["Ctrl+Enter", "Space"]` are both natural to write, and
    // accepting only one of them would be a rule to remember for no reason.
    const written = Array.isArray(raw) ? raw : [raw]
    const parsed: Shortcut[] = []
    for (const entry of written) {
      if (typeof entry !== 'string') continue
      const chord = parseKeyChord(entry)
      if (chord === null) {
        problems.push(
          `config.toml [keys].${info.setting} = ${JSON.stringify(entry)}: not a key we understand; keeping the default`
        )
        continue
      }
      parsed.push(chord)
    }

    // An empty list is a deliberate "unbind this", and it is honoured — but only
    // when the user actually wrote an empty list, not when every chord in it
    // failed to parse. Those are different intentions and only one of them
    // should be able to leave an action unreachable.
    if (parsed.length > 0 || (Array.isArray(raw) && raw.length === 0)) {
      bindings[action] = parsed
      touched = true
    }
  }

  const keys = bindings as unknown as KeyMap
  for (const clash of keyConflicts(keys)) {
    problems.push(
      `config.toml [keys]: ${clash.chord} is bound to ${clash.actions.map((action) => KEY_ACTION_INFO[action].setting).join(' and ')}; the first one wins`
    )
  }

  return touched
    ? { value: keys, layer: 'file', origin: 'config.toml [keys]' }
    : { value: DEFAULT_KEYS, layer: 'default', origin: 'built-in default' }
}

/**
 * `[aliases]` does not go through the resolver: it is a section of user-chosen
 * keys rather than a known key in a section, so there is nothing to look up by
 * name. It still carries a layer and an origin, because `doctor` answers "I set
 * that and it didn't apply" for this exactly as much as for anything else.
 */
function aliasesFrom(file: Record<string, unknown>): Resolved<Readonly<Record<string, PinEntry>>> {
  const aliases = readAliases(file)
  return aliases === undefined || Object.keys(aliases).length === 0
    ? { value: {}, layer: 'default', origin: 'built-in default' }
    : { value: aliases, layer: 'file', origin: 'config.toml [aliases]' }
}
