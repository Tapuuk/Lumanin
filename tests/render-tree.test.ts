import { createElement, useState, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { applyPatch, compare, type Operation } from 'fast-json-patch'
import { createRenderer } from '../src/host/reconciler'
import { sameTree, serializeTree } from '../src/host/tree'
import { actionHandlerOf, listItemsOf, emptyTree, type RenderNode } from '../src/shared/render-tree'

/**
 * The patch round-trip, which ARCHITECTURE.md asks for by name:
 *
 * > render fixture components in-worker, snapshot trees, apply patches in a mock
 * > player, assert deep-equality with a fresh render.
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

/** The renderer's half: a document and nothing else. */
function player(): { apply(patches: readonly Operation[]): void; readonly tree: RenderNode } {
  let document: RenderNode = emptyTree()
  return {
    get tree(): RenderNode {
      return document
    },
    apply(patches) {
      document = applyPatch(document, patches as Operation[], false, false).newDocument
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

describe('the patch round-trip', () => {
  it('leaves the player holding exactly what the worker holds', () => {
    const worker = session()
    const renderer = player()

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
    const renderer = player()
    renderer.apply(worker.step(createElement(Counter, null)))

    const item = worker.tree.children[0] as RenderNode
    expect(item.props['title']).toBe('count 0')
    expect(sameTree(renderer.tree, worker.tree)).toBe(true)
  })

  it('round-trips text children and keeps their identity', () => {
    const worker = session()
    const renderer = player()

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
    const late = player()

    worker.step(createElement(List, { items: [], loading: true })) // dropped
    const second = worker.step(createElement(List, { items: ['alpha'] }))

    expect(() => late.apply(second)).toThrow()
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
      { id: 'one', title: 'One', subtitle: 'first', actions: [] },
      { id: null, title: 'Two', subtitle: null, actions: [] }
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
          actions: ['Open project', 'Run project', 'Copy path']
        },
        { id: 'fog', title: 'Fog Descend', subtitle: null, actions: [] }
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
