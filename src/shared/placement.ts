/**
 * Where the panel sits on screen.
 *
 * One number, used by both paths that can place a window: the compositor rule
 * `lumanin doctor --fix` writes for Wayland, and `PanelWindow.position` for X11.
 * They must agree — a panel that opens in a different place depending on the
 * session type is a bug the user experiences as the app being unreliable.
 */

/**
 * The fraction of the screen height at which the panel's **top edge** sits.
 *
 * The window is a fixed box (see ARCHITECTURE.md §"Panel sizing") with the
 * search bar at the top of it, so this is really "where the search bar lands",
 * and the bar is what the number is chosen for: at 0.32, the bar's centre falls
 * around 65% of the way up the screen from the bottom.
 *
 * Centred was wrong for the same reason a centred dialog looks low: the eye
 * weights the thing it is about to type into, not the box around it, so a
 * launcher whose *field* is at the midpoint reads as sitting below centre.
 */
export const PANEL_TOP_FRACTION = 0.32

/** The panel's top edge within a work area, in the work area's own coordinates. */
export function panelTop(workAreaY: number, workAreaHeight: number): number {
  return Math.round(workAreaY + workAreaHeight * PANEL_TOP_FRACTION)
}
