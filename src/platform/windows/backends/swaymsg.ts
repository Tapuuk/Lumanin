import type { Exec } from '../../exec'
import type { WindowInfo, WindowsBackend } from '../index'

/**
 * Sway/i3 IPC via `swaymsg -t get_tree` (PLATFORM-MATRIX §7 backend 2).
 *
 * The tree is nested — outputs contain workspaces contain containers contain
 * windows — so this walks it rather than reading a flat list, carrying the
 * enclosing workspace name down as it goes. Leaf windows are the nodes with an
 * `app_id` (Wayland) or `window_properties.class` (XWayland); everything else is
 * layout structure.
 *
 * `floating_nodes` is a sibling of `nodes` and holds exactly the floating windows
 * a launcher's switcher most needs to find. Walking only `nodes` silently omits
 * them.
 *
 * UNVERIFIED: written against the sway IPC documentation. The dev machine runs
 * Hyprland, so nobody has watched this parse a real tree — see TESTING.md.
 */

interface SwayNode {
  readonly id?: unknown
  readonly name?: unknown
  readonly type?: unknown
  readonly app_id?: unknown
  readonly focused?: unknown
  readonly window_properties?: { readonly class?: unknown } | unknown
  readonly nodes?: unknown
  readonly floating_nodes?: unknown
}

export function createSwaymsg(exec: Exec): WindowsBackend {
  return {
    id: 'swaymsg',

    async list() {
      const result = await exec.run('swaymsg', ['-t', 'get_tree', '-r'])
      if (!result.ok) return []
      return parseTree(result.stdout)
    },

    async focus(windowId) {
      // The criteria string is built from a container id we handed out, which is
      // always numeric — nothing user-supplied reaches the selector.
      const result = await exec.run('swaymsg', [`[con_id=${windowId}]`, 'focus'])
      return result.ok
    }
  }
}

/** Exported for tests: the tree walk is the part that can be wrong. */
export function parseTree(json: string): readonly WindowInfo[] {
  let root: unknown
  try {
    root = JSON.parse(json)
  } catch {
    return []
  }

  const windows: WindowInfo[] = []
  walk(root, null, windows)
  return windows
}

function walk(node: unknown, workspace: string | null, out: WindowInfo[]): void {
  if (typeof node !== 'object' || node === null) return
  const n = node as SwayNode

  const here = n.type === 'workspace' && typeof n.name === 'string' ? n.name : workspace
  const appId = readAppId(n)

  if (appId !== null && typeof n.id === 'number') {
    out.push({
      id: String(n.id),
      title: typeof n.name === 'string' ? n.name : '',
      appId,
      focused: n.focused === true,
      ...(here === null ? {} : { workspace: here })
    })
  }

  for (const list of [n.nodes, n.floating_nodes]) {
    if (!Array.isArray(list)) continue
    for (const child of list) walk(child, here, out)
  }
}

function readAppId(node: SwayNode): string | null {
  if (typeof node.app_id === 'string' && node.app_id.length > 0) return node.app_id

  const properties = node.window_properties
  if (typeof properties === 'object' && properties !== null) {
    const className = (properties as { class?: unknown }).class
    if (typeof className === 'string' && className.length > 0) return className
  }
  return null
}
