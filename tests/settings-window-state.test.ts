import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadWindowBounds,
  saveWindowBounds,
  SETTINGS_WINDOW_STATE_BASENAME,
  type WindowBounds
} from '../src/main/settings-window-state'
import { resolvePaths } from '../src/node/paths'

/**
 * The settings window's remembered size and position: a JSON file in the state
 * dir that is trusted only when every field is a sane integer.
 */

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'lumanin-window-state-'))
  return resolvePaths({ HOME: root, XDG_STATE_HOME: join(root, 'state') }).state
}

const bounds: WindowBounds = { width: 900, height: 600, x: 40, y: 60 }

describe('window bounds', () => {
  it('round-trips through the state file', () => {
    const dir = stateDir()
    expect(loadWindowBounds(dir)).toBeNull()
    saveWindowBounds(dir, bounds)
    expect(loadWindowBounds(dir)).toEqual(bounds)
  })

  it('creates a missing state dir and writes an owner-only file, atomically', () => {
    const dir = stateDir()
    saveWindowBounds(dir, bounds)
    const file = join(dir, SETTINGS_WINDOW_STATE_BASENAME)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual([SETTINGS_WINDOW_STATE_BASENAME])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(bounds)
  })

  it('overwrites an earlier save', () => {
    const dir = stateDir()
    saveWindowBounds(dir, bounds)
    saveWindowBounds(dir, { ...bounds, width: 1000 })
    expect(loadWindowBounds(dir)?.width).toBe(1000)
  })

  it('returns null for garbage, a missing field, a float, or a negative or too-small size', () => {
    const cases: readonly string[] = [
      'not json',
      '[]',
      'null',
      JSON.stringify({ width: 900, height: 600, x: 40 }),
      JSON.stringify({ ...bounds, width: 900.5 }),
      JSON.stringify({ ...bounds, height: '600' }),
      JSON.stringify({ ...bounds, width: -900 }),
      JSON.stringify({ ...bounds, width: 200 }),
      JSON.stringify({ ...bounds, height: 100 })
    ]
    for (const contents of cases) {
      const dir = stateDir()
      saveWindowBounds(dir, bounds)
      writeFileSync(join(dir, SETTINGS_WINDOW_STATE_BASENAME), contents)
      expect(loadWindowBounds(dir), contents).toBeNull()
    }
  })

  it('accepts a negative position: a second monitor can sit left of the first', () => {
    const dir = stateDir()
    saveWindowBounds(dir, { ...bounds, x: -1920 })
    expect(loadWindowBounds(dir)?.x).toBe(-1920)
  })
})
