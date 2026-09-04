import { calculate } from '../shared/calculator'
import {
  isPinKey,
  parseExtensionPin,
  type ResolvedConfig,
  type SearchRule,
  type WebSearch
} from '../shared/config'
import { matchFields, matchGroup, TIER, type MatchOptions, type MatchTier } from '../shared/fuzzy'
import type { ResultItem } from '../shared/ipc'
import { buildSearchUrl, matchKeyword } from '../shared/websearch'

/**
 * Composing the root list out of everything that can answer a query.
 *
 * The governing rule is that **everything compatible with what was typed is
 * offered at once**: the applications that match, the commands that match, the
 * calculation if it is one, and a search on every engine the user enabled. A
 * launcher that shows you an application *or* a web search, depending on which
 * heuristic fired, makes you retype your query to see the other one.
 *
 * `[search].order` decides **which** sources are consulted and where the
 * unscored ones sit. What it deliberately does *not* do is partition the list by
 * kind, and that distinction was learned the hard way: with a strict partition,
 * typing "reload" put LibreOffice Calc — a scattered subsequence match — above
 * the command literally called Reload Applications, because apps come first in
 * the default order.
 *
 * A plugin's commands are the exception, and they are their own group. Ranked
 * in with the applications they lost every prefix match to the application of
 * the same name — "godot" found the editor, and the plugin that searches Godot
 * projects sat under it — so reaching the plugin cost an arrow key every time.
 * `plugins` is a separate group with its own position, first by default, which
 * is the only thing that can put "Search Godot Projects" above Godot.
 *
 * So applications and commands are **scored on one scale and ranked together**.
 * Both go through `matchFields`, so their scores are comparable by construction,
 * and the merged list gets one relative cutoff — which is also what stops
 * "Open Configuration File" appearing under the query "fire" (it is a real
 * subsequence, and it is noise). Where the two kinds tie, the order breaks it.
 *
 * The calculator and the web searches are not scored — a sum is either the
 * answer or it is not, and a search is always a valid thing to do. The web rows
 * keep positional placement; the calculator does not participate in ordering at
 * all (user decision): a query that is a calculation has one right
 * answer, so it sits above everything, always, and is not a setting.
 *
 * Five things override the ranking, each because the user said something more
 * specific than "search":
 *
 *  - a **calculation** is its own answer, so it goes first, above even pins;
 *
 *  - an **alias** typed exactly is an instruction, so its target goes first;
 *  - a **rule** (`[[search.rules]]`) is a per-query exception, so the rows it
 *    names are injected in its order, whether or not they would have matched;
 *  - a **pin** hoists a row that matched to the top, and is exempt from the
 *    cutoff — pinning something is a standing instruction to keep it visible;
 *  - a **keyword search** (`g wayland scaling`) names both the engine and the
 *    term, so it replaces the generic search rows entirely.
 */

/** Registered by main. Anything with a `run` is a root command. */
export interface RootCommand {
  /**
   * `builtin/<name>` for ours, `<extension>/<command>` for an extension's —
   * both matching the config's alias target syntax, so either can be aliased or
   * pinned by writing the same string a person would read off the row.
   */
  readonly id: string
  readonly title: string
  readonly subtitle: string
  /** Extra words that should find it — "restart", "rescan", "index". */
  readonly keywords: readonly string[]
  /**
   * `'command'` when omitted.
   *
   * An extension's command is scored exactly like ours and differs only in how
   * the row is drawn and what Enter does to it — so this is the whole of the
   * difference, rather than a second list with a second ranking.
   */
  readonly kind?: 'command' | 'extension'
  /** A `lumanin-icon:` URL, already resolved by whoever registered the command. */
  readonly icon?: string
  /** See `ResultItem.badge` — the search mark over an app-connected plugin's icon. */
  readonly badge?: 'search'
  /** Extension rows only: what the plugin is called, for category-pin titles. */
  readonly extensionTitle?: string
  /** Extension rows only: the categories the command declares in its manifest. */
  readonly categories?: readonly { readonly id: string; readonly title: string }[]
}

/** A row with the score that earned it, so kinds can be ranked against each other. */
export interface ScoredRow {
  readonly row: ResultItem
  readonly score: number
  /** How the match was found. The primary sort key — see `fuzzy.ts`. */
  readonly tier: MatchTier
  /** Where in the name it starts. Orders rows inside a tier. */
  readonly at: number
}

export interface RootSearchInput {
  readonly query: string
  readonly config: ResolvedConfig
  readonly commands: readonly RootCommand[]
  /**
   * Scored application rows, matched exactly. The cutoff is applied here, across
   * all kinds.
   */
  readonly apps: readonly ScoredRow[]
  /**
   * The same rows, scored again with a typo forgiven — asked for only when
   * nothing anywhere matched exactly, since a repaired row is never shown
   * alongside one that is not. Optional: a caller that hands in `apps` alone
   * gets both passes over the same rows, which is what a pre-scored fixture
   * wants.
   */
  readonly appsWithTypos?: () => readonly ScoredRow[]
  /**
   * Resolve an alias or pin target to a row. Targets can name a command or an
   * application, and only the caller knows the application index.
   */
  readonly resolveAlias: (target: string) => ResultItem | null
}

/** Below this a match is incidental — a letter here and there in a long name. */
const SCORE_FLOOR = 20

/**
 * Drop anything below this fraction of the best match, across every scored kind.
 *
 * "fire" matches `Open Con(f)igurat(i)on Fil(e)` as a genuine subsequence, and
 * only a cutoff relative to Firefox's score knows that it should not be shown.
 * Pinned rows are exempt: the user already said they want that one.
 */
const RELATIVE_CUTOFF = 0.55

/**
 * How much of a rule's trigger has to be typed before it fires.
 *
 * A rule matches once the query reaches into its trigger — "1pas" fires the rule
 * for "1password" — but not from the first letter, or typing `1` would rearrange
 * the list on the strength of a guess. Three characters is enough to have meant
 * it. A query that goes *past* the trigger ("1password vault") still matches:
 * the exception is about the thing being searched for, not the exact string.
 */
const RULE_MIN_PREFIX = 3

function commandRow(command: RootCommand): ResultItem {
  const kind = command.kind ?? 'command'
  return {
    id: `${kind}:${command.id}`,
    title: command.title,
    subtitle: command.subtitle,
    kind,
    ...(command.icon === undefined ? {} : { icon: command.icon }),
    ...(command.badge === undefined ? {} : { badge: command.badge })
  }
}

/**
 * A command line the user configured, as a row.
 *
 * The command is both the title and the payload: there is nothing else to call
 * it, and showing the line that is about to run is the only honest label — a
 * friendly name over a shell command is how someone ends up running something
 * they did not mean to.
 */
export function shellRow(command: string): ResultItem {
  return { id: `shell:${command}`, title: command, subtitle: 'Run in your shell', kind: 'shell' }
}

function webRow(search: WebSearch, term: string): ResultItem {
  // No subtitle: the title already names the engine and the term, and repeating
  // "Google" underneath "Search Google for …" is a second line that says nothing.
  return {
    id: `web:${buildSearchUrl(search.url, term)}`,
    title: `Search ${search.name} for “${term}”`,
    kind: 'web'
  }
}

/**
 * The stable identity of a row, for pins and rules to name.
 *
 * Applications and commands are already `<kind>:<id>`. A web row is not: its id
 * carries the built URL, which contains the query and so changes on every
 * keystroke. Pinning uses the engine's id instead — `web:google` — which is both
 * stable and something a person can type into a config file.
 */
function pinKeyOf(row: ResultItem): string | null {
  return row.kind === 'app' || row.kind === 'command' || row.kind === 'extension' ? row.id : null
}

/**
 * The rule for a query, or none. First match wins, so an earlier rule shadows a
 * later one and the file reads top-down like every other rule list.
 */
export function matchRule(needle: string, rules: readonly SearchRule[]): SearchRule | null {
  const query = needle.toLowerCase()
  return (
    rules.find(
      (rule) =>
        query.startsWith(rule.match) ||
        (query.length >= RULE_MIN_PREFIX && rule.match.startsWith(query))
    ) ?? null
  )
}

/**
 * Whether a typed query should surface a pinned shell command.
 *
 * Scored against the command line and held to the same floor as everything else,
 * so pinning `systemctl suspend` does not put it under every query containing an
 * `s` and a `u`.
 */
function matchesShellPin(needle: string, command: string): boolean {
  const match = matchFields(needle, [{ name: 'command', text: command, weight: 1, isName: true }])
  return match !== null && match.score >= SCORE_FLOOR
}

/** A pinned category/item row, matched against its display title like any name. */
function matchesPinTitle(needle: string, title: string): boolean {
  const match = matchFields(needle, [{ name: 'title', text: title, weight: 1, isName: true }])
  return match !== null && match.score >= SCORE_FLOOR
}

function matchCommands(
  needle: string,
  commands: readonly RootCommand[],
  options?: MatchOptions
): ScoredRow[] {
  const scored: ScoredRow[] = []

  for (const command of commands) {
    const match = matchFields(
      needle,
      [
        { name: 'title', text: command.title, weight: 1, isName: true },
        { name: 'keywords', text: command.keywords.join(' '), weight: 0.7, mode: 'word' },
        { name: 'subtitle', text: command.subtitle, weight: 0.3, mode: 'word' }
      ],
      options
    )
    if (match === null || match.score < SCORE_FLOOR) continue
    scored.push({ row: commandRow(command), score: match.score, tier: match.tier, at: match.at })
  }

  return scored
}

export function composeRoot(input: RootSearchInput): readonly ResultItem[] {
  const needle = input.query.trim()

  const { config, commands } = input
  const searches = config.search.webSearches.value
  const pins = config.search.pins.value
  const rule = matchRule(needle, config.search.rules.value)
  const order = rule?.order ?? config.search.fallbackOrder.value

  const rows: ResultItem[] = []
  const seen = new Set<string>()
  const push = (row: ResultItem): void => {
    if (seen.has(row.id)) return
    seen.add(row.id)
    rows.push(row)
  }

  /**
   * A category or item pin, as a row.
   *
   * These exist only in the config — the ranking never produces one — and they
   * resolve entirely from what is already at hand: the command list carries the
   * extension's title and its declared categories, and an item pin brings its
   * own stored title. A category the plugin no longer declares (or a disabled
   * command) resolves to nothing, which is how a stale pin disappears instead
   * of becoming a dead row.
   */
  const resolveExtensionPin = (
    payload: string,
    storedTitle: string | null,
    storedIcon: string | null
  ): ResultItem | null => {
    const parts = parseExtensionPin(payload)
    if (parts === null) return null
    const command = commands.find(
      (candidate) => (candidate.kind ?? 'command') === 'extension' && candidate.id === parts.commandId
    )
    if (command === undefined) return null

    // An empty category is how a row of a command that declares *no* categories
    // is written (`extension:ext/cmd#:row`). There is nothing to look up, and
    // nothing that could have gone stale, so only a named one is checked.
    const category = command.categories?.find((candidate) => candidate.id === parts.category)
    if (parts.category.length > 0 && category === undefined) return null

    const owner = command.extensionTitle ?? command.title
    // The command's own icon and mark: a pinned slice of Search Godot is still
    // Search Godot, and drawing it differently would make the pin look like a
    // different thing than the row it came from.
    const icon = {
      ...(command.icon === undefined ? {} : { icon: command.icon }),
      ...(command.badge === undefined ? {} : { badge: command.badge })
    }
    if (parts.item === null) {
      if (category === undefined) return null
      return {
        id: `extension:${payload}`,
        title: `${owner}: ${category.title}`,
        subtitle: command.title,
        kind: 'extension',
        ...icon
      }
    }
    return {
      id: `extension:${payload}`,
      // The title captured at pin time; the raw id is the honest fallback for a
      // pin written by hand without one.
      title: storedTitle ?? (parts.action === null ? parts.item : `${parts.item} - ${parts.action}`),
      subtitle: category === undefined ? `${owner} · ${command.title}` : `${owner} · ${category.title}`,
      kind: 'extension',
      // A row that brought its own face wears it, and not the search mark: a
      // pinned project is that project, not a search for it.
      ...(storedIcon === null ? icon : { icon: storedIcon })
    }
  }

  /**
   * Turn a pin key into a row, for the two paths that *inject* rather than
   * reorder. A web pin needs a term, so at the root it resolves to nothing —
   * there is no such thing as searching for the empty string.
   */
  const resolvePin = (
    key: string,
    storedTitle: string | null = null,
    storedIcon: string | null = null
  ): ResultItem | null => {
    const separator = key.indexOf(':')
    if (separator === -1) return null
    const kind = key.slice(0, separator)
    const payload = key.slice(separator + 1)

    // A shell pin carries the command itself rather than an id to look up, so it
    // resolves without asking anyone — there is nothing that could have gone
    // missing since it was written.
    if (kind === 'shell') return shellRow(payload)
    if (kind === 'extension' && payload.includes('#')) {
      return resolveExtensionPin(payload, storedTitle, storedIcon)
    }
    if (kind !== 'web') return input.resolveAlias(payload)
    if (needle.length === 0) return null
    const search = searches.find((candidate) => candidate.id === payload)
    return search === undefined ? null : webRow(search, needle)
  }

  // Nothing typed: a bare search bar, always (user decision). Pins
  // used to be listed here, but the renderer opens the panel bare, so they only
  // ever surfaced when a query was erased mid-session - a row materialising out
  // of nowhere. A pin's job is ranking: it outranks everything the moment what
  // is typed names it.
  if (needle.length === 0) return rows

  // The calculator, above everything, always. Not a group in `[search].order`
  // any more and not a setting at all: a query that *is* a calculation — and
  // `calculate` only answers for those — has exactly one right answer, and no
  // pin, rule or ordering preference was written with "24/8" in mind. The one
  // thing that may follow it is the web row, which is always a valid answer.
  const calculation = calculate(needle)
  if (calculation !== null) {
    push({
      // The *value* is the payload, because copying it is what Enter does.
      id: `calculator:${calculation.value}`,
      title: calculation.value,
      subtitle: calculation.expression,
      kind: 'calculator'
    })
  }

  // An alias typed exactly. Not fuzzy-matched on purpose: an alias is a shortcut
  // someone chose and memorised, and a fuzzy alias is just another search result
  // that occasionally surprises you.
  //
  // The target goes through `resolvePin` when it is written as a pin key, which
  // is what lets an alias reach as deep as a pin does — a category, an item, or
  // one action on it. A bare id (`firefox.desktop`, `godot/search`) is the older
  // and still commonest spelling and resolves the way it always did.
  const alias = config.aliases.value[needle.toLowerCase()]
  if (alias !== undefined) {
    // `web:` is not an alias target — a search needs a term, and the term here
    // would be the alias word itself — so it stays unresolved rather than
    // turning "gg" into a search for "gg".
    const row =
      isPinKey(alias.key) && !alias.key.startsWith('web:')
        ? resolvePin(alias.key, alias.title)
        : input.resolveAlias(alias.key)
    if (row !== null) push(row)
  }

  // The exception for this query, in the order it was written.
  for (const entry of rule?.first ?? []) {
    const row = resolvePin(entry.key, entry.title)
    if (row !== null) push(row)
  }

  // A keyword search names the engine *and* the term, so it goes first and the
  // generic search rows are dropped: with a keyword typed, "Search DuckDuckGo
  // for “g wayland scaling”" is not a result anyone wanted.
  const webEnabled = order.includes('web')
  const keyword = webEnabled ? matchKeyword(needle, searches) : null
  if (keyword !== null) push(webRow(keyword.search, keyword.term))

  // Apps and commands, ranked together. The order decides whether each
  // participates and, on a tie, which comes first. A plugin's commands are
  // ranked *apart* — see the header — so that their group's position decides
  // where they land rather than their score against an application's name.
  const isPlugin = (command: RootCommand): boolean => (command.kind ?? 'command') === 'extension'
  const rankAll = (
    apps: readonly ScoredRow[],
    options: MatchOptions
  ): { ranked: ScoredRow[]; pluginRanked: ScoredRow[] } => ({
    ranked: [
      ...(order.includes('apps') ? apps : []),
      ...(order.includes('commands')
        ? matchCommands(needle, commands.filter((command) => !isPlugin(command)), options)
        : [])
    ],
    pluginRanked: order.includes('plugins')
      ? matchCommands(needle, commands.filter(isPlugin), options)
      : []
  })

  // Everything is matched exactly first, and a typo is forgiven only if that
  // found nothing worth showing — which is the same rule the group cutoff below
  // applies, moved earlier so the work is skipped rather than done and deleted.
  // The question spans applications, commands and plugin commands together: a
  // query that lands on a command exactly is no reason to go repairing two
  // thousand application names.
  let { ranked, pluginRanked } = rankAll(input.apps, { allowTypos: false })
  const anyExact = [ranked, pluginRanked].some((rows) =>
    rows.some((entry) => matchGroup(entry.tier) < 2)
  )
  if (needle.length > 0 && !anyExact) {
    ;({ ranked, pluginRanked } = rankAll(input.appsWithTypos?.() ?? input.apps, { allowTypos: true }))
  }

  const appsFirst = order.indexOf('apps') <= order.indexOf('commands')
  const kindRank = (row: ResultItem): number =>
    row.kind === 'app' ? (appsFirst ? 0 : 1) : appsFirst ? 1 : 0

  // Tier, then how far into the name the match starts, then score.
  //
  // The order the user asked for, in those words: what *starts* with what they
  // typed comes first, then matches further and further into the name. Score —
  // which carries frecency — breaks ties inside a position, which is where it
  // does the most good, since a prefix query usually ties every row at 0.
  const byRank = (a: ScoredRow, b: ScoredRow): number =>
    a.tier - b.tier ||
    a.at - b.at ||
    b.score - a.score ||
    kindRank(a.row) - kindRank(b.row) ||
    a.row.title.localeCompare(b.row.title)

  ranked.sort(byRank)
  pluginRanked.sort(byRank)

  // The pinned rows, in the order the user pinned them, above everything the
  // ranking produced. Read from `ranked` rather than from the survivors below,
  // so a pin also exempts its row from the cutoff — pinning something is a
  // standing instruction to keep it visible, and a pin that only worked for rows
  // that scored well anyway would be a pin that did nothing.
  const matched = new Map<string, ResultItem>()
  for (const entry of [...ranked, ...pluginRanked]) {
    const key = pinKeyOf(entry.row)
    if (key !== null && !matched.has(key)) matched.set(key, entry.row)
  }

  for (const entry of pins) {
    const key = entry.key
    // A pinned engine is the one pin that needs no match: searching for what was
    // typed is always something this can do. It is suppressed by a keyword,
    // which already named the engine the user wanted, and by an order that
    // leaves `web` out — a pin cannot re-enable a group the user switched off.
    //
    // A pinned shell command is the other kind the ranking never produces — it
    // exists only in the config — so it is matched here, against the command
    // line itself. Without that it would be a row that appears on the empty root
    // and vanishes the moment you type the thing you pinned it for.
    //
    // A pinned plugin category or item is matched the same way, against its own
    // display title — the launcher's rules, name only. They surface at root
    // *only* as pins: an unpinned category is reachable solely inside its
    // plugin's search, which is the user's decision on keeping the root clean.
    let row: ResultItem | null
    if (key.startsWith('web:')) {
      row = webEnabled && keyword === null ? resolvePin(key) : null
    } else if (key.startsWith('shell:')) {
      row = matchesShellPin(needle, key.slice('shell:'.length)) ? resolvePin(key) : null
    } else if (key.startsWith('extension:') && key.includes('#')) {
      const resolved = resolvePin(key, entry.title, entry.icon)
      row = resolved !== null && matchesPinTitle(needle, resolved.title) ? resolved : null
    } else {
      row = matched.get(key) ?? null
    }
    if (row !== null) push(row)
  }

  // Only the best group survives: if anything matched by **name**, nothing found
  // by a keyword or a generic name is shown at all, and a typo repair is shown
  // only when nothing matched exactly. This is the rule that stops "draw"
  // offering Pinta — whose `Keywords=` begins `draw;drawing;paint;` — alongside
  // LibreOffice Draw. Keyword matching is not gone: it is still what finds
  // Firefox for "browser", and Pinta for "paint". It is just no longer consulted
  // when something is actually *called* what you typed.
  //
  // Then the relative cutoff, within that group. A **prefix** match is exempt:
  // a row whose name starts with what you typed is always worth showing, and it
  // can easily score below a longer name that matched more of itself.
  //
  // **How** a row was found is compared across *both* groups; how well it scored
  // is compared only within one. Those are two different questions and they were
  // conflated at first, with a consequence that only showed up once we shipped a
  // plugin by default: `plugins` sits first in the order, so a plugin found by a
  // *keyword* went above an application found by its **name**. Typing "fire"
  // offered "Search Files" — whose manifest keywords contained a scattered
  // f-i-r-e — above Firefox. (That command has since left the root entirely;
  // the rule it produced applies to every plugin.) The decision was about "godot" meaning the
  // projects list rather than the editor: one strong match beating another
  // strong match. It was never a licence for a weak one to win.
  //
  // So the best match group is taken across everything, and both lists are cut
  // to it. Tiers are comparable by construction — "starts with the name" is the
  // same claim whoever makes it — which is exactly why this is the rule that
  // already stops "draw" offering Pinta (`Keywords=draw;drawing;paint;`)
  // alongside LibreOffice Draw.
  //
  // The relative **score** cutoff stays per group, for the original reason:
  // plugin rows are placed by where `plugins` sits rather than by competing, so
  // deleting one for scoring below the best application would be deleting it for
  // a reason the user never asked for.
  const bestGroup = [...ranked, ...pluginRanked].reduce(
    (best, entry) => Math.min(best, matchGroup(entry.tier)),
    2
  )
  const narrow = (rows: readonly ScoredRow[]): readonly ScoredRow[] => {
    const grouped = rows.filter((entry) => matchGroup(entry.tier) === bestGroup)
    const cutoff = Math.max(...grouped.map((entry) => entry.score), 0) * RELATIVE_CUTOFF
    return grouped.filter((entry) => entry.tier === TIER.PREFIX || entry.score >= cutoff)
  }

  const survivors = narrow(ranked)
  const pluginSurvivors = narrow(pluginRanked)

  // Emitted at whichever of the two groups the user put first, so the block as a
  // whole still sits where the config says.
  const rankedAt = Math.min(
    ...[order.indexOf('apps'), order.indexOf('commands')].filter((index) => index !== -1)
  )

  for (const [index, group] of order.entries()) {
    if (index === rankedAt) for (const entry of survivors) push(entry.row)

    switch (group) {
      case 'apps':
      case 'commands':
        // Both handled by the ranked block above.
        break
      case 'plugins':
        // The installed plugins' own view commands, at whatever position the
        // user gave the group — first, unless they moved it.
        for (const entry of pluginSurvivors) push(entry.row)
        break
      case 'calculator':
        // Nothing: the calculator stopped being orderable (user decision)
        // and is emitted above everything, unconditionally — see the
        // top of this function. The value is still accepted because it was in
        // the default order we shipped; see `INERT_RESULT_GROUPS`.
        break
      case 'files':
        // Nothing, on purpose. File search is not a source of root results and
        // is not reachable from the root at all: a filesystem is neither small
        // enough to rank against a few thousand application names nor fast
        // enough to re-scan per keystroke, so it is a second search surface with
        // a key of its own (`[file_search].hotkey`) and its command declares
        // `lumanin.root: false`. The value is still accepted because it was in
        // the default order we shipped; see `INERT_RESULT_GROUPS`.
        break
      case 'web':
        // Every enabled engine, under every query — the row that is always
        // there, because "search the web for what I typed" is always a valid
        // answer and the user should never have to clear the box to reach it.
        // The enabled list is the whole of the policy: one engine by default,
        // as many as are chosen in `[search].engines`.
        if (keyword === null) for (const search of searches) push(webRow(search, needle))
        break
    }
  }

  return rows
}
