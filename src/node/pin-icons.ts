/**
 * Where a pinned row's inline icon lives.
 *
 * A plugin may hand a row a `data:` URL — a Godot project's icon is one, read
 * from the project itself — and that is tens of kilobytes of base64 which has
 * no business on one line of `config.toml`. It is written once under the data
 * directory, named by its content, and the pin keeps a short
 * `lumanin-icon://pin/<hash>.<ext>` that the daemon serves back.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ICON_SCHEME } from '../shared/identity'

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

const NAME = /^[0-9a-f]{64}\.(svg|png|jpg|webp|gif)$/

export function pinIconsDir(dataDir: string): string {
  return join(dataDir, 'pin-icons')
}

/** Decode a `data:` URL into bytes and a file extension, or `null` when it is not an image we serve. */
export function decodeDataUri(uri: string): { bytes: Buffer; extension: string } | null {
  const match = /^data:([^;,]+)((?:;[^,]*)*),(.*)$/is.exec(uri)
  if (match === null) return null
  const extension = EXTENSIONS[(match[1] ?? '').toLowerCase()]
  if (extension === undefined) return null
  const parameters = match[2] ?? ''
  const payload = match[3] ?? ''
  const bytes = /;base64/i.test(parameters)
    ? Buffer.from(payload, 'base64')
    : Buffer.from(safeDecode(payload), 'utf8')
  return bytes.length === 0 ? null : { bytes, extension }
}

function safeDecode(payload: string): string {
  try {
    return decodeURIComponent(payload)
  } catch {
    return payload
  }
}

/** Write the icon behind a `data:` URL and return the URL a pin stores, or `null` when it cannot be kept. */
export function storePinIcon(dataDir: string, uri: string): string | null {
  const decoded = decodeDataUri(uri)
  if (decoded === null) return null
  const name = `${createHash('sha256').update(decoded.bytes).digest('hex')}.${decoded.extension}`
  const dir = pinIconsDir(dataDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), decoded.bytes, { mode: 0o644 })
  return `${ICON_SCHEME}://pin/${name}`
}

/** The file behind `lumanin-icon://pin/<name>`; a name that is not a content hash is refused. */
export function pinIconPath(dataDir: string, pathname: string): string | null {
  const name = pathname.replace(/^\//, '')
  return NAME.test(name) ? join(pinIconsDir(dataDir), name) : null
}
