import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pinIconPath, storePinIcon } from '../src/node/pin-icons'
import { rootIconOf } from '../src/shared/pin-icon'

describe('rootIconOf (a List.Item icon as something the root can draw)', () => {
  it('keeps URLs, maps theme and asset names, and drops glyphs', () => {
    expect(rootIconOf('data:image/png;base64,AAAA', 'godot')).toBe('data:image/png;base64,AAAA')
    expect(rootIconOf('https://x.test/a.png', 'godot')).toBe('https://x.test/a.png')
    expect(rootIconOf('system:folder,inode-directory', 'godot')).toBe(
      'lumanin-icon://theme/folder%2Cinode-directory'
    )
    expect(rootIconOf('icons/a b.png', 'godot')).toBe('lumanin-icon://ext/godot/icons/a%20b.png')
    expect(rootIconOf('star-circle-16', 'godot')).toBeNull()
    expect(rootIconOf({ source: 'system:firefox', tintColor: 'red' }, 'godot')).toBe(
      'lumanin-icon://theme/firefox'
    )
    expect(rootIconOf({ fileIcon: '/etc/hosts' }, 'godot')).toBeNull()
    expect(rootIconOf(undefined, 'godot')).toBeNull()
  })
})

describe('storePinIcon', () => {
  it('writes an inline image once, by content, and serves it by name only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumanin-pin-icons-'))
    const svg = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'
    const url = storePinIcon(dir, svg)
    expect(url).toMatch(/^lumanin-icon:\/\/pin\/[0-9a-f]{64}\.svg$/)
    expect(storePinIcon(dir, svg)).toBe(url)
    expect(readdirSync(join(dir, 'pin-icons'))).toHaveLength(1)

    const name = (url as string).slice('lumanin-icon://pin/'.length)
    const file = pinIconPath(dir, `/${name}`)
    expect(file).not.toBeNull()
    expect(readFileSync(file as string, 'utf8')).toContain('<svg')

    expect(pinIconPath(dir, '/../config.toml')).toBeNull()
    expect(pinIconPath(dir, '/notahash.png')).toBeNull()
    expect(storePinIcon(dir, 'data:text/plain,hello')).toBeNull()
  })
})
