import type { Exec } from '../../exec'
import type { WindowInfo, WindowsBackend } from '../index'

/**
 * Hyprland's own IPC via `hyprctl -j` (PLATFORM-MATRIX §7 backend 1).
 *
 * Shape verified against Hyprland on the dev machine rather than from memory —
 * `hyprctl clients -j` returns an array whose entries carry `address`, `class`,
 * `title`, `workspace: {id, name}`, `mapped`, `hidden` and `focusHistoryID`.
 *
 * `focusHistoryID` is the focus stack position, so **0 is the focused window**,
 * not "no history". Deriving focus from it costs one subprocess where
 * `hyprctl activewindow` would cost a second, and the two can disagree if focus
 * moves between the calls.
 *
 * Windows that are unmapped or hidden are dropped: they are real to the
 * compositor and meaningless in a switcher.
 */

interface HyprClient {
  readonly address?: unknown
  readonly class?: unknown
  readonly title?: unknown
  readonly mapped?: unknown
  readonly hidden?: unknown
  readonly focusHistoryID?: unknown
  readonly workspace?: { readonly name?: unknown } | unknown
}

export function createHyprctl(exec: Exec): WindowsBackend {
  return {
    id: 'hyprctl',

    async list() {
      const result = await exec.run('hyprctl', ['-j', 'clients'])
      if (!result.ok) return []
      return parseClients(result.stdout)
    },

    async focus(windowId) {
      // `address:` is the selector form; the id we handed out is the address, so
      // nothing here is built from a title or any other attacker-shaped string.
      const result = await exec.run('hyprctl', ['dispatch', 'focuswindow', `address:${windowId}`])
      return result.ok && !result.stdout.startsWith('Invalid')
    }
  }
}

/** Exported for tests: parsing a compositor's JSON is the part that can be wrong. */
export function parseClients(json: string): readonly WindowInfo[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const windows: WindowInfo[] = []
  for (const entry of parsed as HyprClient[]) {
    if (typeof entry !== 'object') continue
    const address = entry.address
    if (typeof address !== 'string' || address.length === 0) continue
    if (entry.mapped === false || entry.hidden === true) continue

    const workspace = readWorkspaceName(entry.workspace)
    windows.push({
      id: address,
      title: typeof entry.title === 'string' ? entry.title : '',
      appId: typeof entry.class === 'string' ? entry.class : '',
      focused: entry.focusHistoryID === 0,
      ...(workspace === null ? {} : { workspace })
    })
  }
  return windows
}

function readWorkspaceName(workspace: unknown): string | null {
  if (typeof workspace !== 'object' || workspace === null) return null
  const name = (workspace as { name?: unknown }).name
  return typeof name === 'string' && name.length > 0 ? name : null
}
