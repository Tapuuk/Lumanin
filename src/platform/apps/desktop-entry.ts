/**
 * Freedesktop Desktop Entry parsing.
 *
 * Pure functions over strings, because this is where a launcher is most quietly
 * wrong: a mis-parsed `Exec` launches the wrong thing, a missed `NoDisplay`
 * shows the user twelve entries for their browser, and a mishandled `OnlyShowIn`
 * lists GNOME's control-centre panels on Hyprland. All of those look like taste
 * and are actually spec compliance.
 *
 * Implemented against the Desktop Entry Specification 1.5. The parts that matter
 * and are easy to skip are called out where they are handled.
 */

export interface DesktopAction {
  readonly id: string
  readonly name: string
  readonly exec: string
  readonly icon?: string
}

export interface DesktopEntry {
  /** The desktop-file ID, e.g. `org.gnome.Nautilus.desktop`. */
  readonly id: string
  readonly path: string
  readonly name: string
  readonly genericName?: string
  readonly comment?: string
  readonly exec: string
  readonly tryExec?: string
  readonly icon?: string
  readonly terminal: boolean
  readonly categories: readonly string[]
  readonly keywords: readonly string[]
  /** Matches this app's windows; the window switcher uses it. */
  readonly startupWmClass?: string
  readonly actions: readonly DesktopAction[]
  readonly path_?: string
}

export interface ParsedGroups {
  readonly groups: ReadonlyMap<string, ReadonlyMap<string, string>>
}

/**
 * Split into groups and key/value pairs.
 *
 * Deliberately forgiving: real `.desktop` files in the wild contain trailing
 * whitespace, duplicate keys and stray lines, and a launcher that refuses to
 * index an app because its file has a blank continuation is worse than one that
 * takes the last value and moves on.
 */
export function parseGroups(contents: string): ParsedGroups {
  const groups = new Map<string, Map<string, string>>()
  let current: Map<string, string> | null = null

  for (const raw of contents.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue

    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1)
      current = groups.get(name) ?? new Map<string, string>()
      groups.set(name, current)
      continue
    }

    if (current === null) continue
    const equals = line.indexOf('=')
    if (equals === -1) continue
    current.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim())
  }

  return { groups }
}

/**
 * Unescape a value per the Desktop Entry Specification's "Value types" section:
 * the file format's own escapes, which are
 * not the shell's. `\s` meaning a space is the one nobody remembers.
 */
export function unescapeValue(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '\\' || i === value.length - 1) {
      out += value[i]
      continue
    }
    i += 1
    const escaped = value[i]
    out +=
      escaped === 's' ? ' '
      : escaped === 'n' ? '\n'
      : escaped === 't' ? '\t'
      : escaped === 'r' ? '\r'
      : escaped === '\\' ? '\\'
      : escaped === ';' ? ';'
      : `\\${escaped ?? ''}`
  }
  return out
}

/** Semicolon-separated lists, honouring `\;` as a literal semicolon. */
export function parseList(value: string | undefined): readonly string[] {
  if (value === undefined || value.length === 0) return []

  const parts: string[] = []
  let buffer = ''
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\\' && value[i + 1] === ';') {
      buffer += ';'
      i += 1
      continue
    }
    if (value[i] === ';') {
      parts.push(unescapeValue(buffer))
      buffer = ''
      continue
    }
    buffer += value[i]
  }
  if (buffer.length > 0) parts.push(unescapeValue(buffer))
  return parts.filter((part) => part.length > 0)
}

/**
 * Locale keys, most specific first, per the Desktop Entry Specification's
 * "Localized values" section:
 * `lang_COUNTRY@MODIFIER`, `lang_COUNTRY`, `lang@MODIFIER`, `lang`. The encoding
 * part of the POSIX locale (`.UTF-8`) is stripped — it never appears in a key.
 */
export function localeKeys(locale: string | undefined): readonly string[] {
  if (locale === undefined || locale.length === 0 || locale === 'C' || locale === 'POSIX') return []

  // POSIX orders these `lang_COUNTRY.ENCODING@MODIFIER`, so the modifier comes
  // *after* the encoding. Splitting on `.` first therefore throws the modifier
  // away with it, and `de_DE.UTF-8@euro` silently loses its `@euro` variants.
  const [beforeModifier = '', modifier] = locale.split('@')
  const [base = '', country] = (beforeModifier.split('.')[0] ?? '').split('_')
  const lang = base
  if (lang.length === 0) return []

  const keys: string[] = []
  if (country !== undefined && modifier !== undefined) keys.push(`${lang}_${country}@${modifier}`)
  if (country !== undefined) keys.push(`${lang}_${country}`)
  if (modifier !== undefined) keys.push(`${lang}@${modifier}`)
  keys.push(lang)
  return keys
}

function localized(
  group: ReadonlyMap<string, string>,
  key: string,
  locales: readonly string[]
): string | undefined {
  for (const locale of locales) {
    const value = group.get(`${key}[${locale}]`)
    if (value !== undefined) return unescapeValue(value)
  }
  const plain = group.get(key)
  return plain === undefined ? undefined : unescapeValue(plain)
}

const isTrue = (value: string | undefined): boolean => value === 'true'

export interface EntryContext {
  /** `$XDG_CURRENT_DESKTOP`, split and lowercased. */
  readonly desktops: readonly string[]
  /** Resolves `TryExec`; returns null when the binary is not installed. */
  readonly resolveBinary: (name: string) => string | null
  readonly locale?: string
}

export type SkipReason =
  | 'not-an-application'
  | 'hidden'
  | 'no-display'
  | 'wrong-desktop'
  | 'try-exec-missing'
  | 'no-exec'
  | 'no-name'

export type EntryResult =
  | { readonly ok: true; readonly entry: DesktopEntry }
  | { readonly ok: false; readonly reason: SkipReason }

/**
 * Turn one `.desktop` file into an indexable entry, or say why not.
 *
 * The five skip rules are all from the spec and all produce visibly wrong
 * results if ignored:
 *
 *  - `Hidden=true` means the file is *deleted*, not merely invisible.
 *  - `NoDisplay=true` is a real application that should not be offered as one
 *    (MIME handlers, `.desktop` shims for URL schemes).
 *  - `OnlyShowIn` / `NotShowIn` are why GNOME's control-centre panels must not
 *    appear on Hyprland.
 *  - `TryExec` naming a binary that is not installed means the entry is stale —
 *    typically a package removed without its desktop file.
 */
export function parseDesktopEntry(
  contents: string,
  id: string,
  path: string,
  context: EntryContext
): EntryResult {
  const { groups } = parseGroups(contents)
  const main = groups.get('Desktop Entry')
  if (main === undefined) return { ok: false, reason: 'not-an-application' }
  if ((main.get('Type') ?? '') !== 'Application') return { ok: false, reason: 'not-an-application' }
  if (isTrue(main.get('Hidden'))) return { ok: false, reason: 'hidden' }
  if (isTrue(main.get('NoDisplay'))) return { ok: false, reason: 'no-display' }

  const onlyShowIn = parseList(main.get('OnlyShowIn')).map((d) => d.toLowerCase())
  const notShowIn = parseList(main.get('NotShowIn')).map((d) => d.toLowerCase())
  const here = context.desktops
  if (onlyShowIn.length > 0 && !onlyShowIn.some((d) => here.includes(d))) {
    return { ok: false, reason: 'wrong-desktop' }
  }
  if (notShowIn.some((d) => here.includes(d))) return { ok: false, reason: 'wrong-desktop' }

  const tryExec = main.get('TryExec')
  if (tryExec !== undefined && tryExec.length > 0) {
    // An absolute TryExec is a path to test; a bare name is looked up on $PATH.
    const found = tryExec.startsWith('/') ? tryExec : context.resolveBinary(tryExec)
    if (found === null) return { ok: false, reason: 'try-exec-missing' }
  }

  const locales = localeKeys(context.locale)
  const name = localized(main, 'Name', locales)
  if (name === undefined || name.length === 0) return { ok: false, reason: 'no-name' }

  const exec = main.get('Exec')
  if (exec === undefined || exec.length === 0) return { ok: false, reason: 'no-exec' }

  const actions: DesktopAction[] = []
  for (const actionId of parseList(main.get('Actions'))) {
    const group = groups.get(`Desktop Action ${actionId}`)
    const actionExec = group?.get('Exec')
    const actionName = group === undefined ? undefined : localized(group, 'Name', locales)
    if (group === undefined || actionExec === undefined || actionName === undefined) continue

    const icon = group.get('Icon')
    actions.push({
      id: actionId,
      name: actionName,
      exec: unescapeValue(actionExec),
      ...(icon === undefined ? {} : { icon })
    })
  }

  const genericName = localized(main, 'GenericName', locales)
  const comment = localized(main, 'Comment', locales)
  const icon = main.get('Icon')
  const startupWmClass = main.get('StartupWMClass')
  const workingDirectory = main.get('Path')

  return {
    ok: true,
    entry: {
      id,
      path,
      name,
      exec: unescapeValue(exec),
      terminal: isTrue(main.get('Terminal')),
      categories: parseList(main.get('Categories')),
      // Keywords are localized and are the reason searching "browser" finds
      // Firefox, whose name contains neither word.
      keywords: parseList(main.get(`Keywords[${locales[0] ?? ''}]`) ?? main.get('Keywords')),
      actions,
      ...(genericName === undefined ? {} : { genericName }),
      ...(comment === undefined ? {} : { comment }),
      ...(icon === undefined ? {} : { icon }),
      ...(tryExec === undefined ? {} : { tryExec }),
      ...(startupWmClass === undefined ? {} : { startupWmClass }),
      ...(workingDirectory === undefined ? {} : { path_: workingDirectory })
    }
  }
}

/**
 * Split an `Exec` value into argv and drop the field codes.
 *
 * Two separate jobs that the spec deliberately keeps separate, and conflating
 * them is the classic bug: quoting is resolved *first*, then field codes are
 * removed from the resulting arguments. Doing it the other way lets an
 * application name containing `%f` mangle the command line.
 *
 * Field codes we drop rather than expand (`%f %F %u %U`) are for opening files
 * with the app; launching it bare is what a launcher does. `%i`, `%c` and `%k`
 * expand to icon/name/path metadata that nothing here needs, and every other
 * code is deprecated.
 */
export function parseExec(exec: string): readonly string[] {
  const argv: string[] = []
  let buffer = ''
  let quoted = false
  let started = false

  const flush = (): void => {
    if (started || buffer.length > 0) argv.push(buffer)
    buffer = ''
    started = false
  }

  for (let i = 0; i < exec.length; i += 1) {
    const char = exec[i]

    if (quoted) {
      if (char === '\\' && i + 1 < exec.length) {
        // Inside quotes, only these four are escapable per the spec.
        const next = exec[i + 1] ?? ''
        if (['"', '`', '$', '\\'].includes(next)) {
          buffer += next
          i += 1
          continue
        }
      }
      if (char === '"') {
        quoted = false
        continue
      }
      buffer += char
      continue
    }

    if (char === '"') {
      quoted = true
      started = true
      continue
    }
    if (char === ' ' || char === '\t') {
      if (started || buffer.length > 0) flush()
      continue
    }
    buffer += char
  }
  flush()

  const out: string[] = []
  for (const argument of argv) {
    const stripped = stripFieldCodes(argument)
    // An argument that was *only* a field code disappears entirely; one that
    // merely contained one keeps its remaining text.
    if (stripped === '' && argument !== '') continue
    out.push(stripped)
  }
  return out
}

function stripFieldCodes(argument: string): string {
  let out = ''
  for (let i = 0; i < argument.length; i += 1) {
    if (argument[i] !== '%') {
      out += argument[i]
      continue
    }
    const code = argument[i + 1]
    i += 1
    if (code === '%') out += '%'
    // Every other code is dropped: file/URL codes have nothing to expand to when
    // launching bare, and the rest are deprecated.
  }
  return out
}
