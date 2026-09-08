import type { BinaryMap } from './binaries'
import type { Tri } from './dbus'
import { run } from './run'

/**
 * Wayland protocol probe (detection step 3).
 *
 * The plan was a native addon as the primary path with `wayland-info`
 * as fallback. The addon does not exist yet, so this is the fallback only — and
 * `wayland-info` is *not installed by default* on any of the target distros
 * (Arch: `wayland-utils`), so `UNKNOWN` is the common case rather than the edge
 * case. Backends must therefore select on env and binary evidence and treat
 * UNKNOWN as "might work", never as "absent".
 */

export interface WaylandProtocols {
  readonly hasLayerShell: Tri
  readonly hasDataControl: Tri
  readonly hasForeignToplevel: Tri
  readonly hasVirtualKeyboard: Tri
  /** True when the answers came from a real enumeration rather than defaults. */
  readonly probed: boolean
  readonly detail: string
}

export const UNPROBED_PROTOCOLS: WaylandProtocols = {
  hasLayerShell: 'UNKNOWN',
  hasDataControl: 'UNKNOWN',
  hasForeignToplevel: 'UNKNOWN',
  hasVirtualKeyboard: 'UNKNOWN',
  probed: false,
  detail: 'wayland-info not installed (Arch: wayland-utils); protocols unknown'
}

const NOT_WAYLAND: WaylandProtocols = {
  hasLayerShell: false,
  hasDataControl: false,
  hasForeignToplevel: false,
  hasVirtualKeyboard: false,
  probed: true,
  detail: 'not a Wayland session'
}

/** Globals are matched by name substring; versions and suffixes vary by compositor. */
function has(globals: string, ...needles: readonly string[]): boolean {
  return needles.some((needle) => globals.includes(needle))
}

export async function probeWaylandProtocols(
  binaries: BinaryMap,
  isWayland: boolean
): Promise<WaylandProtocols> {
  if (!isWayland) return NOT_WAYLAND

  const tool = binaries['wayland-info'] ?? binaries['weston-info']
  if (tool === null || tool === undefined) return UNPROBED_PROTOCOLS

  const result = await run(tool, [])
  if (!result.ok) return { ...UNPROBED_PROTOCOLS, detail: `${tool} failed to enumerate globals` }

  const globals = result.stdout
  return {
    hasLayerShell: has(globals, 'zwlr_layer_shell_v1'),
    // Both the wlroots protocol and its ext- successor grant clipboard watching.
    hasDataControl: has(globals, 'zwlr_data_control_manager_v1', 'ext_data_control_manager_v1'),
    hasForeignToplevel: has(
      globals,
      'zwlr_foreign_toplevel_manager_v1',
      'ext_foreign_toplevel_list_v1'
    ),
    hasVirtualKeyboard: has(globals, 'zwp_virtual_keyboard_manager_v1'),
    probed: true,
    detail: `enumerated via ${tool}`
  }
}
