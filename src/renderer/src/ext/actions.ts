import { deserializeShortcut, type Shortcut } from '@shared/shortcut'
import { elementChildren, handler, str, type RenderNode } from './tree'

/**
 * An `<ActionPanel>`, flattened into something drawable.
 *
 * The tree gives us nested components; what the UI needs is an ordered list with
 * sections, a primary action and a secondary one. Deriving that here rather than
 * in the panel component means the **same** derivation answers both "what does
 * Enter do" and "what is in the Ctrl+K list" — and those two can never disagree,
 * which is the one thing an action panel must never do.
 */

export interface ActionEntry {
  readonly kind: 'action'
  /** The tree node id, which is stable across re-renders and unique. */
  readonly id: string
  readonly title: string
  readonly handlerId: string | null
  readonly shortcut: Shortcut | null
  readonly destructive: boolean
  /**
   * `Action.SubmitForm`, which is handed the form's values as its payload.
   *
   * Every `Action.*` serializes as type `Action` — the variants differ only in
   * what their handler does, which the tree does not carry — so the shim marks
   * this one with a prop. See `api-shim/actions.ts`.
   */
  readonly submitsForm: boolean
}

export interface SubmenuEntry {
  readonly kind: 'submenu'
  readonly id: string
  readonly title: string
  readonly shortcut: Shortcut | null
  readonly sections: readonly ActionSection[]
}

export type Entry = ActionEntry | SubmenuEntry

export interface ActionSection {
  readonly title: string | null
  readonly entries: readonly Entry[]
}

export interface ActionSet {
  /** The panel's own title, shown as the overlay's heading. */
  readonly title: string | null
  readonly sections: readonly ActionSection[]
  /**
   * What Enter does: the **first** action in the panel, submenus skipped.
   *
   * Raycast's rule, and worth reproducing exactly — extension authors order
   * their actions knowing the first one is the default, so any other choice
   * makes Enter do something the author did not intend.
   */
  readonly primary: ActionEntry | null
  /**
   * What the `secondary` key does — Space while the search box is empty,
   * Ctrl+Enter once it is not.
   *
   * The second action **in the primary's own section**, not the second action
   * overall. A section is a group of related verbs, and the two keyboard-
   * privileged actions should come from the same group: on a file, *Open* and
   * *Open Containing Folder* are not alternatives to each other, so Space
   * landing on the second of them meant pressing "open" and getting a file
   * manager. Sectioning is how an author says which is which, and it is the only
   * thing they have to do — a row whose first section holds one action falls
   * back to running the primary, so the key is never dead.
   */
  readonly secondary: ActionEntry | null
  /** Every action reachable without opening a submenu, for shortcut dispatch. */
  readonly flat: readonly ActionEntry[]
}

export const EMPTY_ACTIONS: ActionSet = {
  title: null,
  sections: [],
  primary: null,
  secondary: null,
  flat: []
}

/**
 * Build the set from an `ActionPanel` node.
 *
 * Actions written directly inside the panel, without a `Section`, land in an
 * untitled leading section — the spec allows both shapes and extensions mix them
 * freely, sometimes within one panel.
 */
export function readActionPanel(panel: RenderNode | null): ActionSet {
  if (panel === null) return EMPTY_ACTIONS

  const sections = readSections(panel)
  const flat: ActionEntry[] = []
  for (const section of sections) {
    for (const entry of section.entries) if (entry.kind === 'action') flat.push(entry)
  }

  const first = sections.find((section) =>
    section.entries.some((entry) => entry.kind === 'action')
  )
  const primaries = (first?.entries ?? []).filter(
    (entry): entry is ActionEntry => entry.kind === 'action'
  )

  return {
    title: str(panel.props['title']),
    sections,
    primary: primaries[0] ?? null,
    secondary: primaries[1] ?? null,
    flat
  }
}

function readSections(parent: RenderNode): readonly ActionSection[] {
  const sections: ActionSection[] = []
  let loose: Entry[] = []

  const flushLoose = (): void => {
    if (loose.length === 0) return
    sections.push({ title: null, entries: loose })
    loose = []
  }

  for (const child of elementChildren(parent)) {
    switch (child.type) {
      case 'ActionPanel.Section':
        // A section ends whatever run of loose actions preceded it, so the
        // original order is preserved rather than sorted into "loose first".
        flushLoose()
        sections.push({ title: str(child.props['title']), entries: readEntries(child) })
        break
      case 'ActionPanel.Submenu':
        loose.push(readSubmenu(child))
        break
      case 'Action':
        loose.push(readAction(child))
        break
      default:
        // Anything else in an action panel is not an action. Silently ignored
        // rather than drawn: a stray element here is an authoring slip, and a
        // row that cannot be pressed is worse than one that is not there.
        break
    }
  }

  flushLoose()
  return sections
}

function readEntries(section: RenderNode): readonly Entry[] {
  const entries: Entry[] = []
  for (const child of elementChildren(section)) {
    if (child.type === 'Action') entries.push(readAction(child))
    else if (child.type === 'ActionPanel.Submenu') entries.push(readSubmenu(child))
  }
  return entries
}

function readAction(node: RenderNode): ActionEntry {
  return {
    kind: 'action',
    id: node.id,
    title: str(node.props['title']) ?? 'Action',
    handlerId: handler(node.props['onAction']),
    shortcut: readShortcut(node),
    destructive: str(node.props['style']) === 'destructive',
    submitsForm: node.props['submitsForm'] === true
  }
}

function readSubmenu(node: RenderNode): SubmenuEntry {
  return {
    kind: 'submenu',
    id: node.id,
    title: str(node.props['title']) ?? 'More',
    shortcut: readShortcut(node),
    sections: readSections(node)
  }
}

/**
 * A `shortcut` prop, which crosses as the *serialized* form.
 *
 * Parsing happens in the worker (`shared/shortcut.ts`), not here, so the
 * platform mapping — cmd→ctrl, the `Windows` variant preference — is decided
 * once, on the side that has the spec's types, rather than being re-derived by
 * whichever consumer needs it next.
 */
function readShortcut(node: RenderNode): Shortcut | null {
  const serialized = node.props['shortcut']
  return typeof serialized === 'string' ? deserializeShortcut(serialized) : null
}
