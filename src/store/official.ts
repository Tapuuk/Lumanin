/**
 * The official plugin index — one JSON file in the Lumanin-Plugins repository.
 *
 * This is discovery, not distribution: the index maps names to directories in
 * that repository, and installing goes through the exact same
 * `plugin-install` machinery as any pasted URL, consent screen included. We
 * host a list; the code's provenance stays what it always was.
 *
 * Fetched only when the user asks to browse — the launcher makes no network
 * requests on its own, and this module is the one place that rule bends, on an
 * explicit click.
 */

export const OFFICIAL_REPOSITORY = 'https://github.com/Tapuuk/Lumanin-Plugins'

const INDEX_URL = 'https://raw.githubusercontent.com/Tapuuk/Lumanin-Plugins/main/plugins.json'

const FETCH_TIMEOUT_MS = 8_000

export interface OfficialPlugin {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly author: string
  /** The install source: the browse URL of the plugin's folder. */
  readonly source: string
}

export interface OfficialIndex {
  readonly ok: boolean
  readonly error?: string
  readonly plugins: readonly OfficialPlugin[]
}

/** Fetch and validate the index. Failure is a message, never a throw. */
export async function fetchOfficialIndex(
  fetchImpl: typeof fetch = fetch
): Promise<OfficialIndex> {
  let raw: unknown
  try {
    const reply = await fetchImpl(INDEX_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' }
    })
    if (!reply.ok) {
      return {
        ok: false,
        error: `the plugin index answered ${String(reply.status)} - try again later`,
        plugins: []
      }
    }
    raw = await reply.json()
  } catch (cause) {
    return {
      ok: false,
      error: `could not reach the plugin index - ${cause instanceof Error ? cause.message : String(cause)}`,
      plugins: []
    }
  }

  return { ok: true, plugins: parseIndex(raw) }
}

/**
 * Entries that do not hold their shape are dropped one by one rather than
 * failing the whole list — a half-broken index still serves what it can.
 */
export function parseIndex(raw: unknown): readonly OfficialPlugin[] {
  if (typeof raw !== 'object' || raw === null) return []
  const list = (raw as Record<string, unknown>)['plugins']
  if (!Array.isArray(list)) return []

  const plugins: OfficialPlugin[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const name = record['name']
    const title = record['title']
    const description = record['description']
    const author = record['author']
    const directory = record['directory']
    if (
      typeof name !== 'string' ||
      typeof title !== 'string' ||
      typeof description !== 'string' ||
      typeof author !== 'string' ||
      typeof directory !== 'string'
    ) {
      continue
    }
    // The directory becomes a URL path segment; anything that could climb out
    // of `plugins/` or smuggle a query is not a folder name.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(directory)) continue
    plugins.push({
      name,
      title,
      description,
      author,
      source: `${OFFICIAL_REPOSITORY}/tree/main/plugins/${directory}`
    })
  }
  return plugins
}
