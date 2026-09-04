import { createElement, useEffect, useState, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { compare } from 'fast-json-patch'
import { createRenderer } from '../src/host/reconciler'
import { handlerId, serializeTree, type SerializeSink } from '../src/host/tree'
import { INTERNAL_TYPES, type RenderNode } from '../src/shared/render-tree'

/**
 * The reconciler, as a black box: render something, look at the JSON.
 *
 * These are the golden tests, and they came early on purpose — everything
 * downstream (patches, the renderer's player, every component)
 * is built on the assumption that a React tree becomes exactly one predictable
 * document. A regression here is invisible in every other suite and looks like a
 * rendering bug in all of them.
 */

interface Harness {
  render(element: ReactNode): RenderNode
  unmount(): void
  /** How many times the reconciler has asked for the tree to be published. */
  commits(): number
  readonly handlers: Map<string, (payload: unknown) => void>
  readonly rejected: { node: string; prop: string; reason: string }[]
  readonly errors: unknown[]
}

/**
 * The worker's own arrangement, minus the transport: serialize inside the commit
 * callback, never outside it. Doing it that way rather than after every
 * `render()` is what makes these tests able to see a commit the reconciler chose
 * not to publish - and it is the arrangement whose handler table has to stay
 * fresh without one.
 */
function harness(): Harness {
  const handlers = new Map<string, (payload: unknown) => void>()
  const rejected: { node: string; prop: string; reason: string }[] = []
  const errors: unknown[] = []
  let commits = 0
  let tree: RenderNode = { id: 'root', type: INTERNAL_TYPES.ROOT, props: {}, children: [] }

  const sink: SerializeSink = {
    handler: (id, fn) => {
      handlers.set(id, fn)
    },
    reject: (node, prop, reason) => rejected.push({ node, prop, reason })
  }

  const renderer = createRenderer({
    onCommit: () => {
      commits++
      const { node, handlers: live } = serializeTree(renderer.root, sink)
      for (const id of [...handlers.keys()]) if (!live.has(id)) handlers.delete(id)
      tree = node
    },
    onError: (error) => errors.push(error),
    onHandler: (nodeId, prop, fn) => handlers.set(handlerId(nodeId, prop), fn)
  })

  return {
    handlers,
    rejected,
    errors,
    commits: () => commits,
    render(element) {
      renderer.render(element)
      renderer.flush()
      return tree
    },
    unmount() {
      renderer.unmount()
    }
  }
}

describe('the reconciler', () => {
  it('turns an element tree into a render tree', () => {
    const h = harness()
    const tree = h.render(
      createElement(
        'List',
        { isLoading: false },
        createElement('List.Item', { key: 'a', title: 'Alpha' }),
        createElement('List.Item', { key: 'b', title: 'Beta', subtitle: 'second' })
      )
    )

    expect(tree.type).toBe(INTERNAL_TYPES.ROOT)
    expect(tree.children).toHaveLength(1)

    const list = tree.children[0] as RenderNode
    expect(list.type).toBe('List')
    expect(list.props).toEqual({ isLoading: false })
    expect(list.children.map((child) => (child as RenderNode).props['title'])).toEqual([
      'Alpha',
      'Beta'
    ])
  })

  it('replaces function props with a stable handler reference', () => {
    const h = harness()
    const first = h.render(createElement('Action', { title: 'Go', onAction: () => {} }))
    const action = first.children[0] as RenderNode

    expect(action.props['onAction']).toEqual({ __handler: `${action.id}:onAction` })
    expect(h.handlers.has(`${action.id}:onAction`)).toBe(true)

    // A new closure every render is what React actually does. The id must not
    // change, or every keystroke would produce a patch per handler.
    const second = h.render(createElement('Action', { title: 'Go', onAction: () => {} }))
    expect(compare(first, second)).toEqual([])
  })

  it('keeps node ids stable across a re-render so patches stay small', () => {
    const h = harness()
    const before = h.render(
      createElement(
        'List',
        null,
        createElement('List.Item', { key: 'a', title: 'Alpha' }),
        createElement('List.Item', { key: 'b', title: 'Beta' })
      )
    )
    const after = h.render(
      createElement(
        'List',
        null,
        createElement('List.Item', { key: 'a', title: 'Alpha' }),
        createElement('List.Item', { key: 'b', title: 'Beta — edited' })
      )
    )

    // One edited title must produce exactly one operation. If ids were
    // reallocated per render the diff would replace the whole subtree instead,
    // and the cost of a keystroke would scale with the size of the list.
    expect(compare(before, after)).toEqual([
      { op: 'replace', path: '/children/0/children/1/props/title', value: 'Beta — edited' }
    ])
  })

  it('reorders children by moving nodes rather than recreating them', () => {
    const h = harness()
    const before = h.render(
      createElement(
        'List',
        null,
        createElement('List.Item', { key: 'a', title: 'Alpha' }),
        createElement('List.Item', { key: 'b', title: 'Beta' })
      )
    )
    const beforeIds = (before.children[0] as RenderNode).children.map((c) => (c as RenderNode).id)

    const after = h.render(
      createElement(
        'List',
        null,
        createElement('List.Item', { key: 'b', title: 'Beta' }),
        createElement('List.Item', { key: 'a', title: 'Alpha' })
      )
    )
    const afterIds = (after.children[0] as RenderNode).children.map((c) => (c as RenderNode).id)

    expect(afterIds).toEqual([beforeIds[1], beforeIds[0]])
  })

  it('round-trips text children', () => {
    const h = harness()
    const tree = h.render(createElement('Detail', null, 'plain text'))
    const detail = tree.children[0] as RenderNode
    expect(detail.children).toHaveLength(1)
    expect(detail.children[0]).toMatchObject({ text: 'plain text' })
  })

  it('encodes Date props rather than dropping them', () => {
    const h = harness()
    const when = new Date('2031-04-05T12:00:00.000Z')
    const tree = h.render(createElement('List.Item', { title: 'x', accessories: [{ date: when }] }))
    const item = tree.children[0] as RenderNode
    expect(item.props['accessories']).toEqual([{ date: { __date: when.toISOString() } }])
  })

  it('rejects a React element left in a prop, naming the prop', () => {
    const h = harness()
    h.render(
      createElement('List.Item', { title: 'x', stray: createElement('Action', { title: 'a' }) })
    )
    expect(h.rejected).toHaveLength(1)
    expect(h.rejected[0]?.prop).toBe('stray')
  })

  it('forgets a handler when its node unmounts', () => {
    const h = harness()
    const tree = h.render(createElement('Action', { title: 'Go', onAction: () => {} }))
    const id = `${(tree.children[0] as RenderNode).id}:onAction`
    expect(h.handlers.has(id)).toBe(true)

    h.render(createElement('List', null))
    expect(h.handlers.has(id)).toBe(false)
  })

  it('runs hooks and effects', () => {
    const h = harness()

    function Counter(): ReactNode {
      const [count, setCount] = useState(0)
      useEffect(() => {
        if (count === 0) setCount(1)
      }, [count])
      return createElement('List.Item', { title: `count ${count}` })
    }

    h.render(createElement(Counter, null))
    // A second pass so the effect's state update is committed.
    const tree = h.render(createElement(Counter, null))
    expect((tree.children[0] as RenderNode).props['title']).toBe('count 1')
  })

  /**
   * Tearing a session down terminates the thread right after this returns, so an
   * effect cleanup left queued never runs at all — and abandoning a spawned
   * command is exactly the kind of thing extensions put in one.
   */
  it('runs effect cleanups before unmount returns', () => {
    const h = harness()
    let cleaned = false

    function Watcher(): ReactNode {
      useEffect(() => {
        return () => {
          cleaned = true
        }
      }, [])
      return createElement('List', null)
    }

    h.render(createElement(Watcher, null))
    h.unmount()
    expect(cleaned).toBe(true)
  })

  it('reports a render error instead of throwing it', () => {
    const h = harness()

    function Boom(): ReactNode {
      throw new Error('extension exploded')
    }

    h.render(createElement(Boom, null))
    expect(h.errors).toHaveLength(1)
    expect((h.errors[0] as Error).message).toBe('extension exploded')
  })

  /**
   * A commit that touched nothing is not published.
   *
   * React commits whenever it has work, and a state change that ends up
   * returning the element already on screen is work that produces no mutation.
   * Serializing and diffing the tree to discover that is the cost this skips.
   */
  it('does not publish a commit that changed nothing', () => {
    const h = harness()
    const unchanging = createElement('List', null, createElement('List.Item', { title: 'Alpha' }))

    function Settling(): ReactNode {
      const [step, setStep] = useState(0)
      useEffect(() => {
        if (step === 0) setStep(1)
      }, [step])
      return unchanging
    }

    h.render(createElement(Settling, null))
    // A second pass, because the effect's state update lands after the first.
    h.render(createElement(Settling, null))
    expect(h.commits()).toBe(1)
  })

  it('never asks for a commit when a command renders nothing', () => {
    const h = harness()

    function Empty(): ReactNode {
      return null
    }

    h.render(createElement(Empty, null))
    expect(h.commits()).toBe(0)
  })

  it('publishes the unmount, because removing a node is a change', () => {
    const h = harness()
    h.render(createElement('List', null, createElement('List.Item', { title: 'Alpha' })))
    const mounted = h.commits()

    h.unmount()
    expect(h.commits()).toBeGreaterThan(mounted)
  })

  /**
   * Two renders of one item, with the second frame's props in a fresh object.
   *
   * The shape every list has: a state change above re-runs the component, so
   * React hands the host a new props object for the row whether or not a single
   * value in it differs.
   */
  function twoFrames(
    first: Record<string, unknown>,
    second: Record<string, unknown>
  ): { h: Harness; itemId: string } {
    const h = harness()

    function Row(): ReactNode {
      const [step, setStep] = useState(0)
      useEffect(() => {
        if (step === 0) setStep(1)
      }, [step])
      return createElement('List', null, createElement('List.Item', step === 0 ? first : second))
    }

    h.render(createElement(Row, null))
    // A second pass, because the effect's state update lands after the first.
    const tree = h.render(createElement(Row, null))
    const list = tree.children[0] as RenderNode
    return { h, itemId: (list.children[0] as RenderNode).id }
  }

  it('does not commit a props update that would serialize the same, and keeps the handler fresh', () => {
    const fired: number[] = []
    const { h, itemId } = twoFrames(
      { title: 'Alpha', subtitle: 'first', onAction: () => fired.push(1) },
      { title: 'Alpha', subtitle: 'first', onAction: () => fired.push(2) }
    )

    expect(h.commits()).toBe(1)
    h.handlers.get(handlerId(itemId, 'onAction'))?.(undefined)
    expect(fired).toEqual([2])
  })

  it('commits a changed value', () => {
    const { h } = twoFrames({ title: 'Alpha' }, { title: 'Beta' })
    expect(h.commits()).toBe(2)
  })

  it('commits a prop that was removed', () => {
    const { h } = twoFrames({ title: 'Alpha', subtitle: 'first' }, { title: 'Alpha' })
    expect(h.commits()).toBe(2)
  })

  it('commits a prop that became undefined', () => {
    const { h } = twoFrames(
      { title: 'Alpha', subtitle: 'first' },
      { title: 'Alpha', subtitle: undefined }
    )
    expect(h.commits()).toBe(2)
  })

  it('ignores a prop that is undefined on both sides, as the serializer does', () => {
    const { h } = twoFrames(
      { title: 'Alpha', subtitle: undefined },
      { title: 'Alpha', subtitle: undefined }
    )
    expect(h.commits()).toBe(1)
  })

  /** The limit, pinned: the comparison is shallow, so an equal array is a change. */
  it('commits an array prop rebuilt with equal contents', () => {
    const { h } = twoFrames(
      { title: 'Alpha', accessories: [{ text: 'one' }] },
      { title: 'Alpha', accessories: [{ text: 'one' }] }
    )
    expect(h.commits()).toBe(2)
  })
})
