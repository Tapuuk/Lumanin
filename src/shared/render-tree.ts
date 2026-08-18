/**
 * The render tree: what an extension's React tree looks like on the wire.
 *
 * An extension renders in a worker and is displayed in the renderer, two v8
 * isolates with no shared memory and — deliberately — no shared code. What
 * crosses between them is this: a JSON document, diffed with JSON Patch
 * by the reconciler. Both ends compile against this file, so
 * the producer and the player cannot disagree about the shape.
 *
 * Renderer-safe by construction: no `node:*` imports, no React import, nothing
 * but types and small pure helpers.
 */

/** A serialized element. `id` is assigned by the reconciler and is stable across re-renders. */
export interface RenderNode {
  readonly id: string
  /** A Raycast component name (`List.Item`) or one of {@link INTERNAL_TYPES}. */
  readonly type: string
  readonly props: RenderProps
  readonly children: readonly RenderChild[]
}

/** A text child. Raycast components rarely take one, but React allows it and it must round-trip. */
export interface RenderText {
  readonly id: string
  readonly text: string
}

export type RenderChild = RenderNode | RenderText

export type RenderProps = Readonly<Record<string, RenderValue>>

/**
 * What a prop can be once it has crossed.
 *
 * Two things React hands components cannot survive `JSON.stringify` and are
 * therefore encoded rather than dropped: functions (which become
 * {@link HandlerRef}) and `Date` (which extensions pass in list accessories and
 * would otherwise arrive as a bare ISO string indistinguishable from text the
 * user typed).
 */
export type RenderValue =
  | string
  | number
  | boolean
  | null
  | HandlerRef
  | DateRef
  | readonly RenderValue[]
  | { readonly [key: string]: RenderValue }

/**
 * A function prop, by reference.
 *
 * Functions cannot cross the wire, so the worker keeps them and sends an id. The
 * renderer sends the id back when the user does the thing. The id is derived
 * from the node and the prop name rather than allocated per render, so a
 * component that rebuilds its closures every render — which is every component —
 * does not produce a patch per handler per keystroke.
 */
export interface HandlerRef {
  readonly __handler: string
}

export interface DateRef {
  readonly __date: string
}

export function isHandlerRef(value: unknown): value is HandlerRef {
  return typeof value === 'object' && value !== null && typeof (value as HandlerRef).__handler === 'string'
}

export function isDateRef(value: unknown): value is DateRef {
  return typeof value === 'object' && value !== null && typeof (value as DateRef).__date === 'string'
}

export function isRenderText(child: RenderChild): child is RenderText {
  return (child as RenderText).text !== undefined
}

/**
 * Component names we invent, all prefixed so they can never collide with a
 * Raycast one — and so an unknown `List.Whatever` is reported as unsupported
 * rather than mistaken for plumbing.
 */
export const INTERNAL_TYPES = {
  /** The single root. Exactly one per session. */
  ROOT: '__root',
  /** One per entry on the navigation stack; the last one is what is displayed. */
  VIEW: '__view',
  /** Carries an element-valued *prop* (`actions`, `detail`, `metadata`, …) as a child subtree. */
  SLOT: '__slot'
} as const

/**
 * Element-valued props, hoisted into {@link INTERNAL_TYPES.SLOT} children.
 *
 * `<List.Item actions={<ActionPanel/>}/>` puts a React element in a *prop*, and
 * a reconciler never renders props — only children. Raycast's own components do
 * the same hoist internally; ours do it in the api-shim, so by the time the
 * reconciler sees a node its element-valued props have become real children and
 * get mounted, diffed and unmounted like everything else.
 *
 * `Action.Push`'s `target` is deliberately **not** in this list. Hoisting it
 * would mount the pushed view immediately — running its effects and firing its
 * network requests before the user has pressed anything — so `Action.Push` is a
 * plain action whose `onAction` pushes, and the view mounts when it is pushed.
 */
export const SLOT_PROPS = ['actions', 'detail', 'metadata', 'searchBarAccessory'] as const
export type SlotProp = (typeof SLOT_PROPS)[number]

/** A patch batch as it travels from worker to renderer. RFC 6902 operations. */
export interface RenderPatch {
  readonly op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test'
  readonly path: string
  readonly value?: unknown
  readonly from?: string
}

/** One render message: the patches to apply to the session's tree. */
export interface RenderUpdate {
  readonly sessionId: string
  /**
   * A monotonic counter per session. The renderer drops anything out of order
   * rather than applying it — a patch applied to the wrong base does not fail
   * loudly, it silently produces a tree that never existed.
   */
  readonly revision: number
  readonly patches: readonly RenderPatch[]
}

/** The empty tree a session starts from, so both ends agree on the diff base. */
export function emptyTree(): RenderNode {
  return { id: 'root', type: INTERNAL_TYPES.ROOT, props: {}, children: [] }
}

/** One row, as the daemon's `enumerate` verb reports it. */
export interface EnumeratedItem {
  /** The item's own `id` prop — the pinnable identity. `null` when it has none. */
  readonly id: string | null
  readonly title: string
  readonly subtitle: string | null
  /**
   * The titles of the row's actions, in panel order — the first is the one
   * Enter runs.
   *
   * Titles rather than ids because an action has no id to give: the spec's
   * `Action` takes none, and its handler id is minted afresh on every render,
   * so nothing else about an action survives from one launch to the next. That
   * is what a key bound to "Dawnline → Open project" has to name.
   */
  readonly actions: readonly string[]
}

/**
 * The active view's `List.Item`s, or `null` while there is nothing to report.
 *
 * For the daemon's `enumerate` verb: the config screen asks a headless session
 * "what rows do you show for this category", and this is the reading half.
 * `null` — rather than `[]` — while the top view is not a `List` yet or its
 * `isLoading` is still true, so the caller knows to keep polling; an empty
 * array is a real answer meaning the category has no items.
 */
export function listItemsOf(root: RenderNode): readonly EnumeratedItem[] | null {
  const views = root.children.filter(
    (child): child is RenderNode => !isRenderText(child) && child.type === INTERNAL_TYPES.VIEW
  )
  const top = views[views.length - 1]
  if (top === undefined) return null
  const view = top.children.find(
    (child): child is RenderNode => !isRenderText(child) && child.type !== INTERNAL_TYPES.SLOT
  )
  if (view === undefined || view.type !== 'List') return null
  if (view.props['isLoading'] === true) return null

  const items: EnumeratedItem[] = []
  const collect = (node: RenderNode): void => {
    for (const child of node.children) {
      if (isRenderText(child) || child.type === INTERNAL_TYPES.SLOT) continue
      if (child.type === 'List.Section') {
        collect(child)
      } else if (child.type === 'List.Item') {
        items.push({
          id: stringOr(child.props['id'], null),
          title: stringOr(child.props['title'], ''),
          subtitle: stringOr(child.props['subtitle'], null),
          actions: actionsOf(child).map((action) => action.title)
        })
      }
    }
  }
  collect(view)
  return items
}

/** One action of a row: what it is called, and what to send to run it. */
export interface ItemAction {
  readonly title: string
  /** The `onAction` handler id, or `null` for an action that does nothing. */
  readonly handlerId: string | null
}

/**
 * A row's actions, flattened out of its `actions` slot in panel order.
 *
 * Sections and submenus are walked *through* rather than around: an action
 * inside `ActionPanel.Submenu` is still one keypress away for the user and is
 * still a perfectly good thing to bind a key to, and nothing about running it
 * depends on the panel having been opened. The submenu itself is not reported —
 * it opens a menu rather than doing anything, so there is nothing for a key
 * bound to it to do.
 */
export function actionsOf(item: RenderNode): readonly ItemAction[] {
  const slot = item.children.find(
    (child): child is RenderNode =>
      !isRenderText(child) &&
      child.type === INTERNAL_TYPES.SLOT &&
      child.props['name'] === 'actions'
  )
  if (slot === undefined) return []

  const found: ItemAction[] = []
  const walk = (node: RenderNode): void => {
    for (const child of node.children) {
      if (isRenderText(child)) continue
      if (child.type === 'Action' || child.type.startsWith('Action.')) {
        const title = stringOr(child.props['title'], '')
        const handler = child.props['onAction']
        if (title.length > 0) {
          found.push({
            title,
            handlerId: isHandlerRef(handler) ? handler.__handler : null
          })
        }
        // An action can still hold children (`Action.Push` and friends do not,
        // but nothing stops one), so keep descending.
        walk(child)
        continue
      }
      walk(child)
    }
  }
  walk(slot)
  return found
}

/**
 * The handler that runs `<title>` on the row with `<itemId>`, or `null`.
 *
 * `null` covers both "no such row" and "no such action", and the caller reports
 * them the same way: a key bound to something the plugin no longer offers has
 * to say so, not fail silently.
 */
export function actionHandlerOf(
  root: RenderNode,
  itemId: string,
  title: string
): string | null {
  const views = root.children.filter(
    (child): child is RenderNode => !isRenderText(child) && child.type === INTERNAL_TYPES.VIEW
  )
  const top = views[views.length - 1]
  if (top === undefined) return null

  let handlerId: string | null = null
  const walk = (node: RenderNode): void => {
    for (const child of node.children) {
      if (handlerId !== null || isRenderText(child)) continue
      if (child.type === 'List.Item' && stringOr(child.props['id'], null) === itemId) {
        handlerId = actionsOf(child).find((action) => action.title === title)?.handlerId ?? null
        continue
      }
      walk(child)
    }
  }
  walk(top)
  return handlerId
}

/** `title`/`subtitle` props may be a string or the spec's `{ value, tooltip }`. */
function stringOr<T>(value: unknown, fallback: T): string | T {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'object' && value !== null) {
    const inner = (value as { value?: unknown }).value
    if (typeof inner === 'string' && inner.length > 0) return inner
  }
  return fallback
}
