import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Cache, flushCaches } from '../src/api-shim/system'

/**
 * `Cache` is what a plugin's warm first paint is made of, and the two things
 * that can go wrong with it are invisible from inside a single instance: a
 * second view of the same file overwriting the first one's entries, and a write
 * that never reaches the disk. Every case below is one of those two.
 *
 * A fresh directory per case is what keeps them apart — the stores are keyed by
 * directory and namespace, so a new directory is a new store with nothing
 * carried over.
 */

const root = mkdtempSync(join(tmpdir(), 'lumanin-cache-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
const freshDirectory = (): string => join(root, `case-${counter++}`)

const onDisk = (directory: string, namespace = 'shared'): Record<string, string> => {
  const file = join(directory, `${encodeURIComponent(namespace)}.json`)
  if (!existsSync(file)) return {}
  return (JSON.parse(readFileSync(file, 'utf8')) as { entries: Record<string, string> }).entries
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('Cache', () => {
  it('gives two instances over one file the same entries', () => {
    const directory = freshDirectory()
    const first = new Cache({ directory, namespace: 'shared' })
    const second = new Cache({ directory, namespace: 'shared' })

    first.set('a', '1')
    second.set('b', '2')

    expect(second.get('a')).toBe('1')
    expect(first.get('b')).toBe('2')

    flushCaches()
    expect(onDisk(directory)).toEqual({ a: '1', b: '2' })
  })

  it('keeps namespaces and directories apart', () => {
    const directory = freshDirectory()
    const other = freshDirectory()

    const one = new Cache({ directory, namespace: 'shared' })
    const byNamespace = new Cache({ directory, namespace: 'other' })
    const byDirectory = new Cache({ directory: other, namespace: 'shared' })

    one.set('a', '1', 0)

    expect(byNamespace.get('a')).toBeUndefined()
    expect(byDirectory.get('a')).toBeUndefined()
  })

  it('gives two spellings of one directory the same store', () => {
    const directory = freshDirectory()
    const plain = new Cache({ directory, namespace: 'shared' })
    const trailing = new Cache({ directory: `${directory}/`, namespace: 'shared' })
    const roundabout = new Cache({ directory: `${directory}/inner/..`, namespace: 'shared' })

    plain.set('a', '1', 0)

    expect(trailing.get('a')).toBe('1')
    expect(roundabout.get('a')).toBe('1')
    expect(Object.keys(onDisk(directory))).toEqual(['a'])
    // The reported directory is still whatever the caller passed in.
    expect(trailing.storageDirectory).toBe(`${directory}/`)
  })

  it('leaves the file alone until the write is flushed', () => {
    const directory = freshDirectory()
    const cache = new Cache({ directory, namespace: 'shared' })

    cache.set('a', '1')
    expect(onDisk(directory)).toEqual({})

    flushCaches()
    expect(onDisk(directory)).toEqual({ a: '1' })
  })

  it('writes on its own once the delay passes', async () => {
    const directory = freshDirectory()
    const cache = new Cache({ directory, namespace: 'shared' })

    cache.set('a', '1', 20)
    await sleep(80)

    expect(onDisk(directory)).toEqual({ a: '1' })
  })

  it('writes straight away when asked for no delay', () => {
    const directory = freshDirectory()
    const cache = new Cache({ directory, namespace: 'shared' })

    cache.set('a', '1', 0)

    expect(onDisk(directory)).toEqual({ a: '1' })
  })

  it('lands deletions without waiting for a flush', () => {
    const directory = freshDirectory()
    const cache = new Cache({ directory, namespace: 'shared' })

    cache.set('a', '1', 0)
    cache.set('b', '2')
    expect(cache.remove('a')).toBe(true)
    expect(onDisk(directory)).toEqual({ b: '2' })

    cache.set('c', '3')
    cache.clear()
    expect(onDisk(directory)).toEqual({})
    expect(cache.isEmpty).toBe(true)
  })

  it('drops the oldest entry once capacity is passed', () => {
    const directory = freshDirectory()
    const cache = new Cache({ directory, namespace: 'shared', capacity: 8 })

    cache.set('a', 'aaaaa', 0)
    cache.set('b', 'bbbbb', 0)

    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe('bbbbb')
  })

  it('tells the instance that wrote, and only that one', () => {
    const directory = freshDirectory()
    const writer = new Cache({ directory, namespace: 'shared' })
    const sibling = new Cache({ directory, namespace: 'shared' })

    const heard: string[] = []
    const siblingHeard: string[] = []
    writer.subscribe((key) => heard.push(key ?? ''))
    sibling.subscribe((key) => siblingHeard.push(key ?? ''))

    writer.set('a', '1', 0)

    expect(heard).toEqual(['a'])
    expect(siblingHeard).toEqual([])
  })

  it('reads a damaged file as an empty cache', () => {
    const directory = freshDirectory()
    new Cache({ directory, namespace: 'shared' }).set('a', '1', 0)
    writeFileSync(join(directory, 'broken.json'), '{ not json')

    const cache = new Cache({ directory, namespace: 'broken' })

    expect(cache.isEmpty).toBe(true)
    expect(cache.get('a')).toBeUndefined()
  })
})
