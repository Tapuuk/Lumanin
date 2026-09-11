/**
 * `kwinrulesrc` surgery.
 *
 * KDE's window rules are the one thing `--fix` touches that cannot be a marked
 * block. The file is KConfig INI with a manifest: `[General]` holds `count` and
 * a `rules=` list naming the groups in force, and **a group nobody lists is a
 * group KWin never reads**. Appending our rule to the end of the file would
 * produce something that looks installed, diffs cleanly, and does nothing.
 *
 * So this merges instead: our group is written or replaced under a fixed name,
 * and the manifest is updated to include it. Everything else in the file — the
 * user's own rules, their order, their spacing — passes through untouched.
 *
 * Pure functions over strings, for the same reason `block.ts` is: the risky part
 * is the text surgery, and text surgery is testable without a KDE session.
 */

interface Group {
  /** The `[name]` line, verbatim. Empty for the preamble before the first group. */
  readonly header: string
  readonly name: string
  readonly lines: string[]
}

function parse(contents: string): Group[] {
  const groups: Group[] = [{ header: '', name: '', lines: [] }]

  for (const line of contents.split('\n')) {
    const header = /^\s*\[(.+)\]\s*$/.exec(line)
    if (header === null) {
      groups[groups.length - 1]?.lines.push(line)
      continue
    }
    groups.push({ header: line, name: header[1] ?? '', lines: [] })
  }

  return groups
}

function render(groups: readonly Group[]): string {
  const out: string[] = []
  for (const group of groups) {
    if (group.header.length > 0) out.push(group.header)
    out.push(...group.lines)
  }
  // A KConfig file always ends in a newline; splitting and rejoining a file that
  // did not would otherwise lose one on every pass.
  const text = out.join('\n')
  return text.endsWith('\n') || text.length === 0 ? text : `${text}\n`
}

function entry(group: Group | undefined, key: string): string | null {
  if (group === undefined) return null
  for (const line of group.lines) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`).exec(line)
    if (match !== null) return (match[1] ?? '').trim()
  }
  return null
}

function setEntry(group: Group, key: string, value: string): void {
  const at = group.lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line))
  if (at === -1) {
    // Before the trailing blank lines that separate this group from the next, so
    // the file keeps the shape KConfig writes.
    let insertAt = group.lines.length
    while (insertAt > 0 && (group.lines[insertAt - 1] ?? '').trim() === '') insertAt -= 1
    group.lines.splice(insertAt, 0, `${key}=${value}`)
    return
  }
  group.lines[at] = `${key}=${value}`
}

/**
 * Which groups the file currently declares as rules.
 *
 * `rules=` is the modern manifest. A file old enough to predate it says only
 * `count=N`, with the rules in groups named `1`..`N` — and reading that as "no
 * rules" and writing a `rules=` list containing only ours would **disable every
 * rule the user has**. That is the one genuinely destructive mistake available
 * here, so the legacy layout is reconstructed rather than assumed away.
 */
function declaredRules(groups: readonly Group[]): string[] {
  const general = groups.find((group) => group.name === 'General')
  const listed = entry(general, 'rules')
  if (listed !== null) {
    return listed
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
  }

  const count = Number(entry(general, 'count') ?? '0')
  if (!Number.isInteger(count) || count <= 0) return []

  return Array.from({ length: count }, (_, index) => String(index + 1)).filter((name) =>
    groups.some((group) => group.name === name)
  )
}

/**
 * Write (or replace) our rule and make sure KWin is told about it.
 *
 * Idempotent: the same rule twice produces a byte-identical file, which is what
 * makes `--fix` safe to run on every upgrade.
 */
export function mergeKwinRule(contents: string, name: string, body: readonly string[]): string {
  const groups = parse(contents)

  const existing = groups.find((group) => group.name === name)
  if (existing === undefined) {
    groups.push({ header: `[${name}]`, name, lines: [...body, ''] })
  } else {
    // The trailing blank line, if the file had one, is spacing rather than
    // content and is kept so the group does not weld onto the next one.
    const spacing = (existing.lines[existing.lines.length - 1] ?? '').trim() === '' ? [''] : []
    existing.lines.splice(0, existing.lines.length, ...body, ...spacing)
  }

  const rules = declaredRules(groups)
  if (!rules.includes(name)) rules.push(name)

  let general = groups.find((group) => group.name === 'General')
  if (general === undefined) {
    general = { header: '[General]', name: 'General', lines: [''] }
    groups.push(general)
  }
  setEntry(general, 'count', String(rules.length))
  setEntry(general, 'rules', rules.join(','))

  return render(groups)
}

/** `--unfix`: drop our group and stop declaring it. Leaves everything else alone. */
export function removeKwinRule(contents: string, name: string): string {
  const groups = parse(contents)
  if (!groups.some((group) => group.name === name)) return contents

  const rules = declaredRules(groups).filter((rule) => rule !== name)
  const kept = groups.filter((group) => group.name !== name)

  const general = kept.find((group) => group.name === 'General')
  if (general !== undefined) {
    setEntry(general, 'count', String(rules.length))
    setEntry(general, 'rules', rules.join(','))
  }

  return render(kept)
}
