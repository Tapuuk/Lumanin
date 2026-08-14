import type { WebSearch } from './config'

/**
 * The built-in web searches, and the set enabled out of the box.
 *
 * This is a *catalog*, not a default: `[search].engines` picks ids out of it,
 * and the settings UI (M5) renders it as a list of checkboxes. Every entry the
 * user enables is a permanent row in the root list — a search is always offered,
 * for every query — which is why the shipped selection is one engine and not
 * sixteen. Three permanent rows under every keystroke is not a feature.
 *
 * Templates are the plain public search URL of each site, with `{}` where the
 * query goes. They are deliberately parameter-only: no locale, no tracking
 * parameter, no referral tag. A launcher that quietly rewrote your searches
 * would be the kind of thing this project exists not to be.
 */

export const BUILTIN_ENGINES: readonly WebSearch[] = [
  { id: 'google', keyword: 'g', name: 'Google', url: 'https://www.google.com/search?q={}' },
  { id: 'ddg', keyword: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={}' },
  { id: 'brave', keyword: 'br', name: 'Brave Search', url: 'https://search.brave.com/search?q={}' },
  { id: 'bing', keyword: 'b', name: 'Bing', url: 'https://www.bing.com/search?q={}' },
  { id: 'kagi', keyword: 'k', name: 'Kagi', url: 'https://kagi.com/search?q={}' },
  {
    id: 'startpage',
    keyword: 'sp',
    name: 'Startpage',
    url: 'https://www.startpage.com/sp/search?query={}'
  },
  { id: 'ecosia', keyword: 'ec', name: 'Ecosia', url: 'https://www.ecosia.org/search?q={}' },
  {
    id: 'wikipedia',
    keyword: 'w',
    name: 'Wikipedia',
    url: 'https://en.wikipedia.org/w/index.php?search={}'
  },
  {
    id: 'youtube',
    keyword: 'yt',
    name: 'YouTube',
    url: 'https://www.youtube.com/results?search_query={}'
  },
  { id: 'github', keyword: 'gh', name: 'GitHub', url: 'https://github.com/search?q={}' },
  { id: 'npm', keyword: 'npm', name: 'npm', url: 'https://www.npmjs.com/search?q={}' },
  { id: 'crates', keyword: 'cr', name: 'crates.io', url: 'https://crates.io/search?q={}' },
  {
    id: 'mdn',
    keyword: 'mdn',
    name: 'MDN',
    url: 'https://developer.mozilla.org/en-US/search?q={}'
  },
  {
    id: 'stackoverflow',
    keyword: 'so',
    name: 'Stack Overflow',
    url: 'https://stackoverflow.com/search?q={}'
  },
  {
    id: 'archwiki',
    keyword: 'aw',
    name: 'Arch Wiki',
    url: 'https://wiki.archlinux.org/index.php?search={}'
  },
  { id: 'aur', keyword: 'aur', name: 'AUR', url: 'https://aur.archlinux.org/packages?K={}' }
]

/**
 * Enabled when the user has chosen nothing.
 *
 * One engine, because every enabled engine shows under every query. A user who
 * wants five gets five by asking for five.
 */
export const DEFAULT_ENGINE_IDS: readonly string[] = ['google']

export function engineById(id: string): WebSearch | undefined {
  return BUILTIN_ENGINES.find((engine) => engine.id === id)
}
