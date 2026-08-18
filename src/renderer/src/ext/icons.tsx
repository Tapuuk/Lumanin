import { useEffect, useState } from 'react'
import { ICON_SCHEME } from '@shared/identity'
import { Icon } from '@shared/icon'
import { objectProp, str, type RenderValue } from './tree'

/**
 * Drawing an extension's `icon` prop.
 *
 * `Image.ImageLike` is four things at once: an `Icon` enum value, a path into the
 * extension's `assets/`, a URL, or an object with `source`/`tintColor`/`mask`.
 * Sorting out which is the whole job here, and it has to be total — an icon that
 * cannot be resolved must produce a placeholder, never a broken-image glyph or a
 * missing box that shifts the row's text out of column.
 *
 * A full icon set is not built yet (lucide, mapped name→glyph). Until then the mapping below covers the icons that actually turn
 * up in list rows, and everything else falls back to a dot — recessive on
 * purpose, because a wrong-but-confident glyph is worse than an obvious
 * placeholder.
 */

export interface ResolvedIcon {
  /** An `<img>` source, when the icon is a real image. */
  readonly src?: string
  /** A character to draw, when it is not. */
  readonly glyph?: string
  /** A `Color.*` value or raw CSS colour for `tintColor`. */
  readonly tint?: string
}

/**
 * `Icon.*` values we have a character for.
 *
 * Keyed by the **enum member**, not by the string, so it cannot drift from the
 * generated table in `shared/icon.ts`. That matters more than it looks:
 * `Icon.Gear` is `"cog-16"`, `Icon.Info` is `"info-01-16"` and `Icon.Bubble` is
 * `"speech-bubble-16"` — every one of which was wrong when this map was first
 * written out by hand, and each wrong entry is an accessory that silently
 * renders as a placeholder dot.
 *
 * Deliberately partial. A full set is not built yet (lucide, mapped
 * name→glyph); these are the ones that turn up in list rows and
 * accessories often enough that a generic dot would make a list unreadable.
 */
const GLYPHS: Readonly<Record<string, string>> = {
  [Icon.MagnifyingGlass]: '⌕',
  [Icon.ArrowClockwise]: '↻',
  [Icon.ArrowRight]: '→',
  [Icon.ArrowLeft]: '←',
  [Icon.ArrowUp]: '↑',
  [Icon.ArrowDown]: '↓',
  [Icon.ArrowUpCircle]: '▲',
  [Icon.ArrowDownCircle]: '▼',
  [Icon.ChevronRight]: '›',
  [Icon.ChevronLeft]: '‹',
  [Icon.ChevronUp]: '˄',
  [Icon.ChevronDown]: '˅',
  [Icon.Plus]: '+',
  [Icon.Minus]: '−',
  [Icon.XMarkCircle]: '✕',
  [Icon.CheckCircle]: '✓',
  [Icon.Check]: '✓',
  [Icon.Circle]: '○',
  [Icon.CircleFilled]: '●',
  [Icon.Dot]: '•',
  [Icon.Star]: '☆',
  [Icon.StarCircle]: '★',
  [Icon.Heart]: '♥',
  [Icon.Bookmark]: '⚑',
  [Icon.Bubble]: '◌',
  [Icon.Clock]: '◷',
  [Icon.Calendar]: '▤',
  [Icon.Trash]: '␡',
  [Icon.Pencil]: '✎',
  [Icon.Document]: '▢',
  [Icon.Folder]: '▭',
  [Icon.Link]: '⌘',
  [Icon.Globe]: '⊕',
  [Icon.House]: '⌂',
  [Icon.Gear]: '⚙',
  [Icon.Terminal]: '❯',
  [Icon.Code]: '‹›',
  [Icon.Info]: 'ℹ',
  [Icon.ExclamationMark]: '!',
  [Icon.Warning]: '⚠',
  [Icon.QuestionMark]: '?',
  [Icon.Lock]: '⚿',
  [Icon.Eye]: '◉',
  [Icon.EyeDisabled]: '◌',
  [Icon.Download]: '⤓',
  [Icon.Upload]: '⤒',
  [Icon.Envelope]: '✉',
  [Icon.Person]: '☺',
  [Icon.Tag]: '⌗',
  [Icon.Text]: '¶',
  [Icon.Image]: '▣',
  [Icon.Video]: '▶',
  [Icon.Play]: '▶',
  [Icon.Pause]: '‖',
  [Icon.Bolt]: '⚡',
  [Icon.LightBulb]: '☼',
  [Icon.Stars]: '✦',
  [Icon.Wand]: '✧',
  [Icon.Hashtag]: '#',
  [Icon.Filter]: '≡',
  [Icon.Pin]: '⚑',
  [Icon.Bell]: '⍾',
  [Icon.SaveDocument]: '⤓',
  [Icon.Coin]: '◎',
  [Icon.Book]: '▥',
  [Icon.BulletPoints]: '≣',
  [Icon.Bug]: '☣',
  [Icon.Cloud]: '☁',
  [Icon.Key]: '⚿',
  [Icon.Map]: '▦',
  [Icon.Flag]: '⚐',
  [Icon.Sun]: '☀',
  [Icon.Moon]: '☽'
}

/** The placeholder. Same box as a real icon, so nothing moves when one resolves. */
const FALLBACK = '•'

/**
 * Resolve an `icon` prop against the extension it came from.
 *
 * `extension` is needed because an asset path is relative to *that* extension's
 * `assets/` directory, and the renderer must never be handed a filesystem path
 * It builds a `lumanin-icon://ext/<name>/<path>` URL and
 * main decides what it is willing to serve.
 */
export function resolveIcon(value: RenderValue | undefined, extension: string): ResolvedIcon | null {
  if (value === undefined || value === null) return null

  const object = objectProp(value)
  if (object !== null) {
    // `{fileIcon}` — the icon of a file on disk. Resolving one needs the desktop's
    // icon theme and a mime lookup, which is main's job and is not built yet.
    if (object['fileIcon'] !== undefined) return { glyph: '▤' }

    const tint = str(object['tintColor']) ?? tintFromDynamic(object['tintColor'])
    // `{value, tooltip}` wrappers and `{source}` both unwrap the same way.
    const source = object['source'] ?? object['value']
    if (source === undefined) return tint === null ? null : { glyph: FALLBACK, tint }

    const inner = resolveIcon(source, extension)
    if (inner === null) return null
    return tint === null ? inner : { ...inner, tint }
  }

  const name = str(value)
  if (name === null || name.length === 0) return null

  const glyph = GLYPHS[name]
  if (glyph !== undefined) return { glyph }

  // An `Icon.*` value we have no character for. Recognised by its shape — every
  // one of the 478 ends in a size suffix — so an unmapped icon becomes a dot
  // rather than a request for an asset called `airplane-16` that does not exist.
  if (/-\d+$/.test(name)) return { glyph: FALLBACK }

  if (/^(https?:|data:)/i.test(name)) return { src: normalizeDataUri(name) }

  // `system:folder,inode-directory` — an icon from the desktop's own icon theme,
  // by freedesktop name, with fallbacks after the first comma. This is what lets
  // a plugin's file listing look like the file manager sitting next to it rather
  // than like a set of glyphs we drew, and it is deliberately a *source*
  // convention rather than a new export: the API surface is the spec's shape and
  // nothing of our own invention belongs in it.
  if (name.startsWith('system:')) return { src: themeIconUrl(name.slice('system:'.length)) }

  // Anything else is an asset path relative to the extension's `assets/`.
  return { src: assetUrl(extension, name) }
}

/**
 * A light/dark `Color.Dynamic`.
 *
 * The panel has one appearance at a time and the theme decides which, so the
 * pair is resolved by asking the document rather than by guessing — the theme
 * runtime sets `color-scheme` on `:root`, which is exactly this question.
 */
function tintFromDynamic(value: RenderValue | undefined): string | null {
  const dynamic = objectProp(value)
  if (dynamic === null) return null
  const dark = document.documentElement.style.colorScheme !== 'light'
  return str(dynamic[dark ? 'dark' : 'light'])
}

/**
 * Repair an inline SVG data URI that was never percent-encoded.
 *
 * Extensions build these by hand — `data:image/svg+xml,<svg ...fill="#DD7949">`
 * — and a raw `#` inside one starts the URI's *fragment*, so the browser
 * silently loads a truncated document and draws nothing. Raycast accepts these,
 * so we have to as well; the row would otherwise be missing an icon for a reason
 * no extension author could guess from their own code.
 *
 * Only unencoded payloads are touched. One that already contains `%` escapes is
 * left exactly as it is, because re-encoding it would turn `%3C` into `%253C`.
 */
function normalizeDataUri(value: string): string {
  const match = /^(data:image\/svg\+xml)(;[^,]*)?,(.*)$/is.exec(value)
  if (match === null) return value
  const parameters = match[2] ?? ''
  const payload = match[3] ?? ''
  if (parameters.includes('base64') || !payload.includes('<')) return value
  return `${match[1] ?? ''}${parameters},${encodeURIComponent(payload)}`
}

/**
 * A themed-icon URL. Main resolves the name against the icon theme and serves
 * the file; the renderer never learns where it was.
 */
export function themeIconUrl(names: string): string {
  return `${ICON_SCHEME}://theme/${encodeURIComponent(names)}`
}

export function assetUrl(extension: string, path: string): string {
  return `${ICON_SCHEME}://ext/${encodeURIComponent(extension)}/${path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`
}

/**
 * Map a `Color.*` value onto a theme token.
 *
 * Semantic tokens rather than fixed hexes: an extension asking
 * for `Color.Red` means "the danger colour", and on a light theme that is a
 * different red from the one on a dark theme. Anything unrecognised is passed
 * through as CSS — the spec allows a raw colour string, and refusing it would
 * break `tintColor="#ff0088"`, which is legal and common.
 */
export function colorToken(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value.length === 0) return undefined
  const tokens: Readonly<Record<string, string>> = {
    'raycast-blue': 'var(--lumanin-info)',
    'raycast-green': 'var(--lumanin-ok)',
    'raycast-red': 'var(--lumanin-err)',
    'raycast-yellow': 'var(--lumanin-warn)',
    'raycast-orange': 'var(--lumanin-warn)',
    'raycast-purple': 'var(--lumanin-accent)',
    'raycast-magenta': 'var(--lumanin-accent)',
    'raycast-primary-text': 'var(--lumanin-text)',
    'raycast-secondary-text': 'var(--lumanin-text-muted)'
  }
  return tokens[value] ?? value
}

/**
 * What a broken image degrades to.
 *
 * A remote URL that fails is almost always a favicon fetch (`getFavicon`
 * produces `https://site/favicon.ico`, which 404s constantly), and a globe says
 * "a website" the way a dot cannot. Everything else — a missing asset, a bad
 * data URI — falls back to the same dot every unresolvable icon gets.
 */
export function fallbackGlyphFor(src: string): string {
  return /^https?:/i.test(src) ? (GLYPHS[Icon.Globe] ?? FALLBACK) : FALLBACK
}

interface IconImageProps {
  readonly src: string
  readonly tint?: string | undefined
  /** What a failed load degrades to, when the caller knows better than the dot. */
  readonly fallback?: string | undefined
}

/**
 * An icon `<img>` that can fail politely.
 *
 * Chromium draws a failed `<img>` as the broken-image glyph — exactly the
 * "missing box" `resolveIcon`'s contract forbids — so an error swaps in a glyph
 * in the same box and nothing in the row moves. The failure is remembered per
 * `src`: a re-render with the same dead URL must not retry and flash, and a
 * *new* URL deserves a fresh attempt.
 */
export function IconImage({ src, tint, fallback }: IconImageProps): React.JSX.Element {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  useEffect(() => {
    // A new src invalidates a failure recorded against the old one.
    setFailedSrc((failed) => (failed === src ? failed : null))
  }, [src])

  if (failedSrc === src) {
    return (
      <span
        className="result__glyph"
        aria-hidden="true"
        style={tint === undefined ? undefined : { color: colorToken(tint) }}
      >
        {fallback ?? fallbackGlyphFor(src)}
      </span>
    )
  }

  return <img src={src} alt="" draggable={false} onError={() => setFailedSrc(src)} />
}

interface IconProps {
  readonly icon: ResolvedIcon | null
  /** Drawn when there is no icon at all, so the column keeps its width. */
  readonly placeholder?: string
}

export function ExtIcon({ icon, placeholder }: IconProps): React.JSX.Element {
  if (icon === null) {
    return (
      <span className="result__icon">
        <span className="result__glyph" aria-hidden="true">
          {placeholder ?? ''}
        </span>
      </span>
    )
  }

  return (
    <span className="result__icon">
      {icon.src !== undefined ? (
        <IconImage src={icon.src} tint={icon.tint} />
      ) : (
        <span
          className="result__glyph"
          aria-hidden="true"
          style={icon.tint === undefined ? undefined : { color: colorToken(icon.tint) }}
        >
          {icon.glyph ?? FALLBACK}
        </span>
      )}
    </span>
  )
}
