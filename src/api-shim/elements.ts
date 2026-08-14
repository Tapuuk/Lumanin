import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from 'react'
import { INTERNAL_TYPES, SLOT_PROPS, type SlotProp } from '../shared/render-tree'
import { parseShortcut, serializeShortcut } from '../shared/shortcut'

/**
 * Turning Raycast's components into host elements.
 *
 * Every component an extension renders is, underneath, a string-typed React
 * element that our reconciler serializes. This file is the one place that makes
 * one, so the two things that have to happen to *every* component happen once:
 * naming (the wire type is the dotted name, `List.Item`) and slot hoisting.
 *
 * ## Slot hoisting
 *
 * `<List.Item actions={<ActionPanel/>}/>` puts an element in a **prop**. A
 * reconciler renders children, never props, so left alone that `ActionPanel`
 * would be serialized as a lump of unrenderable React internals — its actions
 * never mounted, its handlers never registered, and any hook inside it never
 * run.
 *
 * So an element-valued prop becomes a child: a `__slot` node named after the
 * prop, with the element inside it. It then mounts, updates and unmounts like
 * anything else, and the renderer puts it back where it belongs. Raycast does
 * the same thing internally; doing it here rather than in the reconciler keeps
 * the reconciler ignorant of which props are special, which is a list that grows
 * with the API.
 */

/** The props every host component quietly accepts, on top of its own. */
interface CommonProps {
  readonly children?: ReactNode
  readonly [key: string]: unknown
}

/**
 * A host component for a wire type.
 *
 * `displayName` is set because React's own error messages ("check the render
 * method of X") are the first thing anyone reads when an extension breaks, and
 * an anonymous component makes them useless.
 */
export function hostComponent<P extends object>(type: string): FunctionComponent<P> {
  const component = (props: P): ReactElement => {
    const { children, slots, rest } = split(props as CommonProps)
    return createElement(type, rest, ...slots, ...(children === undefined ? [] : [children]))
  }
  component.displayName = type
  return component as FunctionComponent<P>
}

/**
 * Split props into the ones that stay, the ones that become slot children, and
 * the element's own children.
 *
 * A slot prop holding `null` or `undefined` produces no slot at all rather than
 * an empty one — extensions write `actions={condition ? <ActionPanel/> : null}`
 * constantly, and an empty slot would leave the renderer unable to tell "no
 * actions" from "actions that have not arrived yet".
 */
function split(props: CommonProps): {
  children: ReactNode
  slots: ReactElement[]
  rest: Record<string, unknown>
} {
  const rest: Record<string, unknown> = {}
  const slots: ReactElement[] = []
  let children: ReactNode

  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') {
      children = value as ReactNode
      continue
    }
    if (isSlotProp(key)) {
      if (value !== null && value !== undefined) slots.push(slot(key, value as ReactNode))
      continue
    }
    if (key === 'shortcut') {
      // Normalised here, on the side that has the spec's types, so the cmd→ctrl
      // mapping and the `Windows`-variant preference are decided once. The
      // renderer receives `"ctrl+shift+c"` and never has to know that a shortcut
      // has two possible shapes and six modifier spellings.
      const shortcut = parseShortcut(value)
      if (shortcut !== null) rest[key] = serializeShortcut(shortcut)
      continue
    }
    rest[key] = value
  }

  return { children, slots, rest }
}

function isSlotProp(key: string): key is SlotProp {
  return (SLOT_PROPS as readonly string[]).includes(key)
}

function slot(name: SlotProp, content: ReactNode): ReactElement {
  // `key` matters: slots are siblings of the element's real children, and
  // without stable keys React would warn on every list item that has actions.
  return createElement(INTERNAL_TYPES.SLOT, { name, key: `__slot:${name}` }, content)
}

/**
 * Attach namespace members to a component — `List.Item`, `Action.Push`.
 *
 * The spec expresses these as an interface merged onto a `declare const`, which
 * is a compile-time construct with no runtime form; at runtime they are plain
 * properties. Assigning them through one helper keeps every component's shape
 * built the same way instead of a dozen ad-hoc `Object.assign` calls.
 */
export function withMembers<C, M extends object>(component: C, members: M): C & M {
  return Object.assign(component as C & M, members)
}
