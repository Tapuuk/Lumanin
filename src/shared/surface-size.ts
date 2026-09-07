/**
 * The surface size in CSS pixels the panel may paint into, from the window's
 * `outerWidth`/`outerHeight` and the page zoom: `outer / zoom`, floored, and one
 * pixel less. The reasoning is with the hook that uses it, `useSurfaceSize`.
 */
export function surfaceSize(outer: number, inner: number, zoom: number): number {
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  // Fall back to the viewport if the window object ever reports 0 (it does
  // during teardown); a panel sized 0 is worse than one pixel of overhang.
  const full = outer ? Math.floor(outer / factor) : inner
  return Math.max(1, full - 1)
}
