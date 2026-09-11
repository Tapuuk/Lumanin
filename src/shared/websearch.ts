import type { WebSearch } from './config'
import { BUILTIN_ENGINES } from './engines'

/**
 * Fallback web searches: the answer to "I typed something and nothing matched".
 *
 * Two ways in, and they mean different things:
 *
 *  - **Keyword-first** (`g wayland scaling`) is a direct instruction. It shows
 *    whether or not anything else matched, and it shows first, because the user
 *    named the search they wanted.
 *  - **Fallback** (`wayland scaling`) is the last resort. It appears only when
 *    nothing else did — that is what makes it a fallback rather than a permanent
 *    row of noise under every query.
 */

/**
 * Substitute the query into a search template.
 *
 * `encodeURIComponent` rather than `encodeURI`: the query is one parameter
 * value, so `&`, `=` and `+` in it have to stop being URL syntax. Without that,
 * searching for `a&b=c` would silently become two parameters.
 */
export function buildSearchUrl(template: string, query: string): string {
  return template.replace('{}', encodeURIComponent(query))
}

/**
 * The placeholders other tools use for "the query goes here".
 *
 * Accepted on input and rewritten to `{}` so a template copied out of Raycast,
 * Chrome's search-engine settings or a browser bookmark keyword works unedited.
 * Ours stays `{}` — it is the shortest, and the config documents one spelling.
 */
const PLACEHOLDER_ALIASES = /\{query\}|\{searchterms\}|\{search\}|%s/gi

/** Stands in for `{}` while the URL is handed to the parser, which would encode it. */
const PARSE_TOKEN = 'lumaninqueryplaceholder'

/**
 * Turn whatever the user typed into a search template, or `null` if it cannot be one.
 *
 * The point is that **`raycast.com` is enough**. Requiring
 * `https://raycast.com/?q={}` is asking someone to know a URL convention, a
 * placeholder syntax and a scheme before they can add a search, and every one of
 * those is something this can work out:
 *
 *  - no scheme → `https://`;
 *  - a site we already ship a search for → that engine's real template, so
 *    typing `youtube.com` gets `search_query=`, not a guess;
 *  - a query parameter left empty (`example.com/find?q=`) → the query goes there;
 *  - nothing else to go on → `?q={}`, which is what most of the web uses.
 *
 * The last case is a guess and is treated as one: the caller shows the finished
 * template so it can be corrected before it is saved.
 */
export function normalizeSearchTemplate(input: string): string | null {
  const trimmed = input.trim().replace(/^['"]|['"]$/g, '')
  if (trimmed.length === 0) return null

  const aliased = trimmed.replace(PLACEHOLDER_ALIASES, '{}')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(aliased) ? aliased : `https://${aliased}`

  let parsed: URL
  try {
    parsed = new URL(withScheme.replaceAll('{}', PARSE_TOKEN))
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  // A bare `https://` or a scheme with no host is not a site.
  if (parsed.hostname.length === 0) return null

  if (withScheme.includes('{}')) return withScheme

  // `www.` is stripped on both sides: someone typing `youtube.com` means the
  // site we ship a search for, whose template happens to say `www.youtube.com`.
  const bare = parsed.hostname.replace(/^www\./, '')
  const known = BUILTIN_ENGINES.find((engine) => hostOf(engine.url).replace(/^www\./, '') === bare)
  if (known !== undefined) return known.url

  // `?q=` with nothing after it is someone who copied a search URL and deleted
  // the term. Putting the placeholder where the term was is what they meant.
  const empty = [...parsed.searchParams.entries()].find(([, value]) => value.length === 0)
  if (empty !== undefined) {
    parsed.searchParams.set(empty[0], PARSE_TOKEN)
    return parsed.toString().replaceAll(PARSE_TOKEN, '{}')
  }

  parsed.searchParams.set('q', PARSE_TOKEN)
  return parsed.toString().replaceAll(PARSE_TOKEN, '{}')
}

function hostOf(url: string): string {
  try {
    return new URL(url.replaceAll('{}', PARSE_TOKEN)).hostname
  } catch {
    return ''
  }
}

/**
 * A name and keyword suggested from a URL, so adding a search is one thing to
 * type instead of three. `https://crates.io/search?q={}` → "Crates" / "crates".
 */
export function suggestSearchIdentity(template: string): { name: string; keyword: string } {
  const host = hostOf(template).replace(/^www\./, '')
  const label = host.split('.')[0] ?? host
  return {
    name: label.length === 0 ? 'Search' : label[0]?.toUpperCase() + label.slice(1),
    keyword: label.length === 0 ? 'search' : label
  }
}

export interface KeywordMatch {
  readonly search: WebSearch
  /** What to search for — everything after the keyword. */
  readonly term: string
}

/**
 * `<keyword> <term>` — an explicit request for one search.
 *
 * The keyword must be followed by whitespace and a non-empty term. A bare `g`
 * is far more likely to be someone typing the first letter of an application
 * than a request to search for nothing.
 */
export function matchKeyword(query: string, searches: readonly WebSearch[]): KeywordMatch | null {
  const separator = query.search(/\s/)
  if (separator === -1) return null

  const keyword = query.slice(0, separator).toLowerCase()
  const term = query.slice(separator + 1).trim()
  if (term.length === 0) return null

  const search = searches.find((candidate) => candidate.keyword.toLowerCase() === keyword)
  return search === undefined ? null : { search, term }
}

/**
 * Whether a URL is safe to hand to the system opener.
 *
 * The gate exists because a search template is user-editable configuration that
 * becomes a URL passed to `xdg-open`, which will happily open `file:///` — or a
 * `.desktop` handler for a scheme we have never heard of. A web search that is not
 * a web search is not a search.
 */
export function isOpenableUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}
