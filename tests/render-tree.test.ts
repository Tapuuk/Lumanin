import { createElement, useState, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { applyPatch, compare, type Operation } from 'fast-json-patch'
import { createRenderer } from '../src/host/reconciler'
import { sameTree, serializeTree } from '../src/host/tree'
import {
  actionHandlerOf,
  listItemsOf,
  emptyTree,
  type RenderNode,
  type RenderPatch
} from '../src/shared/render-tree'
import { applyRenderPatches } from '../src/shared/render-patch'

/**
 * The patch round-trip: render fixture components in-worker, snapshot trees,
 * apply patches in a mock player, assert deep-equality with a fresh render.
 *
 * The property is the thing worth stating plainly: **a player that has applied
 * every patch in order holds exactly the tree the worker holds.** Nothing else
 * in the system checks it, and when it is false, everything downstream is drawing
 * a document that never existed on either side — with no error anywhere.
 */

interface Session {
  /** Render, then hand back the patches a real session would have sent. */
  step(element: ReactNode): readonly Operation[]
  /** The worker's tree. */
  readonly tree: RenderNode
}

function session(): Session {
  const renderer = createRenderer({ onCommit: () => {}, onError: () => {} })
  let previous: RenderNode = emptyTree()

  return {
    get tree(): RenderNode {
      return previous
    },
    step(element) {
      renderer.render(element)
      const { node } = serializeTree(renderer.root, { handler: () => {}, reject: () => {} })
      const patches = compare(previous as unknown as object, node as unknown as object)
      previous = node
      return patches
    }
  }
}

/**
 * Both halves of the seam, so every fixture below runs against each. The
 * library applier is what shipped first; the sharing one has to be
 * indistinguishable from it on anything the reconciler can produce.
 */
type Applier = (tree: RenderNode, patches: readonly Operation[]) => RenderNode

const library: Applier = (tree, patches) =>
  applyPatch(tree, patches as Operation[], false, false).newDocument
const sharing: Applier = (tree, patches) =>
  applyRenderPatches(tree, patches as unknown as readonly RenderPatch[])

/** The renderer's half: a document and nothing else. */
function player(applier: Applier): {
  apply(patches: readonly Operation[]): void
  readonly tree: RenderNode
} {
  let document: RenderNode = emptyTree()
  return {
    get tree(): RenderNode {
      return document
    },
    apply(patches) {
      document = applier(document, patches)
    }
  }
}

function List(props: { readonly items: readonly string[]; readonly loading?: boolean }): ReactNode {
  return createElement(
    'List',
    { isLoading: props.loading ?? false },
    createElement(
      'List.Section',
      { title: 'Things' },
      ...props.items.map((item) =>
        createElement('List.Item', {
          key: item,
          title: item,
          accessories: [{ text: String(item.length) }],
          onAction: () => {}
        })
      )
    )
  )
}

/** Titles that change under keys that do not, which is what a data load looks like. */
function Rows(props: { readonly titles: readonly string[] }): ReactNode {
  return createElement(
    'List',
    null,
    ...props.titles.map((title, index) =>
      createElement('List.Item', { key: `row-${index}`, title, accessories: [{ text: title }] })
    )
  )
}

describe.each([
  ['fast-json-patch', library],
  ['applyRenderPatches', sharing]
])('the patch round-trip (%s)', (_label, applier: Applier) => {
  it('leaves the player holding exactly what the worker holds', () => {
    const worker = session()
    const renderer = player(applier)

    const steps: ReactNode[] = [
      createElement(List, { items: [], loading: true }),
      createElement(List, { items: ['alpha', 'beta'] }),
      createElement(List, { items: ['beta', 'alpha'] }),
      createElement(List, { items: ['beta', 'gamma', 'alpha'] }),
      createElement(List, { items: ['gamma'] }),
      createElement(List, { items: [] })
    ]

    for (const step of steps) {
      renderer.apply(worker.step(step))
      expect(renderer.tree).toEqual(worker.tree)
    }
  })

  it('produces no patches at all when nothing changed', () => {
    const worker = session()
    worker.step(createElement(List, { items: ['alpha'] }))
    expect(worker.step(createElement(List, { items: ['alpha'] }))).toEqual([])
  })

  /**
   * State that changes without the element changing — the ordinary case for a
   * data-loading extension, and the one where a naive diff would replace the
   * whole subtree because nothing about the parent element told it otherwise.
   */
  it('carries a state update through as a minimal patch', () => {
    function Counter(): ReactNode {
      const [count, setCount] = useState(0)
      return createElement('List.Item', {
        title: `count ${count}`,
        onAction: () => setCount((value) => value + 1)
      })
    }

    const worker = session()
    const renderer = player(applier)
    renderer.apply(worker.step(createElement(Counter, null)))

    const item = worker.tree.children[0] as RenderNode
    expect(item.props['title']).toBe('count 0')
    expect(sameTree(renderer.tree, worker.tree)).toBe(true)
  })

  it('round-trips text children and keeps their identity', () => {
    const worker = session()
    const renderer = player(applier)

    renderer.apply(worker.step(createElement('Detail', null, 'first')))
    renderer.apply(worker.step(createElement('Detail', null, 'second')))

    const detail = renderer.tree.children[0] as RenderNode
    expect(detail.children).toHaveLength(1)
    expect(detail.children[0]).toMatchObject({ text: 'second' })
    expect(sameTree(renderer.tree, worker.tree)).toBe(true)
  })

  /**
   * The gap that made this whole mechanism necessary. A player that starts from
   * an empty document and misses the first batch cannot recover by applying the
   * second — the paths it names do not exist yet — which is why main keeps the
   * tree and hands it over as a snapshot.
   */
  it('cannot recover from a missed batch, which is why snapshots exist', () => {
    const worker = session()
    const late = player(applier)

    worker.step(createElement(List, { items: [], loading: true })) // dropped
    const second = worker.step(createElement(List, { items: ['alpha'] }))

    expect(() => late.apply(second)).toThrow()
  })
})

describe('applyRenderPatches', () => {
  const hand = (): RenderNode => ({
    id: 'root',
    type: '__root',
    props: {},
    children: [
      { id: 'a', type: 'List.Item', props: { title: 'A', 'a/b~c': 'raw' }, children: [] },
      { id: 'b', type: 'List.Item', props: { title: 'B' }, children: [] },
      { id: 'c', type: 'List.Item', props: { title: 'C' }, children: [] }
    ]
  })

  const alone = (patch: RenderPatch): RenderNode =>
    sharing(hand(), [patch] as unknown as Operation[])

  const both = (patch: RenderPatch): void => {
    const patches = [patch] as unknown as Operation[]
    expect(sharing(hand(), patches)).toEqual(library(hand(), patches))
  }

  it('agrees with the library on every batch a real render produces', () => {
    const worker = session()
    const one = player(library)
    const other = player(sharing)

    for (const titles of [
      ['one', 'two'],
      ['one', 'two', 'three'],
      ['three', 'two'],
      ['three']
    ]) {
      const patches = worker.step(createElement(Rows, { titles }))
      one.apply(patches)
      other.apply(patches)
      expect(other.tree).toEqual(one.tree)
      expect(sameTree(other.tree, worker.tree)).toBe(true)
    }
  })

  it('returns the tree itself when there is nothing to apply', () => {
    const tree = hand()
    expect(applyRenderPatches(tree, [])).toBe(tree)
  })

  /** The point of the whole applier: a redrawn row must not redraw its siblings. */
  it('keeps every node off the patched path', () => {
    const worker = session()
    const first = worker.step(createElement(Rows, { titles: ['one', 'two'] }))
    const before = sharing(emptyTree(), first)
    const patches = worker.step(createElement(Rows, { titles: ['one changed', 'two'] }))
    const after = sharing(before, patches)

    const list = (tree: RenderNode): RenderNode => tree.children[0] as RenderNode
    const row = (tree: RenderNode, index: number): RenderNode =>
      list(tree).children[index] as RenderNode

    expect(row(after, 0).props['title']).toBe('one changed')
    expect(row(after, 1)).toBe(row(before, 1))
    expect(row(after, 1).props).toBe(row(before, 1).props)
    expect(after).not.toBe(before)
    expect(row(before, 0).props['title']).toBe('one')
  })

  it('removes the first element of an array the way the library does', () => {
    both({ op: 'remove', path: '/children/0' })
  })

  it('adds at an interior index the way the library does', () => {
    both({
      op: 'add',
      path: '/children/1',
      value: { id: 'd', type: 'List.Item', props: { title: 'D' }, children: [] }
    })
  })

  it('moves a child within its array the way the library does', () => {
    both({ op: 'move', from: '/children/2', path: '/children/0' })
  })

  it('replaces a whole subtree the way the library does', () => {
    both({
      op: 'replace',
      path: '/children/1',
      value: { id: 'e', type: 'Detail', props: { markdown: 'x' }, children: [] }
    })
  })

  it('unescapes a prop name containing a slash and a tilde', () => {
    both({ op: 'replace', path: '/children/0/props/a~1b~0c', value: 'cooked' })
    const patched = alone({ op: 'replace', path: '/children/0/props/a~1b~0c', value: 'cooked' })
    expect((patched.children[0] as RenderNode).props['a/b~c']).toBe('cooked')
  })

  it('appends at the end of an array', () => {
    const value = { id: 'd', type: 'List.Item', props: { title: 'D' }, children: [] }
    const patched = alone({ op: 'add', path: '/children/-', value })
    expect(patched.children).toHaveLength(4)
    expect(patched.children[3]).toEqual(value)
  })

  it('appends at the index one past the last element', () => {
    const value = { id: 'd', type: 'List.Item', props: { title: 'D' }, children: [] }
    const patched = alone({ op: 'add', path: '/children/3', value })
    expect(patched.children).toHaveLength(4)
    expect(patched.children[3]).toEqual(value)
  })

  /**
   * An index no element occupies would stretch the array with holes, and a hole
   * serializes as a child nothing ever rendered. Only an append may name the
   * slot after the last one.
   */
  it('throws on a write past the end of an array', () => {
    expect(() => alone({ op: 'add', path: '/children/4', value: null })).toThrow(
      /"add" at "\/children\/4" writes past the end/
    )
    expect(() => alone({ op: 'replace', path: '/children/3', value: null })).toThrow(
      /"replace" at "\/children\/3" writes past the end/
    )
    // The source is taken out first, so the destination is read against two
    // remaining children rather than three.
    expect(() => alone({ op: 'move', from: '/children/0', path: '/children/3' })).toThrow(
      /"move" at "\/children\/3" writes past the end/
    )
  })

  /** The end of an array is a place to append, not an element to take out. */
  it('throws when a read addresses the end of an array', () => {
    expect(() => alone({ op: 'remove', path: '/children/-' })).toThrow(
      /"remove" at "\/children\/-" cannot address the end/
    )
    expect(() => alone({ op: 'move', from: '/children/-', path: '/children/0' })).toThrow(
      /"move" at "\/children\/-" cannot address the end/
    )
  })

  /**
   * A slot no element occupies is nothing to take out: the remove would quietly
   * change nothing, and the move would carry a hole to its destination.
   */
  it('throws on a read past the end of an array', () => {
    expect(() => alone({ op: 'remove', path: '/children/9' })).toThrow(
      /"remove" at "\/children\/9" reads past the end/
    )
    expect(() => alone({ op: 'move', from: '/children/9', path: '/children/0' })).toThrow(
      /"move" at "\/children\/9" reads past the end/
    )
  })

  /** Half of a move is its source, and a failure there names that half. */
  it('names the source path when a move fails resolving it', () => {
    expect(() => alone({ op: 'move', from: '/children/9/props/x', path: '/children/0' })).toThrow(
      /"move" at "\/children\/9\/props\/x" passes through a value that is not an object/
    )
    expect(() => alone({ op: 'move', from: '/children/0/__proto__', path: '/children/0' })).toThrow(
      /"move" at "\/children\/0\/__proto__" walks into a prototype/
    )
  })

  /**
   * Refused rather than approximated: a wrongly applied batch does not fail
   * loudly, it produces a tree that never existed on either side.
   */
  it('throws on an operation the render diff never produces', () => {
    expect(() => alone({ op: 'copy', from: '/children/0', path: '/children/1' })).toThrow(
      /"copy" at "\/children\/1"/
    )
    expect(() => alone({ op: 'test', path: '/children/0', value: null })).toThrow(
      /"test" at "\/children\/0"/
    )
  })

  it('throws when the path leads through a node that is not there', () => {
    expect(() => alone({ op: 'replace', path: '/children/9/props/title', value: 'x' })).toThrow(
      /"replace" at "\/children\/9\/props\/title"/
    )
  })
})

describe('listItemsOf (the enumerate verb reading a tree)', () => {
  const node = (type: string, props: Record<string, unknown>, children: unknown[] = []) =>
    ({ id: type, type, props, children }) as never

  const doc = (view: unknown) =>
    node('__root', {}, [node('__view', {}, [view])]) as Parameters<typeof listItemsOf>[0]

  it('answers null while the list is loading, and rows once it settles', () => {
    const loading = doc(node('List', { isLoading: true }))
    expect(listItemsOf(loading)).toBeNull()

    const settled = doc(
      node('List', { isLoading: false }, [
        node('List.Section', { title: 'A' }, [
          node('List.Item', { id: 'one', title: 'One', subtitle: 'first' })
        ]),
        node('List.Item', { title: { value: 'Two' } })
      ])
    )
    expect(listItemsOf(settled)).toEqual([
      { id: 'one', title: 'One', subtitle: 'first', actions: [], icon: null },
      { id: null, title: 'Two', subtitle: null, actions: [], icon: null }
    ])
  })

  it('answers null for a view that is not a List at all', () => {
    expect(listItemsOf(doc(node('Detail', { markdown: 'x' })))).toBeNull()
    expect(listItemsOf(node('__root', {}, []) as Parameters<typeof listItemsOf>[0])).toBeNull()
  })

  it('reads an empty settled list as a real, empty answer', () => {
    expect(listItemsOf(doc(node('List', {})))).toEqual([])
  })

  /**
   * The action level, which is what a key bound to "Dawnline → Open project"
   * names. Actions live in the item's `actions` slot and are reported by title,
   * because a title is the only name an action keeps between two launches.
   */
  describe('a row’s actions', () => {
    const slot = (children: unknown[]) => node('__slot', { name: 'actions' }, children)
    const action = (title: string, handler: string | null) =>
      node(`Action.${title.replace(/\s/g, '')}`, {
        title,
        ...(handler === null ? {} : { onAction: { __handler: handler } })
      })

    const tree = doc(
      node('List', {}, [
        node('List.Item', { id: 'dawnline', title: 'Dawnline' }, [
          slot([
            node('ActionPanel', {}, [
              action('Open project', 'h1'),
              node('ActionPanel.Section', { title: 'More' }, [action('Run project', 'h2')]),
              node('ActionPanel.Submenu', { title: 'Copy' }, [action('Copy path', 'h3')])
            ])
          ])
        ]),
        node('List.Item', { id: 'fog', title: 'Fog Descend' })
      ])
    )

    it('reports every action title, through sections and submenus', () => {
      expect(listItemsOf(tree)).toEqual([
        {
          id: 'dawnline',
          title: 'Dawnline',
          subtitle: null,
          // The submenu itself is not in the list — it opens a menu rather
          // than doing anything — but what is inside it is.
          actions: ['Open project', 'Run project', 'Copy path'],
          icon: null
        },
        { id: 'fog', title: 'Fog Descend', subtitle: null, actions: [], icon: null }
      ])
    })

    it('finds the handler behind one action of one row', () => {
      expect(actionHandlerOf(tree, 'dawnline', 'Open project')).toBe('h1')
      expect(actionHandlerOf(tree, 'dawnline', 'Run project')).toBe('h2')
      expect(actionHandlerOf(tree, 'dawnline', 'Copy path')).toBe('h3')
    })

    it('answers null for a row or an action the plugin no longer offers', () => {
      // Both are the same failure to the caller — a key naming something that
      // is not there — and both have to be reported rather than run silently.
      expect(actionHandlerOf(tree, 'dawnline', 'Delete project')).toBeNull()
      expect(actionHandlerOf(tree, 'gone', 'Open project')).toBeNull()
      expect(actionHandlerOf(tree, 'fog', 'Open project')).toBeNull()
    })
  })
})
