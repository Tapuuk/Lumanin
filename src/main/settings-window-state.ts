import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the settings window was last left: its size, and its position for the
 * platforms that let a window place itself. Kept in the state dir, one JSON
 * file, read once at startup and written when the window moves or closes.
 *
 * Pure: no electron import, so the validation and the file I/O are testable
 * from a plain Node process. The window half (clamping to a display, telling a
 * user resize from a compositor's) lives in `settings-window.ts`.
 */

export const SETTINGS_WINDOW_STATE_BASENAME = 'settings-window.json'

/** Chromium DIPs, same units the window is created with. */
export interface WindowBounds {
  readonly width: number
  readonly height: number
  readonly x: number
  readonly y: number
}

export const SETTINGS_WINDOW_MIN_WIDTH = 480
export const SETTINGS_WINDOW_MIN_HEIGHT = 360

const FIELDS = ['width', 'height', 'x', 'y'] as const

function stateFile(stateDir: string): string {
  return join(stateDir, SETTINGS_WINDOW_STATE_BASENAME)
}

/**
 * The saved bounds, or `null` when there are none worth trusting: a file that
 * is missing, does not parse, lacks a field, holds a non-integer, or asks for a
 * window smaller than the minimum is the same as no file at all.
 */
export function loadWindowBounds(stateDir: string): WindowBounds | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(stateFile(stateDir), 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  for (const field of FIELDS) {
    const value = record[field]
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null
  }
  const bounds = {
    width: record.width as number,
    height: record.height as number,
    x: record.x as number,
    y: record.y as number
  }
  if (bounds.width < SETTINGS_WINDOW_MIN_WIDTH || bounds.height < SETTINGS_WINDOW_MIN_HEIGHT) return null
  return bounds
}

/** Atomic (tmp + rename), owner-only; creates the state dir when needed. */
export function saveWindowBounds(stateDir: string, bounds: WindowBounds): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = stateFile(stateDir)
  const temporary = `${file}.tmp-${String(process.pid)}`
  const record: WindowBounds = { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y }
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
}
