import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runPluginsUi } from '../src/cli/plugins'
import type { Term } from '../src/cli/tui'

/**
 * `lumanin plugins`, driven through fake streams.
 *
 * The same technique as `config-cli.test.ts` and for the same reason: writing an
 * arrow-key sequence into a pipe and asserting what came back tests the screen
 * that ships, rather than a rearrangement of its internals. Remove is not
 * exercised here — it deletes things; `scripts/verify-plugins.mjs` covers the
 * install-and-run path against the real window, which is the only place it
 * means anything.
 */

const ESC = '\u001b'
const DOWN = '\u001b[B'
const ENTER = '\r'

function fakeTerm(): { term: Term; input: PassThrough; frames: () => string } {
  const input = new PassThrough()
  let written = ''
  const output = new Writable({
    write(chunk, _encoding, callback) {
      written += String(chunk)
      callback()
    }
  })

  return {
    term: {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream
    },
    input,
    frames: () => written
  }
}

/**
 * A real tick, not `setImmediate`.
 *
 * The menu writes `config.toml` between screens, so a step here is a menu
 * resolving, a synchronous file write, and the next menu drawing — more than one
 * microtask queue drain. With `setImmediate` the later keypresses arrived while
 * the screen they were meant for did not exist yet, and the flow simply stopped.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

/** A profile with one plugin installed, the way `plugin-install` leaves one. */
function profile(): {
  configFile: string
  extensionsDir: string
  bundledDir: string
  dataDir: string
} {
  const root = mkdtempSync(join(tmpdir(), 'lumanin-store-'))
  const extensionsDir = join(root, 'extensions')
  mkdirSync(join(extensionsDir, 'demo', 'commands'), { recursive: true })
  writeFileSync(
    join(extensionsDir, 'demo', 'package.json'),
    JSON.stringify({
      name: 'demo',
      title: 'Demo',
      description: 'A fixture',
      author: 'lumanin',
      license: 'MIT',
      categories: ['Other'],
      commands: [
        { name: 'one', title: 'Command One', description: 'first', mode: 'view' },
        { name: 'two', title: 'Command Two', description: 'second', mode: 'view' }
      ]
    })
  )
  writeFileSync(join(extensionsDir, 'demo', 'commands', 'one.js'), '')
  writeFileSync(join(extensionsDir, 'demo', 'commands', 'two.js'), '')

  const configFile = join(root, 'config.toml')
  writeFileSync(configFile, '')
  return { configFile, extensionsDir, bundledDir: join(root, 'bundled'), dataDir: root }
}

function start(term: Term, paths: ReturnType<typeof profile>): Promise<number> {
  return runPluginsUi({ term, env: {}, ...paths, cacheDir: join(paths.dataDir, 'cache'), reload: null })
}

/** Type each of these, letting the screen settle between them. */
async function press(input: PassThrough, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    input.write(key)
    await settle()
  }
}

/**
 * Back out until the screen is gone, and say how many it took.
 *
 * Not a fixed number of Escapes. A bare `\u001b` is also the first byte of every
 * arrow key, so Node's keypress decoder holds it back to see whether more of a
 * sequence follows — which makes "one Escape closes one screen" true of a real
 * terminal and not of a pipe. Pressing until the thing under test actually
 * finished tests the screen rather than the decoder's buffering.
 */
async function quit(input: PassThrough, pending: Promise<number>): Promise<number> {
  let done: number | null = null
  void pending.then((code) => {
    done = code
  })
  for (let attempt = 0; attempt < 8 && done === null; attempt += 1) {
    input.write(ESC)
    await settle()
  }
  return await pending
}

describe('the plugins screen', () => {
  it('lists what is installed, and nothing else', async () => {
    const { term, input, frames } = fakeTerm()
    const paths = profile()
    const pending = start(term, paths)

    await settle()
    await press(input, ['Demo'])
    await quit(input, pending)

    const drawn = frames()
    expect(drawn).toContain('Demo')
    expect(drawn).toContain('1 installed')
  })

  it('draws the list for an empty profile too — the store row is still there', async () => {
    const { term, input, frames } = fakeTerm()
    const paths = profile()
    const root = mkdtempSync(join(tmpdir(), 'lumanin-store-empty-'))
    mkdirSync(root, { recursive: true })

    const pending = start(term, { ...paths, extensionsDir: join(root, 'none') })
    await settle()
    await quit(input, pending)

    expect(frames()).toContain('No plugins installed')
    expect(frames()).toContain('Official plugins')
  })

  it('always offers the Official plugins row alongside the installed plugins', async () => {
    const { term, input, frames } = fakeTerm()
    const paths = profile()
    const pending = start(term, paths)

    await settle()
    await quit(input, pending)

    expect(frames()).toContain('Official plugins')
    expect(frames()).toContain('official collection')
  })

  it('disables an extension by writing config.toml, not by deleting it', async () => {
    const { term, input } = fakeTerm()
    const paths = profile()
    const pending = start(term, paths)

    await settle()
    // The entry screen opens with the highlight on `Enabled`, so a second Enter
    // is the toggle. `Remove` lives at the bottom, below a rule, on purpose.
    await press(input, ['Demo', ENTER, ENTER])
    await quit(input, pending)

    const written = readFileSync(paths.configFile, 'utf8')
    expect(written).toContain('disabled')
    expect(written).toContain('demo')
    // Still installed. That is the whole distinction this screen exists to make.
    expect(readFileSync(join(paths.extensionsDir, 'demo', 'package.json'), 'utf8')).toContain('Demo')
  })

  it('turns a single command off and leaves the other on', async () => {
    const { term, input, frames } = fakeTerm()
    const paths = profile()
    const pending = start(term, paths)

    await settle()
    await press(input, ['Demo', ENTER, DOWN, ENTER])
    expect(frames()).toContain('Command One')

    await press(input, [' '])
    await quit(input, pending)

    const written = readFileSync(paths.configFile, 'utf8')
    expect(written).toContain('demo/one')
    expect(written).not.toContain('demo/two')
  })

  it('refuses to run at all against a config file it cannot parse', async () => {
    const { term, frames } = fakeTerm()
    const paths = profile()
    writeFileSync(paths.configFile, 'this is [not toml\n')

    // Nothing is written from a document we could not read, because rewriting
    // from an empty one would silently discard whatever the file said.
    expect(await start(term, paths)).toBe(1)
    expect(frames()).toContain('does not parse')
    expect(readFileSync(paths.configFile, 'utf8')).toBe('this is [not toml\n')
  })
})

describe('the alias row', () => {
  it('writes an [aliases] entry pointing at one of the plugin commands', async () => {
    const { term, input } = fakeTerm()
    const paths = profile()
    const pending = start(term, paths)

    await settle()
    // Open Demo; Enabled, Commands, Preferences, Alias — three DOWNs.
    await press(input, ['Demo', ENTER, DOWN, DOWN, DOWN, ENTER])
    // Add: two commands, so a picker appears — take the first — then the word.
    await press(input, ['a', ENTER])
    await press(input, ['d', 'm', ENTER])

    const written = readFileSync(paths.configFile, 'utf8')
    expect(written).toContain('[aliases]')
    expect(written).toContain('dm = "demo/one"')

    await quit(input, pending)
  })
})
