import type { Exec } from '../exec'
import { createEwmh } from './backends/ewmh'
import { createHyprctl } from './backends/hyprctl'
import { createSwaymsg } from './backends/swaymsg'

/**
 * Window listing and focusing (PLATFORM-MATRIX §7) — what backs
 * `getFrontmostApplication` in the api shim.
 *
 * Every backend answers the same two questions ("what is open" and "focus that")
 * through a completely different mechanism: a compositor's own IPC, a Wayland
 * protocol, or the X11 window properties EWMH standardised. None of that reaches
 * the caller.
 */

export interface WindowInfo {
  /** Opaque to callers — its format is the backend's business. */
  readonly id: string
  readonly title: string
  /** The application identity: `app_id` on Wayland, `WM_CLASS` on X11. */
  readonly appId: string
  readonly focused: boolean
  /** Workspace name or number where the backend reports one. */
  readonly workspace?: string
}

export interface WindowsBackend {
  readonly id: string
  list(): Promise<readonly WindowInfo[]>
  /** Resolves false when the window is gone — a race, not an error. */
  focus(windowId: string): Promise<boolean>
}

export const WINDOWS_BACKEND_IDS = ['hyprctl', 'swaymsg', 'ewmh'] as const

export function createWindows(id: string | null, exec: Exec): WindowsBackend {
  switch (id) {
    case 'hyprctl':
      return createHyprctl(exec)
    case 'swaymsg':
      return createSwaymsg(exec)
    case 'ewmh':
      return createEwmh(exec)
    case null:
      return unsupportedWindows()
    default:
      throw new Error(`no windows implementation for backend '${id}'`)
  }
}

/**
 * PLATFORM-MATRIX §7 backend 6: GNOME Wayland hides the window list from clients
 * entirely, and reading it needs a companion shell extension we do not ship yet.
 * An empty list is the truthful answer — the switcher hides itself rather than
 * showing a window list that is wrong.
 */
function unsupportedWindows(): WindowsBackend {
  return {
    id: 'unsupported',
    list: () => Promise.resolve([]),
    focus: () => Promise.resolve(false)
  }
}
