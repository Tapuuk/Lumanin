import {
  isRenderText,
  type RenderChild,
  type RenderNode,
  type RenderProps,
  type RenderValue
} from '../shared/render-tree'

/**
 * The instance model the reconciler builds, and how it becomes JSON.
 *
 * Two jobs, kept apart from the reconciler itself so both can be tested without
 * one: holding a mutable tree of nodes (which is all a "host instance" is for
 * us), and turning that tree into the serializable document the renderer plays.
 */

export interface Instance {
  readonly id: string
  readonly type: string
  props: Record<string, unknown>
  children: Child[]
}

export interface TextInstance {
  readonly id: string
  text: string
}

export type Child = Instance | TextInstance

export function isText(child: Child): child is TextInstance {
  return (child as TextInstance).text !== undefined
}

/**
 * Node ids, allocated once per instance and never reused.
 *
 * They are what makes a JSON Patch small: React keeps an instance alive across
 * re-renders when its type and position are unchanged, so a stable id means the
 * diff sees the same node rather than a replaced one. And they are the first half
 * of every handler id, which is why they must not be recycled — a recycled id
 * would silently point a stale handler reference at a different component.
 */
export function createIdFactory(): () => string {
  let next = 0
  return () => `n${++next}`
}

/**
 * Props the serializer never emits.
 *
 * `children` is the tree itself; `key` and `ref` are React's own bookkeeping.
 * Shared with the comparison at the bottom of this file so the two cannot
 * drift - a key the serializer drops must not be able to make a commit look
 * like it changed something.
 */
const NEVER_SERIALIZED: ReadonlySet<string> = new Set(['children', 'key', 'ref'])

/**
 * The id a function prop encodes to.
 *
 * Built from the node and the prop name and never from the function itself,
 * which is what lets a closure rebuilt on every render keep one id. Defined
 * once on purpose: two places spelling this out independently are a rename away
 * from a handler table that points at nothing.
 */
export function handlerId(nodeId: string, prop: string): string {
  return `${nodeId}:${prop}`
}

/** What the serializer does with a function prop and what it could not encode. */
export interface SerializeSink {
  /** Register (or re-register) a callback under a stable id. */
  handler(id: string, fn: (payload: unknown) => void): void
  /** A prop that cannot cross, named, so the message can say which one. */
  reject(node: string, prop: string, reason: string): void
}

/**
 * Serialize a tree.
 *
 * Also returns every handler id that is live in this tree. The worker uses it to
 * forget the rest: doing the bookkeeping from the *result* of a render rather
 * than from mount/unmount callbacks means there is no lifecycle path that can
 * leak a handler or free one that is still on screen. A commit is O(tree), which
 * for a list of a hundred rows is nothing next to the React render that produced
 * it.
 */
export function serializeTree(
  root: Instance,
  sink: SerializeSink
): { node: RenderNode; handlers: ReadonlySet<string> } {
  const handlers = new Set<string>()

  const encodeProps = (instance: Instance): RenderProps => {
    const encoded: Record<string, RenderValue> = {}

    for (const [key, value] of Object.entries(instance.props)) {
      if (NEVER_SERIALIZED.has(key)) continue
      if (value === undefined) continue

      if (typeof value === 'function') {
        const id = handlerId(instance.id, key)
        handlers.add(id)
        sink.handler(id, value as (payload: unknown) => void)
        encoded[key] = { __handler: id }
        continue
      }

      const plain = encodeValue(value, instance.id, key, sink)
      if (plain !== SKIP) encoded[key] = plain
    }

    return encoded
  }

  const walk = (child: Child): RenderChild =>
    isText(child)
      ? { id: child.id, text: child.text }
      : {
          id: child.id,
          type: child.type,
          props: encodeProps(child),
          children: child.children.map(walk)
        }

  const node = walk(root)
  // The root is an element by construction; the cast documents that rather than
  // hiding it behind an `as RenderNode` at the call site.
  return { node: node as RenderNode, handlers }
}

/** A sentinel distinct from every legal `RenderValue`, including `null`. */
const SKIP = Symbol('skip')

function encodeValue(
  value: unknown,
  nodeId: string,
  prop: string,
  sink: SerializeSink
): RenderValue | typeof SKIP {
  if (value === null) return null

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value as RenderValue
    case 'undefined':
      return SKIP
    case 'bigint':
      // Legal JSON once stringified, and never what the spec asked for — but a
      // number the renderer can show beats dropping the prop silently.
      return value.toString()
    case 'symbol':
    case 'function':
      sink.reject(nodeId, prop, `a ${typeof value} cannot cross to the renderer`)
      return SKIP
    default:
      break
  }

  if (value instanceof Date) return { __date: value.toISOString() }

  // A React element that escaped slot hoisting. Serializing it would send a
  // lump of React internals — fibers, symbols, circular parents — so it is
  // refused by name instead: non-serializable props are rejected with a clear
  // error naming the prop.
  if (isReactElement(value)) {
    sink.reject(
      nodeId,
      prop,
      'a React element in a prop that is not rendered as a slot - see SLOT_PROPS in shared/render-tree.ts'
    )
    return SKIP
  }

  if (Array.isArray(value)) {
    const encoded: RenderValue[] = []
    for (const entry of value) {
      const item = encodeValue(entry, nodeId, prop, sink)
      // A hole would shift every later index, so an unencodable entry becomes
      // `null` rather than disappearing — `accessories[2]` must stay the third.
      encoded.push(item === SKIP ? null : item)
    }
    return encoded
  }

  if (isPlainObject(value)) {
    const encoded: Record<string, RenderValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      const item = encodeValue(entry, nodeId, `${prop}.${key}`, sink)
      if (item !== SKIP) encoded[key] = item
    }
    return encoded
  }

  sink.reject(nodeId, prop, `values of type ${describe(value)} cannot cross to the renderer`)
  return SKIP
}

const REACT_ELEMENT = Symbol.for('react.element')
const REACT_TRANSITIONAL_ELEMENT = Symbol.for('react.transitional.element')

function isReactElement(value: object): boolean {
  const tag = (value as { $$typeof?: symbol }).$$typeof
  return tag === REACT_ELEMENT || tag === REACT_TRANSITIONAL_ELEMENT
}

/**
 * A plain object, not a class instance.
 *
 * Class instances are excluded deliberately: `JSON.stringify` would happily
 * flatten one into its own fields, so a `Map` becomes `{}` and a stream becomes a
 * bag of internals. Refusing by name is the version the extension author can act
 * on.
 */
function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function describe(value: object): string {
  return value.constructor?.name ?? 'object'
}

/**
 * Would these two props objects serialize to the same document?
 *
 * The question asked before a props update is allowed to count as a change.
 * React hands the host a fresh props object for every child of a re-rendered
 * parent, so on a list of a few hundred rows the great majority of updates
 * carry identical values in a new object.
 *
 * The rules follow the serializer above exactly:
 * - the three keys it never emits are invisible here too, and so is a key whose
 *   value is `undefined`, which it also skips;
 * - two functions under one key are equal, because what crosses is the handler
 *   id and that is built from the node and the key. The new function is still
 *   reported to `onHandler`, so a caller that goes on to skip the commit does
 *   not keep dispatching into the closure from an earlier render;
 * - everything else is `Object.is`. That makes an array or object prop rebuilt
 *   with equal contents count as different, deliberately: comparing them deeply
 *   would cost about what serializing them costs, which is the work being
 *   avoided. The other half of the same rule: a prop mutated in place behind a
 *   reference that did not change is *not* seen, so the commit is skipped and
 *   the mutation never reaches the renderer. React's own props diff answers the
 *   same way, so a plugin that rebuilds its props — which is what writing them
 *   inline gets you — is never affected.
 */
export function samePropsWhenSerialized(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  onHandler: (prop: string, fn: (payload: unknown) => void) => void
): boolean {
  let same = true

  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (NEVER_SERIALIZED.has(key)) continue

    const before = previous[key]
    const after = next[key]
    if (Object.is(before, after)) continue

    if (typeof after === 'function') {
      onHandler(key, after as (payload: unknown) => void)
      if (typeof before === 'function') continue
    }
    same = false
  }

  return same
}

/** Deep-equality for two serialized trees. Used by the golden tests. */
export function sameTree(a: RenderChild, b: RenderChild): boolean {
  if (isRenderText(a) || isRenderText(b)) {
    return isRenderText(a) && isRenderText(b) && a.id === b.id && a.text === b.text
  }
  if (a.id !== b.id || a.type !== b.type) return false
  if (JSON.stringify(a.props) !== JSON.stringify(b.props)) return false
  if (a.children.length !== b.children.length) return false
  return a.children.every((child, index) => sameTree(child, b.children[index] as RenderChild))
}
