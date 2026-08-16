import type { WebContents } from 'electron'

/**
 * Applying the desktop's text size to a window.
 *
 * The renderer is designed in CSS pixels at one size and Chromium's zoom factor
 * scales all of it - type, spacing, icons, radii - the same way the desktop
 * scales the shell beside it. That is deliberately not a `font-size` on `html`:
 * a launcher whose text grew while its rows and padding stayed put would look
 * broken at 1.3, and the shell it sits on scales its bar and paddings with the
 * font (`scale-with-font` in Omarchy's `shell.toml`) for the same reason.
 *
 * Chromium keeps zoom per origin and forgets it across loads, so the factor is
 * re-applied on every `dom-ready` as well as when it changes.
 */

const applied = new WeakMap<WebContents, number>()

export function applyTextScale(contents: WebContents, factor: number): void {
  const clamped = Math.min(3, Math.max(0.5, factor))
  applied.set(contents, clamped)
  if (!contents.isLoading()) contents.setZoomFactor(clamped)
  if (contents.listenerCount('dom-ready') === 0 || !contents.listeners('dom-ready').includes(reapply)) {
    contents.on('dom-ready', reapply)
  }
}

function reapply(this: WebContents): void {
  const factor = applied.get(this)
  if (factor !== undefined) this.setZoomFactor(factor)
}
