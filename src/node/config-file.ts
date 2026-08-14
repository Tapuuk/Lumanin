import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

/**
 * Reading and rewriting `config.toml` from the CLI.
 *
 * The rule from CONFIG.md is that a config we do not fully understand is never
 * clobbered: this parses the file into a plain document, edits *that*, and
 * writes it back, so keys belonging to milestones we have not built yet survive
 * a round trip untouched. Insertion order survives too, which is what keeps the
 * file recognisable to the person who wrote it.
 *
 * What does **not** survive is comments — TOML parsers drop them and this one is
 * no exception. That is why every write leaves a timestamped backup and says so
 * out loud rather than quietly making the user's annotations disappear.
 */

/**
 * A live handle on the file, not a snapshot of it.
 *
 * `original`, `existed` and `commentLines` are updated by
 * {@link writeConfigDocument}, because they describe what is on disk *now* and a
 * save changes that. Leaving them frozen at open time is what made the menu go
 * on reporting "unsaved changes" after a successful save, and prompt to save
 * again on the way out — with nothing left to write.
 */
export interface ConfigDocument {
  readonly path: string
  /** Parsed contents; `{}` when the file is absent or unparseable. */
  readonly data: Record<string, unknown>
  existed: boolean
  /** The file as it currently is, for backup and change detection. */
  original: string | null
  /** Set when the file exists but does not parse — editing would destroy it. */
  readonly parseError: string | null
  /** Comment lines still in the file, which a rewrite will not preserve. */
  commentLines: number
}

export function readConfigDocument(path: string): ConfigDocument {
  let original: string | null = null
  try {
    original = readFileSync(path, 'utf8')
  } catch {
    return { path, data: {}, existed: false, original: null, parseError: null, commentLines: 0 }
  }

  const commentLines = original
    .split('\n')
    .filter((line) => line.trimStart().startsWith('#')).length

  try {
    const parsed = parseToml(original)
    const data =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    return { path, data, existed: true, original, parseError: null, commentLines }
  } catch (error) {
    return {
      path,
      data: {},
      existed: true,
      original,
      parseError: error instanceof Error ? error.message : String(error),
      commentLines
    }
  }
}

export interface WriteResult {
  readonly path: string
  /** Where the previous contents were copied, or `null` when there were none. */
  readonly backup: string | null
  /** False when the rendered file was identical to what was already there. */
  readonly changed: boolean
}

/**
 * Write the document back, atomically and with a backup.
 *
 * Atomic because the daemon watches this file: a partially written config read
 * mid-save would look like a broken one, and the recovery for that is to fall
 * back to defaults — i.e. to briefly throw away every setting the user has.
 */
export function writeConfigDocument(
  document: ConfigDocument,
  data: Record<string, unknown>,
  stamp: string
): WriteResult {
  const rendered = render(data)
  if (rendered === document.original) {
    return { path: document.path, backup: null, changed: false }
  }

  mkdirSync(dirname(document.path), { recursive: true })

  let backup: string | null = null
  if (document.existed) {
    backup = `${document.path}.bak-${stamp}`
    copyFileSync(document.path, backup)
    pruneBackups(document.path)
  }

  const temporary = `${document.path}.tmp-${stamp}`
  writeFileSync(temporary, rendered, { encoding: 'utf8', mode: 0o644 })
  renameSync(temporary, document.path)

  // The file on disk is now what we just rendered. Anything still comparing
  // against what it said when the menu opened would report every saved change as
  // unsaved, forever.
  document.original = rendered
  document.existed = true
  // A rewrite is what drops them, so after one there are none left to warn about.
  document.commentLines = 0

  return { path: document.path, backup, changed: true }
}

/**
 * Keep only the newest backups. The settings window writes per interaction, so
 * without a cap `config.toml.bak-*` files accumulate without bound — ten is
 * plenty of undo for a file that is also in the user's editor history.
 */
const BACKUPS_KEPT = 10

function pruneBackups(path: string): void {
  const prefix = `${basename(path)}.bak-`
  const directory = dirname(path)
  try {
    const backups = readdirSync(directory)
      .filter((name) => name.startsWith(prefix))
      // The stamp is an ISO timestamp, so the lexicographic order is the
      // chronological one.
      .sort()
    for (const name of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) {
      unlinkSync(join(directory, name))
    }
  } catch {
    // Pruning is a courtesy; a failure here must never fail the save.
  }
}

/** The exact text a save would produce, for a diff-before-you-commit preview. */
export function render(data: Record<string, unknown>): string {
  // Trimmed before the newline is added back: an empty document stringifies to
  // "\n", and an un-normalised render made a config nobody had touched compare
  // unequal to the file it came from — so the menu opened claiming unsaved
  // changes every time.
  const body = stringifyToml(data).trim()
  return body.length === 0 ? '' : `${body}\n`
}

/**
 * Set a value at a dotted path, creating tables on the way down.
 *
 * `undefined` **deletes** the key rather than writing a null, and prunes any
 * table it leaves empty. That distinction matters: a key that is absent takes
 * the built-in default and keeps taking it as the default changes, where a key
 * pinned to today's default is a decision the user never made.
 */
export function setValue(
  data: Record<string, unknown>,
  path: readonly string[],
  value: unknown
): void {
  const [head, ...rest] = path
  if (head === undefined) return

  if (rest.length === 0) {
    if (value === undefined) delete data[head]
    else data[head] = value
    return
  }

  const existing = data[head]

  // An array of tables — `[[search.rules]]` — is addressed by numeric segment.
  // Without this branch the array would be replaced by a table on the first edit
  // to a rule, which is the sort of thing that silently eats a config.
  if (Array.isArray(existing)) {
    const index = Number(rest[0])
    const entry = existing[index]
    if (!Number.isInteger(index) || typeof entry !== 'object' || entry === null) return
    setValue(entry as Record<string, unknown>, rest.slice(1), value)
    return
  }

  const table =
    typeof existing === 'object' && existing !== null ? (existing as Record<string, unknown>) : {}

  if (value === undefined && !(head in data)) return
  setValue(table, rest, value)

  if (Object.keys(table).length === 0) delete data[head]
  else data[head] = table
}

/** Read a value at a dotted path, or `undefined`. */
export function getValue(data: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = data
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
