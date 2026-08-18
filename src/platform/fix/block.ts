/**
 * Marked-block editing for the config files `lumanin doctor --fix` touches.
 *
 * The rules for every `--fix` action: idempotent, inside a marked
 * block, reversible by `--unfix`, and shown as a diff before it is applied. All
 * four of those are properties of *this file*, which is why it is pure functions
 * over strings rather than something that opens files — the risky part is the
 * text surgery, and text surgery is testable.
 *
 * The invariant everything else depends on: **we only ever rewrite the region
 * between our own markers.** A user's config is theirs. Anything outside the
 * block passes through byte for byte, including trailing whitespace we would
 * have formatted differently.
 */

const START_TEXT = '>>> lumanin managed >>>'
const END_TEXT = '<<< lumanin managed <<<'

export const BLOCK_START = `# ${START_TEXT}`
export const BLOCK_END = `# ${END_TEXT}`

/**
 * How a file spells "comment" and "container", for the two formats that are not
 * a flat list of `#`-commented lines.
 *
 * `comment` exists because a marker has to be invisible to whatever parses the
 * file, and `#` is a syntax error in RON — COSMIC's shortcuts config would fail
 * to load *entirely*, taking the user's other shortcuts with it, which is a much
 * worse outcome than not installing ours.
 *
 * `container: 'braces'` exists because that same file is one top-level map: a
 * block appended after its closing brace is not "a block at the end of the
 * file", it is trailing garbage. So the block goes inside, before the brace.
 */
export interface BlockStyle {
  readonly comment: string
  readonly container?: 'braces'
}

const DEFAULT_STYLE: BlockStyle = { comment: '#' }

function markers(style: BlockStyle): { start: string; end: string } {
  return { start: `${style.comment} ${START_TEXT}`, end: `${style.comment} ${END_TEXT}` }
}

export interface BlockLocation {
  /** Index of the marker line itself. */
  readonly startLine: number
  readonly endLine: number
  /** The lines between the markers, exclusive. */
  readonly body: readonly string[]
}

/**
 * Find our block. Returns `null` when there is none — and also when the file
 * contains a start marker with no end, which is a file someone edited by hand
 * mid-block. Rewriting from an unterminated marker would eat the rest of their
 * config, so we refuse to guess and let the caller report it.
 */
export function findBlock(contents: string, style: BlockStyle = DEFAULT_STYLE): BlockLocation | null {
  const { start, end } = markers(style)
  const lines = contents.split('\n')
  const startLine = lines.findIndex((line) => line.trim() === start)
  if (startLine === -1) return null

  const endOffset = lines.slice(startLine + 1).findIndex((line) => line.trim() === end)
  if (endOffset === -1) return null

  const endLine = startLine + 1 + endOffset
  return { startLine, endLine, body: lines.slice(startLine + 1, endLine) }
}

/** True when a start marker exists with no matching end — a hand-broken block. */
export function hasUnterminatedBlock(contents: string, style: BlockStyle = DEFAULT_STYLE): boolean {
  const { start, end } = markers(style)
  const lines = contents.split('\n')
  const startLine = lines.findIndex((line) => line.trim() === start)
  if (startLine === -1) return false
  return !lines.slice(startLine + 1).some((line) => line.trim() === end)
}

/**
 * Insert or replace the block. Idempotent: applying the same body twice produces
 * a byte-identical file, which is what makes `--fix` safe to run on every upgrade.
 */
export function upsertBlock(
  contents: string,
  body: readonly string[],
  style: BlockStyle = DEFAULT_STYLE
): string {
  const { start, end } = markers(style)
  const block = [start, ...body, end]
  const existing = findBlock(contents, style)

  if (existing !== null) {
    const lines = contents.split('\n')
    return [...lines.slice(0, existing.startLine), ...block, ...lines.slice(existing.endLine + 1)].join('\n')
  }

  if (style.container === 'braces') return insideBraces(contents, block)

  // Appending to a file with no trailing newline would weld our marker onto the
  // user's last line, and a config directive with a comment glued to its front is
  // a parse error in every format we write.
  const separator = contents.length === 0 ? '' : contents.endsWith('\n') ? '\n' : '\n\n'
  return `${contents}${separator}${block.join('\n')}\n`
}

/**
 * Put the block inside the file's top-level map, before its closing brace.
 *
 * Written against the *string* rather than against lines because the file may
 * legitimately be one: `ron`'s compact serialiser produces `{ (…): Spawn("…"), }`
 * on a single line, and a line-oriented insert would have nowhere to go. Taking
 * the last `}` covers both that and the pretty-printed form, and nesting does not
 * change the answer — the last brace in a well-formed map is always the map's.
 *
 * A file with no brace at all is treated as an empty map rather than as a
 * mistake: that is what "you have never set a custom shortcut" looks like, and
 * the alternative is refusing to install anything on a stock session.
 */
function insideBraces(contents: string, block: readonly string[]): string {
  const at = contents.lastIndexOf('}')
  if (at === -1) return `{\n${block.join('\n')}\n}\n`

  const head = contents.slice(0, at).replace(/[ \t]+$/, '')
  const tail = contents.slice(at)
  const separator = head.endsWith('\n') ? '' : '\n'
  return `${head}${separator}${block.join('\n')}\n${tail}`
}

/**
 * Remove the block, and the blank line we introduced above it if that is what is
 * there. `--unfix` should leave a file that looks untouched, not one with our
 * spacing fossilised into it.
 */
export function removeBlock(contents: string, style: BlockStyle = DEFAULT_STYLE): string {
  const existing = findBlock(contents, style)
  if (existing === null) return contents

  const lines = contents.split('\n')
  let from = existing.startLine
  if (from > 0 && lines[from - 1]?.trim() === '') from -= 1

  return [...lines.slice(0, from), ...lines.slice(existing.endLine + 1)].join('\n')
}

/**
 * A unified-ish diff, for showing the user what `--fix` would do before it does
 * it. Deliberately not a real diff library: the change is always one contiguous
 * block, so the interesting output is "these lines appear / these disappear", and
 * a dependency for that is a dependency to keep updated forever.
 */
export function renderDiff(before: string, after: string, path: string): string {
  if (before === after) return `${path}: already up to date`

  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')

  // Trim the common head and tail so the output is the block, not the whole file.
  let head = 0
  while (head < beforeLines.length && head < afterLines.length && beforeLines[head] === afterLines[head]) {
    head += 1
  }
  let tail = 0
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1
  }

  const removed = beforeLines.slice(head, beforeLines.length - tail)
  const added = afterLines.slice(head, afterLines.length - tail)

  const out = [`--- ${path}`, `+++ ${path}`, `@@ line ${String(head + 1)} @@`]
  for (const line of removed) out.push(`-${line}`)
  for (const line of added) out.push(`+${line}`)
  return out.join('\n')
}
