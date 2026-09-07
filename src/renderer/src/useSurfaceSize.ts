import { useLayoutEffect } from 'react'
import { surfaceSize } from '@shared/surface-size'

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
 *
 * One more thing they are not: zoomed. `outerWidth` stays in window pixels when
 * the main process zooms the page for the desktop's text size
 * (`ThemePayload.textScale`), while every CSS pixel now covers `zoom` of them -
 * so the surface size in CSS pixels is `outer / zoom`, floored so the last
 * fractional pixel is left empty rather than painted off the edge. Sizing to
 * the bare `outerWidth` under a 1.17 zoom made the panel 17% wider than the
 * viewport and took the right border with it.
 *
 * And one CSS pixel less than that, on both axes. `outerWidth` comes back from
 * the Wayland configure round-trip rounded up (1307 logical / 1.1875 zoom is
 * 1100.63, reported as 1101 on a 1634 px buffer), which puts the panel's 1 px
 * outline on the buffer's last column and, with a full list, its last row. When
 * the window's physical box is not integer (monitor scale 1.25 with a position
 * from `monitor_h * 0.35`, or a window the compositor re-floated somewhere
 * fractional) Hyprland rounds the box and that last column or row is simply not
 * shown, and the right or bottom edge of the outline goes with it. Measured on
 * this machine: at the rule's position the right border sat on buffer column
 * 1633 of 1634 and survived; moved to x=118,y=302 it was gone. Leaving the last
 * CSS pixel empty makes a dropped column or row transparent backdrop instead.
 */
export function useSurfaceSize(zoom: number): void {
  useLayoutEffect(() => {
    const root = document.documentElement

    const sync = (): void => {
      const width = surfaceSize(window.outerWidth, window.innerWidth, zoom)
      const height = surfaceSize(window.outerHeight, window.innerHeight, zoom)
      root.style.setProperty('--lumanin-surface-width', `${String(width)}px`)
      root.style.setProperty('--lumanin-surface-height', `${String(height)}px`)
    }

    sync()
    window.addEventListener('resize', sync)
    return () => {
      window.removeEventListener('resize', sync)
    }
  }, [zoom])
}
