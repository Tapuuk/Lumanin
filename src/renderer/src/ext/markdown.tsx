import { Fragment, useMemo, type ReactNode } from 'react'
import { linkTarget } from '@shared/link'

/**
 * Markdown, rendered to React elements — never to HTML.
 *
 * Rendered markdown must be sanitised with no raw HTML passthrough. The usual shape of that is a parser plus a sanitiser, where
 * the sanitiser is the only thing standing between an extension's `Detail` and
 * script execution inside our window, and where being one CVE behind is a real
 * risk that grows on someone else's schedule.
 *
 * This produces React elements directly. `dangerouslySetInnerHTML` is never
 * used, so an extension's `<script>` is not "stripped" — it is *text*, drawn as
 * the characters it consists of, because there is no code path that could turn a
 * string into markup. That is a stronger guarantee than a sanitiser can offer,
 * and it costs a small parser instead of a dependency.
 *
 * The subset is what documentation actually uses: headings, paragraphs, fenced
 * and inline code, lists, block quotes, rules, links, images, bold and italic.
 * Tables are not here yet, and a table renders as its source rather than as
 * nothing, which at least keeps the content readable.
 */

interface MarkdownProps {
  readonly source: string
  /** Images resolve against this extension's assets. */
  readonly extension: string
  /**
   * Must be a stable reference. It is half of what decides whether a source is
   * re-parsed, so a caller that passes a fresh arrow function parses the whole
   * document again on every render of the view around it.
   */
  readonly resolveAsset: (path: string) => string
}

export function Markdown({ source, extension, resolveAsset }: MarkdownProps): React.JSX.Element {
  void extension
  // Parsing is a walk over every line of the document, and a detail pane
  // re-renders for reasons the document knows nothing about: a keystroke in the
  // search box, a selection moving, a patch arriving elsewhere in the tree.
  const parsed = useMemo(() => blocks(source, resolveAsset), [source, resolveAsset])
  return <div className="md">{parsed}</div>
}

function blocks(source: string, asset: (path: string) => string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: ReactNode[] = []
  let index = 0
  let key = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    // Fenced code. Everything up to the closing fence is literal — including
    // markdown syntax, which is the entire point of a fence.
    const fence = /^\s*```+\s*([\w-]*)\s*$/.exec(line)
    if (fence !== null) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```+\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      out.push(
        <pre className="md__code" key={key++}>
          <code data-language={fence[1] ?? ''}>{body.join('\n')}</code>
        </pre>
      )
      continue
    }

    if (line.trim().length === 0) {
      index += 1
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(<hr className="md__rule" key={key++} />)
      index += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const level = Math.min(heading[1]?.length ?? 1, 6)
      const Tag = `h${String(level)}` as 'h1'
      out.push(
        <Tag className="md__heading" key={key++}>
          {inline(heading[2] ?? '', asset)}
        </Tag>
      )
      index += 1
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? '')) {
        body.push((lines[index] ?? '').replace(/^\s*>\s?/, ''))
        index += 1
      }
      out.push(
        <blockquote className="md__quote" key={key++}>
          {blocks(body.join('\n'), asset)}
        </blockquote>
      )
      continue
    }

    const bullet = /^\s*([-*+]|\d+[.)])\s+/.exec(line)
    if (bullet !== null) {
      const ordered = /\d/.test(bullet[1] ?? '')
      const items: string[] = []
      while (index < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*([-*+]|\d+[.)])\s+/, ''))
        index += 1
      }
      const Tag = ordered ? 'ol' : 'ul'
      out.push(
        <Tag className="md__list" key={key++}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{inline(item, asset)}</li>
          ))}
        </Tag>
      )
      continue
    }

    // A paragraph runs until a blank line or the start of another block.
    const paragraph: string[] = []
    while (index < lines.length) {
      const next = lines[index] ?? ''
      if (next.trim().length === 0) break
      if (/^(#{1,6})\s|^\s*```|^\s*>|^\s*([-*+]|\d+[.)])\s/.test(next)) break
      paragraph.push(next)
      index += 1
    }
    out.push(
      <p className="md__paragraph" key={key++}>
        {inline(paragraph.join(' '), asset)}
      </p>
    )
  }

  return out
}

/**
 * Inline formatting.
 *
 * One pass with an alternation rather than nested passes: nesting means running
 * a regex over text a previous rule already replaced, which is how `**a `code`
 * b**` ends up with a literal asterisk in it.
 */
const INLINE = /(`[^`]+`)|(!\[[^\]]*\]\([^)]+\))|(\[[^\]]*\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)/

function inline(text: string, asset: (path: string) => string): ReactNode {
  const out: ReactNode[] = []
  let rest = text
  let key = 0

  while (rest.length > 0) {
    const match = INLINE.exec(rest)
    if (match === null || match.index === undefined) {
      out.push(rest)
      break
    }

    if (match.index > 0) out.push(rest.slice(0, match.index))
    const token = match[0]
    rest = rest.slice(match.index + token.length)

    if (token.startsWith('`')) {
      out.push(
        <code className="md__inline-code" key={key++}>
          {token.slice(1, -1)}
        </code>
      )
      continue
    }

    if (token.startsWith('![')) {
      const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(token)
      const source = image?.[2] ?? ''
      out.push(
        <img
          className="md__image"
          key={key++}
          src={/^(https?:|data:)/i.test(source) ? source : asset(source)}
          alt={image?.[1] ?? ''}
          draggable={false}
        />
      )
      continue
    }

    if (token.startsWith('[')) {
      const link = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(token)
      const href = link?.[2] ?? ''
      const label = link?.[1] ?? href
      const target = linkTarget(href)
      // Not an `<a>`. In-page navigation is blocked in the renderer, so
      // a real anchor would either do nothing or need an exception; a web
      // link asks main to open it in the user's browser, which is what a
      // link in a launcher means anyway. Anything else is drawn as text:
      // the panel cannot open it, and a dead button would look live.
      out.push(
        target.kind === 'web' ? (
          <button
            className="md__link"
            type="button"
            key={key++}
            onClick={() => {
              void window.lumanin.invoke('search.launch', { id: `web:${target.url}` })
            }}
          >
            {label}
          </button>
        ) : (
          <span className="md__link md__link--inert" title={href} key={key++}>
            {label}
          </span>
        )
      )
      continue
    }

    if (token.startsWith('**')) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
      continue
    }

    out.push(<em key={key++}>{token.slice(1, -1)}</em>)
  }

  return <Fragment>{out}</Fragment>
}
