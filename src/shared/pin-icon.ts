/**
 * The face of a plugin row, as something the root can draw without the plugin.
 *
 * A `List.Item` icon is whatever the plugin rendered: a theme name, an asset
 * path, a web or data URL, an `Icon.*` glyph. A pinned row has to be drawn
 * before its plugin runs, so at pin time the icon is reduced to one string the
 * renderer can put straight into `<img src>`, or to nothing — an `Icon.*` glyph
 * and a `{fileIcon}` are resolved by the renderer from the live tree and have no
 * URL to keep, so the pin falls back to its command's icon.
 */

import { ICON_SCHEME } from './identity'
import type { RenderValue } from './render-tree'

export function themeIconUrl(names: string): string {
  return `${ICON_SCHEME}://theme/${encodeURIComponent(names)}`
}

export function assetUrl(extension: string, path: string): string {
  return `${ICON_SCHEME}://ext/${encodeURIComponent(extension)}/${path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`
}

export function rootIconOf(value: RenderValue | undefined, extension: string): string | null {
  if (value === undefined || value === null) return null

  if (typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Readonly<Record<string, RenderValue | undefined>>
    if (object['fileIcon'] !== undefined) return null
    const source = object['source'] ?? object['value']
    return source === undefined ? null : rootIconOf(source, extension)
  }

  if (typeof value !== 'string' || value.length === 0) return null
  // Every `Icon.*` value ends in a size suffix; the renderer draws those as glyphs.
  if (/-\d+$/.test(value)) return null
  if (/^(https?:|data:)/i.test(value)) return value
  if (value.startsWith('system:')) return themeIconUrl(value.slice('system:'.length))
  return assetUrl(extension, value)
}
