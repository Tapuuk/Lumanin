import { closeSync, existsSync, mkdtempSync, openSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExtensionStore } from '../src/main/extensions/storage'
import { FrecencyStore } from '../src/node/frecency-store'

/**
 * Our databases are owner-only, and stay that way.
 *
 * The mode is not a formality here: `extensions.db` holds every plugin's
 * `LocalStorage` and every stored preference value, `password`-typed ones
 * included. It used to be created with the process umask — `0644` on a default
 * Arch install — inside a `0700` directory, so the directory was the only thing
 * keeping it private, and a file copied out of that directory (a tarball, an
 * rsync backup, a restored image) took its own permissive mode with it.
 *
 * The directory is deliberately created world-readable in these tests. A test
 * that made it `0700` would pass with the fix reverted.
 */

const stores: { close: () => void }[] = []

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close()
})

/** Just the permission bits, as a string, so a failure reads as `644`, not `33188`. */
function mode(file: string): string {
  return (statSync(file).mode & 0o777).toString(8)
}

function openDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'lumanin-db-mode-'))
}

describe('database file permissions', () => {
  it('creates the extension database owner-only', () => {
    const directory = openDirectory()
    const store = new ExtensionStore(directory)
    stores.push(store)

    // Something worth protecting, so this is not a test about an empty file.
    store.setPreference('some-plugin', 'search', 'token', 'ghp_notarealtoken')

    expect(mode(join(directory, 'extensions.db'))).toBe('600')
  })

  it('creates the frecency database owner-only', () => {
    const directory = openDirectory()
    const store = new FrecencyStore(directory)
    stores.push(store)

    expect(mode(join(directory, 'frecency.db'))).toBe('600')
  })

  it('restricts the write-ahead log and shared-memory files too', () => {
    const directory = openDirectory()
    const store = new ExtensionStore(directory)
    stores.push(store)
    store.set('some-plugin', 'key', 'value')

    // WAL mode writes the same data into sidecars. A `0600` database beside a
    // `0644` write-ahead log is not a private database.
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = join(directory, `extensions.db${suffix}`)
      if (existsSync(sidecar)) expect(mode(sidecar), suffix).toBe('600')
    }
  })

  it('repairs a database that was created before this rule', () => {
    // The upgrade path, and the reason the mode is applied on every open rather
    // than only at creation: an existing installation has a `0644` file already
    // sitting there, and nobody is going to chmod it by hand.
    const directory = openDirectory()
    const file = join(directory, 'extensions.db')
    closeSync(openSync(file, 'w', 0o644))
    writeFileSync(file, '')
    expect(mode(file)).toBe('644')

    stores.push(new ExtensionStore(directory))
    expect(mode(file)).toBe('600')
  })
})
