import { useEffect, type RefObject } from 'react'
import { isCaptureActive } from './controls'
import { SECTIONS, type SectionId } from './sections'

/**
 * The shell's own keys, one window listener in the bubble phase so anything
 * that stops propagation (a chord capture, a modal) wins:
 *
 * - Ctrl+1..4 switch sections, from anywhere.
 * - Ctrl+F anywhere, or / outside a text field, focuses the sidebar filter.
 * - Up and Down outside a text field move focus between the rows of the pane,
 *   landing on the row's own control so Space and Enter act on it.
 * - Esc backs out one level: capture, modal, a filled filter, a focused field,
 *   a filter with focus elsewhere, then the window.
 */

const EDITABLE = ['INPUT', 'TEXTAREA', 'SELECT']
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && EDITABLE.includes(target.tagName)
}

/** Every row of the pane that is on screen and has something to focus. */
function focusableRows(content: HTMLElement): HTMLElement[] {
  return Array.from(content.querySelectorAll<HTMLElement>('.s-row, .s-list__row')).filter(
    (row) => row.closest('[hidden]') === null && row.querySelector(FOCUSABLE) !== null
  )
}

/** Move focus to the row after (or before) the one holding focus; the first row when none does. */
export function focusRow(content: HTMLElement | null, direction: 1 | -1): boolean {
  if (content === null) return false
  const rows = focusableRows(content)
  if (rows.length === 0) return false
  const current = rows.findIndex((row) => row.contains(document.activeElement))
  const next =
    current === -1
      ? direction === 1
        ? 0
        : rows.length - 1
      : Math.min(rows.length - 1, Math.max(0, current + direction))
  const row = rows[next]
  const control = row?.querySelector<HTMLElement>('[tabindex="0"]') ?? row?.querySelector<HTMLElement>(FOCUSABLE)
  if (row === undefined || control === null || control === undefined) return false
  control.focus()
  row.scrollIntoView({ block: 'nearest' })
  return true
}

export function useShellKeyboard({
  enabled,
  filter,
  setFilter,
  filterInput,
  content,
  setActive
}: {
  /** False while the wizard is up: it owns the keyboard then. */
  enabled: boolean
  filter: string
  setFilter: (next: string) => void
  filterInput: RefObject<HTMLInputElement | null>
  content: RefObject<HTMLElement | null>
  setActive: (id: SectionId) => void
}): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!enabled || isCaptureActive() || document.querySelector('[role="dialog"]') !== null) return

      if (event.ctrlKey && !event.altKey && !event.metaKey && /^[1-9]$/.test(event.key)) {
        const section = SECTIONS[Number(event.key) - 1]
        if (section === undefined) return
        event.preventDefault()
        if (isEditable(document.activeElement)) (document.activeElement as HTMLElement).blur()
        setActive(section.id)
        return
      }

      const editable = isEditable(event.target)
      const input = filterInput.current
      if ((event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'f') || (event.key === '/' && !editable)) {
        event.preventDefault()
        input?.focus()
        input?.select()
        return
      }

      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !editable && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (focusRow(content.current, event.key === 'ArrowDown' ? 1 : -1)) event.preventDefault()
        return
      }

      if (event.key !== 'Escape') return
      event.preventDefault()
      const active = document.activeElement
      if (active instanceof HTMLElement && EDITABLE.includes(active.tagName)) {
        active.blur()
        return
      }
      if (filter.trim().length > 0) {
        setFilter('')
        return
      }
      void window.lumanin.invoke('settings.close')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, filter, setFilter, filterInput, content, setActive])
}
