import { isOpenableUrl } from './websearch'

export type LinkTarget = { kind: 'web'; url: string } | { kind: 'text' }

/**
 * The panel draws a control only for what it can actually open. A link that
 * looks live and is not is worse than plain text, so anything main would
 * refuse (`isOpenableUrl`) is drawn as text with the target in its title.
 */
export function linkTarget(href: string): LinkTarget {
  return isOpenableUrl(href) ? { kind: 'web', url: href } : { kind: 'text' }
}
