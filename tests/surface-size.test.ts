import { describe, expect, it } from 'vitest'
import { surfaceSize } from '../src/shared/surface-size'

describe('surfaceSize', () => {
  it('leaves the last CSS pixel of the surface empty', () => {
    expect(surfaceSize(1307, 1308, 1)).toBe(1306)
    expect(surfaceSize(760, 761, 1)).toBe(759)
  })

  it('divides the window size by the zoom before flooring', () => {
    expect(surfaceSize(1307, 1308, 1.1875)).toBe(1099)
    expect(surfaceSize(570, 571, 1.1875)).toBe(479)
  })

  it('falls back to the viewport when the window reports 0', () => {
    expect(surfaceSize(0, 500, 1)).toBe(499)
  })

  it('never goes below one pixel and ignores a bad zoom', () => {
    expect(surfaceSize(1, 1, 1)).toBe(1)
    expect(surfaceSize(0, 0, 1)).toBe(1)
    expect(surfaceSize(100, 100, Number.NaN)).toBe(99)
    expect(surfaceSize(100, 100, 0)).toBe(99)
  })
})
