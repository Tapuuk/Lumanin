import type { RenderNode, RenderPatch } from './render-tree'

/**
 * Applying a patch batch to a render tree, sharing everything it did not touch.
 *
 * A batch has to produce a new root: main hands its tree out as a snapshot
 * paired with the revision it was taken at, and the renderer decides what to
 * redraw by comparing identities. Cloning the document to get that new root
 * costs a full serialize-and-parse of the whole tree, twice per batch, once in
 * each process. This copies only the objects on the path of each operation
 * instead, so a node no operation in the batch named comes back `===` the node
 * that went in.
 *
 * The set of objects the call created is what keeps a batch linear. The first
 * operation under a `children` array copies that array; every later operation
 * in the same batch writes straight through the copy, which is unreachable
 * from the caller's tree and so cannot be observed half-written. Without it,
 * two hundred inserts into one array would copy a growing array two hundred
 * times.
 *
 * RFC 6902 operations over RFC 6901 paths. `copy` and `test` are refused
 * rather than approximated, and a path that leads through something that is
 * not an object throws: a batch applied to the wrong base yields a tree that
 * never existed on either side, which is the failure the revision counter is
 * there to catch.
 */
export function applyRenderPatches(tree: RenderNode, patches: readonly RenderPatch[]): RenderNode {
  if (patches.length === 0) return tree

  const created = new Set<object>()
  let document = adopt(tree, created)
  for (const patch of patches) document = apply(document, patch, created)
  // The shape is the producer's guarantee: it diffs one serialized tree
  // against the next.
  return document as RenderNode
}

type Container = Record<string, unknown> | unknown[]

function apply(document: unknown, patch: RenderPatch, created: Set<object>): unknown {
  switch (patch.op) {
    case 'add':
    case 'replace':
      return put(document, patch.path, patch.value, patch.op, patch, created)
    case 'remove':
      take(document, patch.path, patch, created)
      return document
    case 'move': {
      if (patch.from === undefined) throw fail(patch, 'names no source path')
      const moved = take(document, patch.from, patch, created)
      return put(document, patch.path, moved, 'add', patch, created)
    }
    default:
      throw fail(patch, 'is not an operation the render diff produces')
  }
}

function put(
  document: unknown,
  path: string,
  value: unknown,
  op: 'add' | 'replace',
  patch: RenderPatch,
  created: Set<object>
): unknown {
  const segments = split(path, patch)
  const key = segments.pop()
  // The whole document. The value belongs to the patch, so it is copied before
  // it becomes something later operations may write into.
  if (key === undefined) return adopt(value, created)

  const container = descend(document, segments, patch, created, path)
  if (op === 'add' && Array.isArray(container)) {
    const index = indexIn(container, key)
    if (index !== null) {
      inside(container, index, op, patch, path)
      container.splice(index, 0, value)
      return document
    }
  }
  set(container, key, value, { op, patch, path })
  return document
}

function take(document: unknown, path: string, patch: RenderPatch, created: Set<object>): unknown {
  const segments = split(path, patch)
  const key = segments.pop()
  if (key === undefined) throw fail(patch, 'cannot address the whole document', path)

  const container = descend(document, segments, patch, created, path)
  if (Array.isArray(container)) {
    // The slot after the last one exists for an append and for nothing else:
    // reading it takes no element out and hands back nothing.
    if (key === '-') throw fail(patch, 'cannot address the end of an array', path)
    const index = indexIn(container, key)
    if (index !== null) {
      // A slot no element occupies is nothing to take out: the remove would
      // change nothing, and the move would carry a hole to its destination.
      if (index >= container.length) throw fail(patch, 'reads past the end of an array', path)
      return container.splice(index, 1)[0]
    }
  }
  const record = container as Record<string, unknown>
  const removed = record[key]
  delete record[key]
  return removed
}

function descend(
  document: unknown,
  segments: readonly string[],
  patch: RenderPatch,
  created: Set<object>,
  path: string
): Container {
  let container = asContainer(document, patch, path)
  for (const segment of segments) {
    const child = asContainer(read(container, segment), patch, path)
    if (created.has(child)) {
      container = child
      continue
    }
    const copy = shallowCopy(child)
    created.add(copy)
    set(container, segment, copy)
    container = copy
  }
  return container
}

function read(container: Container, key: string): unknown {
  if (Array.isArray(container)) {
    const index = indexIn(container, key)
    if (index !== null) return container[index]
  }
  return (container as Record<string, unknown>)[key]
}

function set(
  container: Container,
  key: string,
  value: unknown,
  write?: { op: 'add' | 'replace'; patch: RenderPatch; path: string }
): void {
  if (Array.isArray(container)) {
    const index = indexIn(container, key)
    if (index !== null) {
      if (write !== undefined) inside(container, index, write.op, write.patch, write.path)
      container[index] = value
      return
    }
  }
  ;(container as Record<string, unknown>)[key] = value
}

/** `-` is the end of the array; anything that is not an index addresses a property. */
function indexIn(array: readonly unknown[], key: string): number | null {
  if (key === '-') return array.length
  return /^\d+$/.test(key) ? Number(key) : null
}

/**
 * An append may name the slot after the last one; every other write has to name
 * a slot that is already there. Assigning past the end would stretch the array
 * with holes, which serialize as children nothing ever rendered.
 */
function inside(
  array: readonly unknown[],
  index: number,
  op: 'add' | 'replace',
  patch: RenderPatch,
  path: string
): void {
  if (index <= (op === 'add' ? array.length : array.length - 1)) return
  throw fail(patch, 'writes past the end of an array', path)
}

function split(path: string, patch: RenderPatch): string[] {
  if (path === '') return []
  const segments = path
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
  segments.forEach((segment, at) => {
    // A prop name is whatever a plugin wrote, and assigning through these two
    // reaches the prototype instead of the node.
    const prototype = segment === 'prototype' && segments[at - 1] === 'constructor'
    if (segment === '__proto__' || prototype) {
      throw fail(patch, 'walks into a prototype, which is never part of a tree', path)
    }
  })
  return segments
}

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null
}

function asContainer(value: unknown, patch: RenderPatch, path: string): Container {
  if (isContainer(value)) return value
  throw fail(patch, 'passes through a value that is not an object', path)
}

function shallowCopy(container: Container): Container {
  return Array.isArray(container) ? [...container] : { ...container }
}

function adopt(value: unknown, created: Set<object>): unknown {
  if (!isContainer(value)) return value
  const copy = shallowCopy(value)
  created.add(copy)
  return copy
}

/** The path that did not fit the base, which for a `move` is often its source. */
function fail(patch: RenderPatch, detail: string, path: string = patch.path): Error {
  return new Error(`render patch: "${patch.op}" at "${path}" ${detail}`)
}
