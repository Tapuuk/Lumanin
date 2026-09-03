import { memo, useLayoutEffect, useRef, type Ref } from 'react'
import { ACTION_LABELS, type ResultItem, type ResultKind } from '@shared/ipc'
import { IconImage } from '../ext/icons'

/**
 * What stands in for an icon on the kinds that have none.
 *
 * Typographic rather than drawn: these sit in the same 26px box as a real
 * application icon, and anything with detail at that size next to a full-colour
 * app icon reads as a broken image rather than as a symbol.
 */
const KIND_GLYPHS: Readonly<Record<ResultKind, string>> = {
  app: '',
  command: '❯',
  calculator: '=',
  web: '↗',
  // An extension command, at the root. The same chevron as a built-in command,
  // because at the root that is exactly what it is — where it came from is not
  // something the user is choosing between.
  extension: '❯',
  // A command line the user configured themselves. `$` rather than the chevron
  // the other two use, because this one *is* a shell line and the difference is
  // worth seeing: it runs with no window, no notification and no error dialog.
  shell: '$'
}

/**
 * The results region.
 *
 * One line per result: icon, name, nothing else — for applications, which are
 * most rows. A second column of grey text under every name competes with the
 * thing being looked for, so a subtitle is rendered only where the row would be
 * meaningless without one: a calculation's expression under its answer, and what
 * a web search is going to search. An application still gets a bare name.
 *
 * The action label is drawn only on the selected row, for the same reason. What
 * Enter does changes by kind now — open, run, copy, search — and a row that does
 * something other than "open" has to say so before it is pressed, but only the
 * row about to be pressed needs to.
 *
 * It reports its full content height to the panel sizer and is allowed to
 * overflow: the window grows to fit until it reaches the configured ceiling, and
 * only then does this scroll. It never invents placeholder rows, and it is not
 * rendered at all when there is nothing to show, so a fruitless search costs the
 * panel no height.
 */

/**
 * The three-dot search mark, drawn over an app-connected plugin's icon.
 *
 * The icon underneath is the target application's own — Godot's, Steam's — and
 * these dots are what says "a search of it" rather than "it". One SVG stamped by
 * the renderer, never baked into an image, so every search row wears exactly the
 * same mark and it recolours with the theme: text-coloured dots, outlined in the
 * panel background so they read on any logo.
 *
 * Geometry against the 26px icon box: three 5px squares, 1.5px apart, centred.
 */
function SearchBadge(): React.JSX.Element {
  return (
    <svg className="result__badge" viewBox="0 0 26 26" aria-hidden="true">
      {[4, 10.5, 17].map((x) => (
        <rect key={x} x={x} y={10.5} width={5} height={5} rx={1.2} />
      ))}
    </svg>
  )
}

interface ResultListProps {
  /** Never empty: the panel omits this section entirely when there is nothing. */
  readonly items: readonly ResultItem[]
  readonly selectedIndex: number
  /**
   * Must be a stable reference. Every row holds on to it, so a caller that
   * passes a fresh arrow function re-renders the whole list on every arrow key.
   */
  readonly onActivate: (item: ResultItem) => void
}

interface ResultRowProps {
  readonly item: ResultItem
  readonly selected: boolean
  readonly onActivate: (item: ResultItem) => void
  /**
   * Set on the selected row only, so the list can scroll it into view. A named
   * prop rather than `ref` because this one has to take part in the shallow
   * compare below.
   */
  readonly rowRef?: Ref<HTMLDivElement> | undefined
}

/**
 * One result.
 *
 * Memoized: a selection change is two rows changing, not the whole list, and
 * every row body it skips is an `IconImage` — a component with state and an
 * effect — that does not have to run again.
 */
const ResultRow = memo(function ResultRow({
  item,
  selected,
  onActivate,
  rowRef
}: ResultRowProps): React.JSX.Element {
  return (
    <div
      ref={rowRef}
      className="result"
      // Drives the per-kind tint in `base.css`. An attribute rather than a
      // class because the stylesheet maps it to one custom property and
      // everything else reads that — adding a kind is one rule, not five.
      data-kind={item.kind}
      role="option"
      aria-selected={selected}
      // Mouse activation is a single click, not a double: the list is a
      // command palette, not a file manager.
      onClick={() => onActivate(item)}
    >
      <span className="result__icon">
        {item.icon !== undefined ? (
          // Decorative: the name beside it already says what this is, so an
          // alt text would just be read twice by a screen reader. `IconImage`
          // rather than a bare `<img>` because a plugin row's icon can 404 —
          // a `search:` icon for an app that is not installed — and the
          // failure has to degrade to the kind's glyph, not a broken image.
          <>
            <IconImage src={item.icon} fallback={KIND_GLYPHS[item.kind]} />
            {item.badge === 'search' && <SearchBadge />}
          </>
        ) : (
          // Applications have icons; commands, sums and searches do not, and
          // a blank column beside them made the list read as two lists. The
          // glyph is decorative for the same reason the icon is — the action
          // label on the right already names what Enter does.
          <span className="result__glyph" aria-hidden="true">
            {KIND_GLYPHS[item.kind]}
          </span>
        )}
      </span>
      <span className="result__text">
        <span className="result__title">{item.title}</span>
        {item.subtitle !== undefined && <span className="result__subtitle">{item.subtitle}</span>}
      </span>
      {selected && <span className="result__action">{ACTION_LABELS[item.kind]}</span>}
    </div>
  )
})

export const ResultList = memo(function ResultList({
  items,
  selectedIndex,
  onActivate
}: ResultListProps): React.JSX.Element {
  const selected = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    // Once the panel has hit its ceiling the list scrolls, so the selection can
    // leave the viewport while the search field stays put. Before paint, so a
    // moved selection is never shown off-screen first.
    selected.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  return (
    <div className="results" role="listbox" aria-label="Results">
      {items.map((item, index) => (
        <ResultRow
          key={item.id}
          item={item}
          selected={index === selectedIndex}
          onActivate={onActivate}
          rowRef={index === selectedIndex ? selected : undefined}
        />
      ))}
    </div>
  )
})
