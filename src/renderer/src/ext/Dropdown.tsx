import { useEffect, useRef, useState } from 'react'
import { elementChildren, handler, str, type RenderNode } from './tree'

/**
 * `<List searchBarAccessory={<List.Dropdown/>}/>` — the filter beside the search
 * field.
 *
 * More load-bearing than it looks. Extensions commonly gate their fetch on the
 * dropdown's value (`usePromise(getStories, [topic], {execute: !!topic})`), so a
 * dropdown that renders but never reports a selection leaves the command
 * permanently empty and looking like a network failure.
 *
 * Which is why the **`defaultValue` fires on mount**. Raycast does the same, and
 * without it the extension above never loads anything at all until the user
 * opens a menu they have no reason to think matters.
 */

interface DropdownProps {
  readonly node: RenderNode
  readonly onEvent: (handlerId: string | null, payload?: unknown) => void
}

interface Choice {
  readonly id: string
  readonly title: string
  readonly value: string
  readonly sectionTitle: string | null
}

export function Dropdown({ node, onEvent }: DropdownProps): React.JSX.Element | null {
  const choices = readChoices(node)
  const onChange = handler(node.props['onChange'])
  const controlled = str(node.props['value'])
  const fallback = str(node.props['defaultValue']) ?? choices[0]?.value ?? null

  const [selected, setSelected] = useState<string | null>(controlled ?? fallback)
  const [open, setOpen] = useState(false)
  const announced = useRef<string | null>(null)

  // The initial `onChange`. Guarded by a ref rather than by an empty dependency
  // list: the choices arrive in a later patch than the dropdown itself, so the
  // value worth announcing is often not known on the first render.
  const value = controlled ?? selected ?? fallback
  useEffect(() => {
    if (value === null || announced.current === value) return
    announced.current = value
    onEvent(onChange, value)
  }, [value, onChange, onEvent])

  if (choices.length === 0) return null

  const current = choices.find((choice) => choice.value === value) ?? choices[0]
  const tooltip = str(node.props['tooltip']) ?? 'Filter'

  return (
    <div className="dropdown">
      <button
        type="button"
        className="dropdown__button"
        title={tooltip}
        aria-label={tooltip}
        aria-expanded={open}
        // `tabIndex={-1}`: the search field owns focus for the panel's whole
        // life, and a dropdown that could take it would break typing.
        tabIndex={-1}
        onMouseDown={(event) => {
          event.preventDefault()
          setOpen((previous) => !previous)
        }}
      >
        <span className="dropdown__value">{current?.title ?? ''}</span>
        <span className="dropdown__chevron" aria-hidden="true">
          ⌄
        </span>
      </button>

      {open && (
        <div
          className="overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        >
          <div className="overlay__panel dropdown__menu" role="listbox" aria-label={tooltip}>
            {choices.map((choice, index) => (
              <div key={choice.id}>
                {choice.sectionTitle !== null &&
                  choice.sectionTitle !== choices[index - 1]?.sectionTitle && (
                    <div className="overlay__section">{choice.sectionTitle}</div>
                  )}
                <div
                  className="overlay__row"
                  role="option"
                  aria-selected={choice.value === value}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    setOpen(false)
                    setSelected(choice.value)
                    announced.current = choice.value
                    onEvent(onChange, choice.value)
                  }}
                >
                  <span className="overlay__label">{choice.title}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function readChoices(node: RenderNode): readonly Choice[] {
  const choices: Choice[] = []

  const collect = (parent: RenderNode, sectionTitle: string | null): void => {
    for (const child of elementChildren(parent)) {
      if (child.type.endsWith('.Section')) {
        collect(child, str(child.props['title']))
        continue
      }
      if (!child.type.endsWith('.Item')) continue
      const value = str(child.props['value'])
      if (value === null) continue
      choices.push({
        id: child.id,
        title: str(child.props['title']) ?? value,
        value,
        sectionTitle
      })
    }
  }

  collect(node, null)
  return choices
}
