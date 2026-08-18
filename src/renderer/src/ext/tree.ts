import {
  INTERNAL_TYPES,
  isDateRef,
  isHandlerRef,
  isRenderText,
  type HandlerRef,
  type RenderChild,
  type RenderNode,
  type RenderValue
} from '@shared/render-tree'

/**
 * Reading a render tree.
 *
 * The renderer is the *player*: it never invents a node, never reorders one, and
 * never decides what a prop means beyond drawing it. Everything here is a
 * question about the document — what type is this, what is in this slot, what did
 * this prop say — and the answers are all total, because the document came from
 * a worker running someone else's code and a missing prop is a normal Tuesday.
 */

export type { RenderNode, RenderChild, RenderValue }

/** Every element child, skipping text nodes and slots. */
export function elementChildren(node: RenderNode): readonly RenderNode[] {
  return node.children.filter(
    (child): child is RenderNode => !isRenderText(child) && child.type !== INTERNAL_TYPES.SLOT
  )
}

/** The text a node directly contains, concatenated. Empty when it contains none. */
export function textOf(node: RenderNode): string {
  return node.children
    .filter(isRenderText)
    .map((child) => child.text)
    .join('')
}

/**
 * The contents of an element-valued prop.
 *
 * `actions`, `detail`, `metadata` and `searchBarAccessory` arrive as `__slot`
 * children rather than props (see `SLOT_PROPS` in `shared/render-tree.ts`), because a
 * reconciler renders children and not props. This puts them back.
 */
export function slot(node: RenderNode, name: string): RenderNode | null {
  for (const child of node.children) {
    if (isRenderText(child)) continue
    if (child.type !== INTERNAL_TYPES.SLOT) continue
    if (child.props['name'] !== name) continue
    return elementChildren(child)[0] ?? null
  }
  return null
}

/** The active navigation entry: the last `__view`, which is the one on top. */
export function activeView(root: RenderNode): RenderNode | null {
  const views = root.children.filter(
    (child): child is RenderNode => !isRenderText(child) && child.type === INTERNAL_TYPES.VIEW
  )
  const top = views[views.length - 1]
  return top === undefined ? null : (elementChildren(top)[0] ?? null)
}

/** How deep the navigation stack is. Zero means the session has not rendered yet. */
export function navigationDepth(root: RenderNode): number {
  return root.children.filter(
    (child) => !isRenderText(child) && child.type === INTERNAL_TYPES.VIEW
  ).length
}

// --- prop readers ------------------------------------------------------------
//
// One per shape we actually draw. Written as total functions with a documented
// fallback rather than as casts, because every one of these is reading a value an
// extension author wrote, and "the extension passed a number where the type said
// string" has to render *something*.

export function str(value: RenderValue | undefined): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  // `{value, tooltip}` — the spec allows this shape for `title`, `subtitle` and
  // several accessories, and an extension using a tooltip should not lose its
  // title as a result.
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const inner = (value as Record<string, RenderValue>)['value']
    if (typeof inner === 'string') return inner
    if (typeof inner === 'number') return String(inner)
  }
  return null
}

export function bool(value: RenderValue | undefined, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function handler(value: RenderValue | undefined): string | null {
  return isHandlerRef(value) ? (value as HandlerRef).__handler : null
}

/**
 * A `Date` prop, decoded.
 *
 * Formatted relative to today the way a list accessory should read: a date this
 * year loses the year, and today loses the date entirely. That is a rendering
 * decision rather than a data one, which is why it lives here and not in the
 * worker — the worker does not know the user's locale and should not.
 */
export function dateText(value: RenderValue | undefined): string | null {
  if (!isDateRef(value)) return null
  const parsed = new Date(value.__date)
  if (Number.isNaN(parsed.getTime())) return null

  const now = new Date()
  const sameDay =
    parsed.getFullYear() === now.getFullYear() &&
    parsed.getMonth() === now.getMonth() &&
    parsed.getDate() === now.getDate()

  if (sameDay) return parsed.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return parsed.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(parsed.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  })
}

export function objectProp(value: RenderValue | undefined): Record<string, RenderValue> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isHandlerRef(value)
    ? (value as Record<string, RenderValue>)
    : null
}

export function arrayProp(value: RenderValue | undefined): readonly RenderValue[] {
  return Array.isArray(value) ? value : []
}
