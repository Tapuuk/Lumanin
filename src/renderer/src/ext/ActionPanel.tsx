import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { formatShortcut, formatShortcutCompact } from '@shared/shortcut'
import { isTypeable, keyActionFor, type KeyAction, type KeyMap } from '@shared/keys'
import type { ActionEntry, ActionSection, ActionSet, Entry } from './actions'

/**
 * The action panel: the bar along the bottom, and the list `Ctrl+K` opens.
 *
 * Both read the same {@link ActionSet}, so what the bar says Enter will do and
 * what the overlay runs when you pick the first row cannot disagree. That is the
 * one invariant an action panel has to hold — a launcher whose footer lies about
 * what Enter does is worse than one with no footer.
 */

interface BarProps {
  readonly actions: ActionSet
  /** Navigation depth. Above 1, Esc goes back rather than closing. */
  readonly depth: number
  /** `[keys]`, so every chord the bar advertises is the one the user set. */
  readonly keys: KeyMap
  /** Whether the search box is empty, which decides what a bare key means. */
  readonly searchEmpty: boolean
  readonly onOpen: () => void
}

/**
 * The bar never takes focus. A click on it must not move the caret out of the
 * search field: the field is the only element with a keydown handler, and a
 * button that keeps focus after its click leaves the keyboard landing on a
 * `<button>` that listens for nothing — the same freeze the overlay had.
 */
function keepFocusWhereItIs(event: MouseEvent): void {
  event.preventDefault()
}

/**
 * The chord to advertise for one of the panel's actions, right now.
 *
 * The first binding that would actually fire, rather than the first binding
 * there is: `secondary` ships as Space *and* Ctrl+Enter, and Space is only a key
 * while the search box is empty (see `isTypeable` in `keys.ts`). So the bar says `Space`
 * when Space works and `Ctrl+↵` once you start typing, which is the difference
 * between a hint and a lie.
 */
function chordFor(keys: KeyMap, action: KeyAction, searchEmpty: boolean): string | null {
  const usable = keys[action].find((shortcut) => searchEmpty || !isTypeable(shortcut))
  return usable === undefined ? null : formatShortcutCompact(usable)
}

export function ActionBar({ actions, depth, keys, searchEmpty, onOpen }: BarProps): React.JSX.Element | null {
  if (actions.primary === null && depth <= 1) return null

  // The hint list: every non-primary action that declared a shortcut. The rest
  // are still one Ctrl+K away — a hint without a key to press is just clutter.
  const hinted = actions.flat.filter(
    (action) => action !== actions.primary && action.shortcut !== null
  )
  const secondaryChord = chordFor(keys, 'secondary', searchEmpty)

  return (
    <div className="actionbar">
      <div className="actionbar__hints">
        {actions.primary !== null && (
          <button
            type="button"
            className="actionbar__primary"
            onMouseDown={keepFocusWhereItIs}
            onClick={onOpen}
          >
            <kbd className="actionbar__key">{chordFor(keys, 'open', searchEmpty) ?? '↵'}</kbd>
            <span className="actionbar__label">{actions.primary.title}</span>
          </button>
        )}
        {/* The second action, which has a key whether or not it declared one —
            that is what `secondary` is. Without this the one binding people are
            most likely to have rebound would be the only one never shown. */}
        {secondaryChord !== null && actions.secondary !== null && !hinted.includes(actions.secondary) && (
          <span className="actionbar__item">
            <span className="actionbar__dot" aria-hidden="true">
              ·
            </span>
            <kbd className="actionbar__key">{secondaryChord}</kbd>
            <span className="actionbar__item-title">{actions.secondary.title}</span>
          </span>
        )}
        {hinted.map((action) => (
          <span key={action.id} className="actionbar__item">
            <span className="actionbar__dot" aria-hidden="true">
              ·
            </span>
            <kbd className="actionbar__key">
              {formatShortcutCompact(action.shortcut as NonNullable<typeof action.shortcut>)}
            </kbd>
            <span className="actionbar__item-title">{action.title}</span>
          </span>
        ))}
      </div>
      <span className="actionbar__spacer" />
      {depth > 1 && (
        <span className="actionbar__hint">
          <kbd className="actionbar__key">{chordFor(keys, 'back', searchEmpty) ?? 'Esc'}</kbd> Back
        </span>
      )}
      {actions.flat.length > 1 && (
        <button
          type="button"
          className="actionbar__more"
          onMouseDown={keepFocusWhereItIs}
          onClick={onOpen}
        >
          Actions <kbd className="actionbar__key">{chordFor(keys, 'actionPanel', searchEmpty) ?? ''}</kbd>
        </button>
      )}
    </div>
  )
}

interface OverlayProps {
  readonly actions: ActionSet
  readonly keys: KeyMap
  readonly onRun: (action: ActionEntry) => void
  readonly onClose: () => void
}

/**
 * The overlay.
 *
 * It owns the keyboard while it is open — its own handler runs on a focused
 * container rather than on the search field, so arrow keys move within the
 * overlay and the list beneath it does not move at the same time. Submenus are a
 * *stack* rather than a flatten: an extension that groups eight actions under
 * "Copy as…" meant them to be one row until you ask.
 */
export function ActionOverlay({ actions, keys, onRun, onClose }: OverlayProps): React.JSX.Element {
  const [stack, setStack] = useState<readonly ActionSet[]>([actions])
  const [index, setIndex] = useState(0)
  const container = useRef<HTMLDivElement>(null)

  const current = stack[stack.length - 1] ?? actions
  const entries = flatten(current.sections)

  // Taking the keyboard is a loan, not a transfer. The search input is the only
  // element in the window with a keydown handler, so an overlay that closes
  // without giving focus back leaves every key — typing, Esc, Ctrl+K — landing
  // on `<body>` and doing nothing: the whole launcher reads as frozen. The
  // cleanup runs on unmount, which covers every way out (Esc, scrim click,
  // running an action) without each close path having to remember.
  useEffect(() => {
    const previous = document.activeElement
    container.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    setIndex(0)
  }, [stack.length])

  const activate = (entry: Entry): void => {
    if (entry.kind === 'action') {
      onRun(entry)
      return
    }
    setStack((previous) => [
      ...previous,
      { title: entry.title, sections: entry.sections, primary: null, secondary: null, flat: [] }
    ])
  }

  return (
    <div
      className="overlay"
      // A press on the scrim closes; a press inside must not, which is why the
      // target is compared rather than the event simply being stopped.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="overlay__panel"
        ref={container}
        tabIndex={-1}
        role="listbox"
        aria-label={current.title ?? 'Actions'}
        onKeyDown={(event) => {
          // The overlay has no text field, so a bare-character binding is
          // unambiguous here and `searchEmpty` is true: Space picks the row.
          const bound = keyActionFor(keys, event, { searchEmpty: true })
          if (bound === 'next' || bound === 'previous') {
            event.preventDefault()
            const step = bound === 'next' ? 1 : -1
            setIndex((value) => (value + step + entries.length) % Math.max(entries.length, 1))
            return
          }
          if (bound === 'open' || bound === 'secondary') {
            event.preventDefault()
            const entry = entries[index]
            if (entry !== undefined) activate(entry)
            return
          }
          if (bound === 'back' || event.key === 'ArrowLeft') {
            event.preventDefault()
            // Backing out of a submenu first, and only then out of the panel:
            // Esc always means "one step back", never "two".
            if (stack.length > 1) setStack((previous) => previous.slice(0, -1))
            else onClose()
          }
        }}
      >
        {current.title !== null && <div className="overlay__title">{current.title}</div>}

        {current.sections.map((section, sectionIndex) => (
          <Section
            key={sectionIndex}
            section={section}
            offset={offsetOf(current.sections, sectionIndex)}
            index={index}
            onHover={setIndex}
            onActivate={activate}
          />
        ))}
      </div>
    </div>
  )
}

interface SectionProps {
  readonly section: ActionSection
  readonly offset: number
  readonly index: number
  readonly onHover: (index: number) => void
  readonly onActivate: (entry: Entry) => void
}

function Section({ section, offset, index, onHover, onActivate }: SectionProps): React.JSX.Element {
  return (
    <>
      {section.title !== null && <div className="overlay__section">{section.title}</div>}
      {section.entries.map((entry, entryIndex) => {
        const position = offset + entryIndex
        return (
          <div
            key={entry.id}
            className="overlay__row"
            role="option"
            aria-selected={position === index}
            onMouseEnter={() => onHover(position)}
            onClick={() => onActivate(entry)}
          >
            <span
              className={
                entry.kind === 'action' && entry.destructive
                  ? 'overlay__label overlay__label--destructive'
                  : 'overlay__label'
              }
            >
              {entry.title}
            </span>
            {entry.kind === 'submenu' ? (
              <span className="overlay__chevron" aria-hidden="true">
                ›
              </span>
            ) : (
              entry.shortcut !== null && (
                <kbd className="overlay__key">{formatShortcut(entry.shortcut)}</kbd>
              )
            )}
          </div>
        )
      })}
    </>
  )
}

function flatten(sections: readonly ActionSection[]): readonly Entry[] {
  return sections.flatMap((section) => section.entries)
}

function offsetOf(sections: readonly ActionSection[], upTo: number): number {
  let offset = 0
  for (let index = 0; index < upTo; index++) offset += sections[index]?.entries.length ?? 0
  return offset
}
