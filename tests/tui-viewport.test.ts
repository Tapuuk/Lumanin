import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Menu, Screen, type Term } from '../src/cli/tui'

/**
 * The list holds still. Moving the highlight must not recentre the window,
 * a help line must not push the rows under it around, and a frame must never
 * be taller than the terminal — a frame that is cannot be redrawn in place
 * and leaves its top behind on every keypress.
 */

const ESC = '\u001b'
const DOWN = `${ESC}[B`

function fakeTerm(rows: number): { term: Term; input: PassThrough; frames: () => string[] } {
  const input = new PassThrough()
  let written = ''
  const output = new Writable({
    write(chunk, _encoding, callback) {
      written += String(chunk)
      callback()
    }
  })
  const term = {
    input: input as unknown as NodeJS.ReadStream,
    output: Object.assign(output, { columns: 80, rows }) as unknown as NodeJS.WriteStream
  }
  // Frames are separated by the cursor-up-and-erase sequence; the first has none.
  const frames = (): string[] =>
    written
      .split(new RegExp(`\r(?:${ESC}\\[\\d+A)?${ESC}\\[0J`))
      .filter((frame) => frame.includes('Many'))
      .map((frame) => frame.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'), ''))
  return { term, input, frames }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const lineOf = (frame: string, text: string): number =>
  frame.split('\n').findIndex((line) => line.includes(text))

describe('the list viewport', () => {
  it('keeps every frame shorter than the terminal and only scrolls when the highlight leaves the window', async () => {
    const { term, input, frames } = fakeTerm(16)
    const menu = new Menu(term, new Screen(term), {})
    const choices = Array.from({ length: 40 }, (_, index) => ({
      value: index,
      label: `Row ${String(index)}`,
      ...(index % 3 === 0 ? { help: `About row ${String(index)}` } : {})
    }))
    const pending = menu.list<number>({ title: 'Many', choices })
    await settle()
    for (let press = 0; press < 5; press += 1) {
      input.write(DOWN)
      await settle()
    }
    input.write('\r')
    expect((await pending).value).toBe(5)
    menu.close()

    const drawn = frames()
    expect(drawn.length).toBe(6)
    for (const frame of drawn) {
      expect(frame.split('\n').length).toBeLessThanOrEqual(16)
    }
    // Five presses inside a window that holds more than five rows: the first
    // row on screen is Row 0 in every frame.
    for (const frame of drawn) expect(frame).toContain('Row 0')
    // The rows under the highlight sit on the same line whether or not the
    // highlighted row has help.
    const first = drawn[0] ?? ''
    for (const frame of drawn) expect(lineOf(frame, 'Row 6')).toBe(lineOf(first, 'Row 6'))
  })

  it('scrolls by one row at a time once the highlight reaches the bottom', async () => {
    const { term, input, frames } = fakeTerm(16)
    const menu = new Menu(term, new Screen(term), {})
    const choices = Array.from({ length: 40 }, (_, index) => ({ value: index, label: `Row ${String(index)}` }))
    const pending = menu.list<number>({ title: 'Many', choices })
    await settle()
    for (let press = 0; press < 12; press += 1) {
      input.write(DOWN)
      await settle()
    }
    input.write('\r')
    expect((await pending).value).toBe(12)
    menu.close()

    const last = frames().at(-1) ?? ''
    expect(last).toContain('Row 12')
    expect(last).toMatch(/↑ \d+ above · ↓ \d+ below/)
    expect(last.split('\n').length).toBeLessThanOrEqual(16)
  })
})
