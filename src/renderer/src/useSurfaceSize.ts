import { useLayoutEffect } from 'react'

/**
 * Pins the panel to the window's real surface size.
 *
 * Under fractional display scaling Chromium rounds the CSS viewport *up*: on a
 * 1.2× monitor a 760×200 window reports `innerWidth`/`innerHeight` of 761×201
 * (and `document.documentElement.clientWidth` agrees). That final CSS pixel row
 * and column do not exist on the surface, so anything painted there is simply
 * not shown — which is why a full-bleed panel lost its right and bottom border
 * while keeping the left and top ones.
 *
 * Measured on a 1.2× monitor across several sizes:
 *
 *   asked 760×200 → outer 760×200, inner 761×201, visualViewport 760.83×200.83
 *   asked 500×120 → outer 500×120, inner 500×120, visualViewport 500.00×120.00
 *   asked 900×340 → outer 900×340, inner 900×341, visualViewport 900.00×340.83
 *
 * `outerWidth`/`outerHeight` track the window exactly in every case, including
 * when there is no overhang at all, so they — not the viewport — are what the
 * panel must size against. Publishing them as custom properties keeps the
 * correction in one place instead of scattering `calc()` through the stylesheet.
 */
export function useSurfaceSize(): void {
  useLayoutEffect(() => {
    const root = document.documentElement

    const sync = (): void => {
      // Fall back to the viewport if the window object ever reports 0 (it does
      // during teardown); a panel sized 0 is worse than one pixel of overhang.
      const width = window.outerWidth || window.innerWidth
      const height = window.outerHeight || window.innerHeight
      root.style.setProperty('--lumanin-surface-width', `${String(width)}px`)
      root.style.setProperty('--lumanin-surface-height', `${String(height)}px`)
    }

    sync()
    window.addEventListener('resize', sync)
    return () => {
      window.removeEventListener('resize', sync)
    }
  }, [])
}
