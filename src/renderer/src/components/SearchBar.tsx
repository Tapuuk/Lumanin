import { useEffect, useRef, type KeyboardEvent } from 'react'

interface SearchBarProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  /** Bumped by the parent whenever the panel is shown, to re-focus and select. */
  readonly focusToken: number
  /**
   * Overridden by an extension's `searchBarPlaceholder`.
   *
   * The placeholder is the only part of the search field an extension controls,
   * and it earns its keep: "Search issues" tells you what this list is over,
   * which a generic prompt in front of somebody else's data does not.
   */
  readonly placeholder?: string
}

/**
 * The search field. It owns focus for the whole panel: a launcher where you have
 * to click before typing has already failed.
 */
export function SearchBar({ value, onChange, onKeyDown, focusToken, placeholder }: SearchBarProps): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const element = input.current
    if (element === null) return
    element.focus()
    element.select()
  }, [focusToken])

  return (
    <div className="search">
      {/* Inline SVG rather than a glyph: a magnifier is not in every font, and a
          missing glyph renders as a tofu box in exactly the spot the eye lands
          on first. It inherits `currentColor` so themes still control it. */}
      <svg className="search__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        ref={input}
        className="search__input"
        type="text"
        value={value}
        placeholder={placeholder ?? 'Search...'}
        aria-label="Search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
