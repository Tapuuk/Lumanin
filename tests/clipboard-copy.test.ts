import { describe, expect, it } from 'vitest'
import { createCopy, type ElectronTextClipboard } from '../src/main/clipboard-copy'
import type { ClipboardBackend } from '../src/platform/clipboard/index'

/**
 * The daemon's `Clipboard.copy` routing: concealed copies go to the platform
 * backend (which can mark the offer for clipboard managers), everything else
 * stays on the Electron path, and a failing helper never loses the copy.
 */

interface Recorded {
  electron: ElectronTextClipboard
  texts: string[]
  htmls: { text: string; html: string }[]
}

function fakeElectron(): Recorded {
  const texts: string[] = []
  const htmls: { text: string; html: string }[] = []
  return {
    electron: {
      writeText: (text) => texts.push(text),
      write: (data) => htmls.push(data)
    },
    texts,
    htmls
  }
}

function fakeBackend(fail = false): {
  backend: ClipboardBackend
  writes: { text: string; sensitive: boolean }[]
} {
  const writes: { text: string; sensitive: boolean }[] = []
  return {
    backend: {
      id: 'wl-clipboard',
      readText: () => Promise.resolve(''),
      writeText: (text, options) => {
        if (fail) return Promise.reject(new Error('wl-copy failed'))
        writes.push({ text, sensitive: options?.sensitive === true })
        return Promise.resolve()
      }
    },
    writes
  }
}

describe('concealed clipboard copies', () => {
  it('routes a concealed copy to the helper with the sensitive flag', async () => {
    const { electron, texts } = fakeElectron()
    const { backend, writes } = fakeBackend()
    const copy = createCopy({ electron, backend: () => Promise.resolve(backend) })

    await copy({ text: 'hunter2', concealed: true })

    expect(writes).toEqual([{ text: 'hunter2', sensitive: true }])
    expect(texts).toEqual([])
  })

  it('keeps a plain copy on the Electron path', async () => {
    const { electron, texts } = fakeElectron()
    const { backend, writes } = fakeBackend()
    const copy = createCopy({ electron, backend: () => Promise.resolve(backend) })

    await copy({ text: 'hello', concealed: false })

    expect(writes).toEqual([])
    expect(texts).toEqual(['hello'])
  })

  it('falls back to a plain copy when the helper fails', async () => {
    // A too-old wl-copy rejects --sensitive; the copy must still happen.
    const { electron, texts } = fakeElectron()
    const { backend } = fakeBackend(true)
    const copy = createCopy({ electron, backend: () => Promise.resolve(backend) })

    await copy({ text: 'hunter2', concealed: true })

    expect(texts).toEqual(['hunter2'])
  })

  it('falls back to a plain copy when no backend is available', async () => {
    const { electron, texts } = fakeElectron()
    const copy = createCopy({ electron, backend: () => Promise.resolve(undefined) })

    await copy({ text: 'hunter2', concealed: true })

    expect(texts).toEqual(['hunter2'])
  })

  it('never routes html through the helper', async () => {
    // wl-copy serves one payload; a concealed html copy stays on Electron.
    const { electron, htmls } = fakeElectron()
    const { backend, writes } = fakeBackend()
    const copy = createCopy({ electron, backend: () => Promise.resolve(backend) })

    await copy({ text: 'a', html: '<b>a</b>', concealed: true })

    expect(writes).toEqual([])
    expect(htmls).toEqual([{ text: 'a', html: '<b>a</b>' }])
  })

  it('copies a file path as text, concealed or not', async () => {
    const { electron, texts } = fakeElectron()
    const { backend, writes } = fakeBackend()
    const copy = createCopy({ electron, backend: () => Promise.resolve(backend) })

    await copy({ file: '/tmp/a', concealed: false })
    await copy({ file: '/tmp/b', concealed: true })

    expect(texts).toEqual(['/tmp/a'])
    expect(writes).toEqual([{ text: '/tmp/b', sensitive: true }])
  })
})
