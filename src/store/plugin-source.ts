/**
 * `lumanin plugin-install <url>` — where the code comes from.
 *
 * This is the sharpest edge in the product: a URL goes in and third-party code
 * that will run as the user comes out. Everything here is therefore about being
 * *specific* — which transports we accept, which repository, which commit, and
 * what we can tell the user before anything runs.
 *
 * Parsing is a pure function and lives apart from the fetching so it can be
 * tested exhaustively. A URL parser that quietly accepts one more shape than it
 * meant to is exactly how "install from a public repo" becomes "install from
 * anywhere".
 */

/** What a parsed argument turned out to name. */
export interface PluginSource {
  /** The clone URL, always `https:`. */
  readonly remote: string
  /** Host and path, for the consent screen: `github.com/owner/repo`. */
  readonly label: string
  /** A branch or tag to check out, or `null` for the repository's default. */
  readonly ref: string | null
  /**
   * A directory inside the repository, or `null` for its root.
   *
   * Supported because a monorepo is a normal way to publish several plugins, and
   * because the URL GitHub puts in the address bar while you browse a
   * subdirectory already contains it — so pasting what you are looking at works.
   */
  readonly subdirectory: string | null
}

export class PluginSourceError extends Error {}

/**
 * Hosts whose browse-URLs we understand well enough to pull a ref and a
 * subdirectory out of. Anything else still works — it is just treated as a plain
 * clone URL, because the shape of another forge's web UI is not something to
 * guess at.
 */
const BROWSE_URL_HOSTS: Readonly<Record<string, readonly string[]>> = {
  'github.com': ['tree', 'blob'],
  'gitlab.com': ['-/tree', '-/blob'],
  'codeberg.org': ['src/branch', 'src/tag']
}

/**
 * Parse what the user typed.
 *
 * Accepts:
 *   owner/repo                                   → GitHub, the obvious shorthand
 *   https://host/owner/repo[.git]
 *   https://github.com/owner/repo/tree/<ref>[/<path>]
 *   https://gitlab.com/owner/repo/-/tree/<ref>[/<path>]
 *
 * Refuses everything that is not `https:`. Not because a URL can be injected —
 * every command here takes an argv array — but because `git://` and `http://`
 * are unauthenticated transports, and "install and run this code" over a channel
 * anyone on the path can rewrite is not a thing to offer. `ssh://` is refused
 * for a different reason: it would silently use the user's keys, so the failure
 * mode of a typo'd URL is an authentication prompt rather than a clean error.
 */
export function parsePluginSource(input: string): PluginSource {
  const trimmed = input.trim()
  if (trimmed.length === 0) throw new PluginSourceError('no repository given')

  // The shorthand. Deliberately narrow: two path segments, no scheme, no dots
  // that would make it look like a host someone meant to type in full.
  const shorthand = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?$/.exec(trimmed)
  const shortOwner = shorthand?.[1]
  const shortName = shorthand?.[2]
  if (
    shortOwner !== undefined &&
    shortName !== undefined &&
    !trimmed.includes('://') &&
    !shortOwner.includes('.')
  ) {
    return {
      remote: `https://github.com/${shortOwner}/${shortName}.git`,
      label: `github.com/${shortOwner}/${shortName}`,
      ref: null,
      subdirectory: null
    }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new PluginSourceError(
      `"${trimmed}" is not a repository URL.\n` +
        'Give an https:// URL, or the owner/repo shorthand for GitHub.'
    )
  }

  if (url.protocol !== 'https:') {
    throw new PluginSourceError(
      `${url.protocol}// is not accepted - only https://.\n` +
        (url.protocol === 'http:'
          ? 'Plain http can be rewritten by anyone between you and the server, and this\n' +
            'installs code that runs as you.'
          : url.protocol === 'ssh:' || url.protocol === 'git+ssh:'
            ? 'An ssh remote would use your keys, so a mistyped URL becomes a password\n' +
              'prompt instead of an error. Use the https URL for the same repository.'
            : 'That transport is not something this will fetch code over.')
    )
  }

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length < 2) {
    throw new PluginSourceError(`${url.href} does not name a repository`)
  }

  const owner = segments[0] as string
  const repo = (segments[1] as string).replace(/\.git$/, '')
  const rest = segments.slice(2)

  // A browse URL, if this is a host whose web layout we know.
  let ref: string | null = null
  let subdirectory: string | null = null

  const markers = BROWSE_URL_HOSTS[url.hostname]
  if (markers !== undefined && rest.length > 0) {
    const joined = rest.join('/')
    for (const marker of markers) {
      const prefix = `${marker}/`
      if (!joined.startsWith(prefix)) continue
      const tail = joined.slice(prefix.length).split('/').filter((part) => part.length > 0)
      if (tail.length === 0) break
      ref = tail[0] as string
      subdirectory = tail.length > 1 ? tail.slice(1).join('/') : null
      break
    }
  }

  // A path we could not account for is refused rather than ignored. Silently
  // dropping it would install the repository root while the user is looking at
  // a URL that says otherwise.
  if (ref === null && rest.length > 0) {
    throw new PluginSourceError(
      `${url.href} has a path this does not understand.\n` +
        `Give the repository URL (https://${url.hostname}/${owner}/${repo}), or a\n` +
        'browse URL from GitHub, GitLab or Codeberg pointing at the plugin directory.'
    )
  }

  return {
    remote: `https://${url.host}/${owner}/${repo}.git`,
    label: `${url.hostname}/${owner}/${repo}`,
    ref,
    subdirectory: normalizeSubdirectory(subdirectory)
  }
}

/**
 * A subdirectory must stay inside the checkout.
 *
 * `..` here would make the "directory in the repository" into a path anywhere on
 * disk once joined, which is a directory traversal with a very friendly-looking
 * front door.
 *
 * Unreachable from a URL, as it turns out: `new URL()` normalises `..` out of
 * the pathname before this sees it, so a traversal arrives as a path with no
 * `tree/` marker and is refused a few lines above. Kept anyway — this is the
 * check that still holds if a caller ever hands us a path that did not come
 * through the URL parser, and `pluginDirectory` in `plugin.ts` is the third.
 */
function normalizeSubdirectory(subdirectory: string | null): string | null {
  if (subdirectory === null) return null
  const parts = subdirectory.split('/').filter((part) => part.length > 0)
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new PluginSourceError('the path inside the repository may not contain ".."')
  }
  return parts.length === 0 ? null : parts.join('/')
}

/** A directory name that cannot collide between two different repositories. */
export function checkoutName(source: PluginSource): string {
  return source.label.replace(/[^A-Za-z0-9._-]+/g, '-')
}
