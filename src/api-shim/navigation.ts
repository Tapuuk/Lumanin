import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import type { Navigation } from '@raycast/api'
import { INTERNAL_TYPES } from '../shared/render-tree'

/**
 * The navigation stack, which is one React tree and not several.
 *
 * `useNavigation().push(<View/>)` mounts the
 * pushed view *inside* the session's existing tree, so the reconciler emits
 * ordinary patches. There is no second tree, no second reconciler, and nothing
 * for the renderer to reconcile between two sources of truth.
 *
 * **Every entry stays mounted.** Only the last one is displayed, but the ones
 * beneath keep their state, so popping back to a list returns you to the list
 * you left — same search text, same selection, same loaded data — instead of a
 * fresh one that refetches. The cost is that a view beneath the top goes on
 * running its effects; that is the same cost React itself pays for a hidden
 * route, and the alternative (unmount on push) makes `pop` a synonym for
 * "start over", which is not what going back means.
 */

const NavigationContext = createContext<Navigation | null>(null)

/**
 * `useNavigation()`.
 *
 * Throws outside a command rather than returning a no-op pair. A silent no-op
 * here would produce an action that does nothing when pressed, with no error
 * anywhere — the exact failure the "throw, never no-op" rule is about.
 */
export function useNavigation(): Navigation {
  const navigation = useContext(NavigationContext)
  if (navigation === null) {
    throw new Error('useNavigation() was called outside a command view')
  }
  return navigation
}

interface StackEntry {
  readonly key: number
  readonly node: ReactNode
  readonly onPop: (() => void) | undefined
}

/**
 * The imperative side of the stack.
 *
 * The renderer pops with a keypress, which arrives over RPC in the worker rather
 * than inside React, so something outside the component tree has to reach in.
 * A module-level control object with a subscription is the smallest thing that
 * does it — and it is per-worker, which is per-extension, so there is exactly one
 * stack for it to point at.
 */
interface Control {
  pop(): void
  popToRoot(): void
}

let control: Control | null = null

/** Called by the worker when the renderer asks to go back. Safe before mount. */
export function popNavigation(): void {
  control?.pop()
}

export interface CommandRootProps {
  readonly children: ReactNode
}

/**
 * The single root of a session's tree.
 *
 * Wraps the command's own element as stack entry 0 and provides the navigation
 * context. The worker renders exactly this, once.
 */
export function CommandRoot({ children }: CommandRootProps): ReactElement {
  const [stack, setStack] = useState<readonly StackEntry[]>([
    { key: 0, node: children, onPop: undefined }
  ])

  // Entry 0 tracks the command element itself, so a hot reload that replaces the
  // command's element does not have to tear the stack down.
  useEffect(() => {
    setStack((current) =>
      current.map((entry) => (entry.key === 0 ? { ...entry, node: children } : entry))
    )
  }, [children])

  const push = useCallback((node: ReactNode, onPop?: () => void) => {
    setStack((current) => [...current, { key: current.length, node, onPop }])
  }, [])

  const pop = useCallback(() => {
    setStack((current) => {
      if (current.length <= 1) return current
      const removed = current[current.length - 1]
      // After the state update, never during it: `onPop` is the extension's code
      // and it commonly calls `setState` on the view being returned to, which is
      // not something a reducer may do while React is rendering.
      if (removed?.onPop !== undefined) queueMicrotask(removed.onPop)
      return current.slice(0, -1)
    })
  }, [])

  const popToRoot = useCallback(() => {
    setStack((current) => {
      for (const entry of current.slice(1).reverse()) {
        if (entry.onPop !== undefined) queueMicrotask(entry.onPop)
      }
      return current.slice(0, 1)
    })
  }, [])

  useEffect(() => {
    control = { pop, popToRoot }
    return () => {
      control = null
    }
  }, [pop, popToRoot])

  const navigation = useMemo<Navigation>(() => ({ push, pop }), [push, pop])

  // No wrapper element around the stack: the reconciler's *container* is the
  // tree's `__root`, so adding one here would produce a second root inside the
  // first and leave the renderer picking between two things called the same.
  return createElement(
    NavigationContext.Provider,
    { value: navigation },
    ...stack.map((entry, index) =>
      createElement(
        INTERNAL_TYPES.VIEW,
        { key: entry.key, index, active: index === stack.length - 1 },
        entry.node
      )
    )
  )
}
