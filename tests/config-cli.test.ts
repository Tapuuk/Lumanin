import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  getValue,
  readConfigDocument,
  render,
  setValue,
  writeConfigDocument
} from '../src/node/config-file'
import { Keys, Menu, Screen, truncate, width, type Term } from '../src/cli/tui'
import { runConfigUi } from '../src/cli/config-ui'
import { parseArgs } from '../src/shared/protocol'

/**
 * `lumanin config`: the document it edits, and the menu it edits it with.
 *
 * The terminal parts are driven through fake streams rather than a real tty -
 * writing an arrow-key sequence into a pipe and asserting what came back is the whole test,
 * and it catches the things that actually broke here: keys arriving between
 * screens, and a cursor that reset every time you came back from a submenu.
 */

function tempFile(name = 'config.toml'): string {
  return join(mkdtempSync(join(tmpdir(), 'lumanin-config-')), name)
}

describe('the config document', () => {
  it('round-trips a file it does not fully understand', () => {
    // The config promise: a key for a feature not built yet must survive
    // being edited by a version that has never heard of it.
    const path = tempFile()
    writeFileSync(path, '[clipboard]\nretention_days = 14\n\n[general]\nwidth = 900\n')

    const document = readConfigDocument(path)
    const draft = structuredClone(document.data)
    setValue(draft, ['general', 'width'], 1000)
    writeConfigDocument(document, draft, 'stamp')

    const after = readFileSync(path, 'utf8')
    expect(after).toContain('retention_days = 14')
    expect(after).toContain('width = 1000')
  })

  it('keeps the previous version when it rewrites', () => {
    const path = tempFile()
    writeFileSync(path, '# hand-written\n[general]\nwidth = 900\n')

    const document = readConfigDocument(path)
    expect(document.commentLines).toBe(1)

    const draft = structuredClone(document.data)
    setValue(draft, ['general', 'width'], 1000)
    const result = writeConfigDocument(document, draft, 'stamp')

    expect(result.backup).not.toBeNull()
    expect(readFileSync(result.backup as string, 'utf8')).toContain('# hand-written')
  })

  it('stops calling a saved change unsaved', () => {
    // The defect this exists for, found driving the menu through a pty: the
    // document held the file as it was when the menu opened, so after a
    // successful save "Review changes" still said *unsaved* and quitting still
    // offered to save - with nothing left to write.
    const path = tempFile()
    const document = readConfigDocument(path)
    const draft = structuredClone(document.data)
    setValue(draft, ['general', 'width'], 1000)

    expect(writeConfigDocument(document, draft, 'one').changed).toBe(true)
    expect(render(draft)).toBe(document.original)
    // ...and a second save with nothing further changed is a no-op, rather than
    // rewriting the file and leaving another backup behind.
    expect(writeConfigDocument(document, draft, 'two').changed).toBe(false)
    expect(readdirSync(join(path, '..'))).toEqual(['config.toml'])
  })

  it('writes nothing when the file already says exactly this', () => {
    const path = tempFile()
    writeFileSync(path, render({ general: { width: 900 } }))

    const document = readConfigDocument(path)
    const result = writeConfigDocument(document, structuredClone(document.data), 'stamp')

    expect(result.changed).toBe(false)
    // No backup, no temp file left behind, nothing touched.
    expect(readdirSync(join(path, '..'))).toEqual(['config.toml'])
  })

  it('reports a file that does not parse instead of replacing it', () => {
    // Editing from an empty document would silently discard everything the file
    // says. That has to be the user's decision.
    const path = tempFile()
    writeFileSync(path, 'this is not = = toml\n')

    const document = readConfigDocument(path)
    expect(document.parseError).not.toBeNull()
    expect(document.data).toEqual({})
  })

  it('treats a missing file as an empty document, not an error', () => {
    const document = readConfigDocument(join(tmpdir(), 'lumanin-nope', 'config.toml'))
    expect(document.existed).toBe(false)
    expect(document.parseError).toBeNull()
  })

  it('renders an untouched empty document as an empty file', () => {
    // `stringify({})` returns "\n", and comparing that to a file that does not
    // exist made the menu open claiming unsaved changes every single time.
    expect(render({})).toBe('')
  })
})

describe('setValue', () => {
  it('deletes rather than writing a null, and prunes the empty table', () => {
    // A key that is absent takes the built-in default and keeps taking it as
    // that default improves. A key pinned to today's default is a decision the
    // user never made.
    const data: Record<string, unknown> = { general: { width: 900 } }
    setValue(data, ['general', 'width'], undefined)
    expect(data).toEqual({})
  })

  it('edits inside an array of tables', () => {
    // `[[search.rules]]`. Without this the array is replaced by a table on the
    // first edit to a rule, which quietly eats the rest of them.
    const data: Record<string, unknown> = {
      search: { rules: [{ match: 'a' }, { match: 'b', first: [] }] }
    }
    setValue(data, ['search', 'rules', '1', 'match'], 'B')
    setValue(data, ['search', 'rules', '0', 'first'], ['app:x.desktop'])

    expect(getValue(data, ['search', 'rules', '1', 'match'])).toBe('B')
    expect(getValue(data, ['search', 'rules', '0', 'first'])).toEqual(['app:x.desktop'])
    expect((getValue(data, ['search', 'rules']) as unknown[]).length).toBe(2)
  })

  it('creates the tables on the way down', () => {
    const data: Record<string, unknown> = {}
    setValue(data, ['search', 'engines'], ['google'])
    expect(data).toEqual({ search: { engines: ['google'] } })
  })
})

describe('the CLI verb', () => {
  it('accepts both spellings, because people try the flag first', () => {
    expect(parseArgs(['config']).clientCommand).toBe('config')
    expect(parseArgs(['--config']).clientCommand).toBe('config')
  })

  it('still puts help and version ahead of it', () => {
    expect(parseArgs(['--config', '--help']).help).toBe(true)
  })
})

describe('terminal text', () => {
  it('measures width without counting escape sequences', () => {
    expect(width('\u001b[1mabc\u001b[0m')).toBe(3)
  })

  it('truncates to the column count', () => {
    expect(truncate('abcdefgh', 4)).toContain('abc')
    expect(width(truncate('abcdefgh', 4))).toBeLessThanOrEqual(4)
  })

  it('leaves a short line alone', () => {
    expect(truncate('abc', 40)).toBe('abc')
  })
})

/** A menu wired to pipes: writes go in as keystrokes, frames come out as text. */
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
    term: { input: input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream },
    input,
    frames: () => written
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('the menu', () => {
  it('moves with the arrow keys and returns what Enter was on', async () => {
    const { term, input, frames } = fakeTerm()
    const menu = new Menu(term, new Screen(term), {})

    const pending = menu.list<string>({
      title: 'Pick one',
      choices: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' }
      ]
    })
    await settle()
    input.write('\u001b[B')
    await settle()
    input.write('\r')

    expect((await pending).value).toBe('b')
    expect(frames()).toContain('Alpha')
    menu.close()
  })

  it('comes back empty-handed on ←, and throws the flow away on Escape', async () => {
    // The pair, at the level it is implemented: ← is one step back and every
    // caller already knows what to do with a `null`; Esc unwinds instead, so a
    // half-finished multi-screen flow cannot be left half-applied.
    const { term, input } = fakeTerm()
    const menu = new Menu(term, new Screen(term), {})

    const back = menu.list<string>({ title: 'Pick', choices: [{ value: 'a', label: 'A' }] })
    await settle()
    input.write('\u001b[D')
    expect((await back).value).toBeNull()

    const abandoned = menu.list<string>({ title: 'Pick', choices: [{ value: 'a', label: 'A' }] })
    await settle()
    input.write('\u001b')
    await expect(abandoned).rejects.toThrow('abandoned')

    // …except where there is nothing behind the screen, which is the top menu.
    const top = menu.list<string>({
      title: 'Pick',
      escape: 'close',
      choices: [{ value: 'a', label: 'A' }]
    })
    await settle()
    input.write('\u001b')
    expect((await top).value).toBeNull()
    menu.close()
  })

  it('will not land on a separator', async () => {
    const { term, input } = fakeTerm()
    const menu = new Menu(term, new Screen(term), {})

    const pending = menu.list<string>({
      title: 'Pick',
      choices: [
        { value: 'a', label: 'A' },
        { value: '', label: '-', separator: true },
        { value: 'b', label: 'B' }
      ]
    })
    await settle()
    input.write('\u001b[B')
    await settle()
    input.write('\r')

    expect((await pending).value).toBe('b')
    menu.close()
  })

  it('keeps keys typed while no screen is listening', async () => {
    // The defect this exists for: subscribing per screen dropped everything
    // typed between two of them, so a scripted run - or anyone typing ahead -
    // lost every keystroke after the second menu.
    const { term, input } = fakeTerm()
    const menu = new Menu(term, new Screen(term), {})

    const first = menu.list<string>({ title: 'One', choices: [{ value: 'a', label: 'A' }] })
    await settle()
    input.write('\r')
    await first

    // Typed before the next screen exists.
    input.write('\u001b[B')
    await settle()

    const second = menu.list<string>({
      title: 'Two',
      choices: [
        { value: 'x', label: 'X' },
        { value: 'y', label: 'Y' }
      ]
    })
    await settle()
    input.write('\r')

    expect((await second).value).toBe('y')
    menu.close()
  })

  it('carries the highlight with a row that is being reordered', async () => {
    // The defect this exists for, reported from a real session: the reorder key
    // moved the row but left the highlight behind, so the row that took its
    // place was the one moved back down on the next press - two rows trading
    // places forever. Walking one row from the bottom to the top has to be N
    // presses, not N presses interleaved with letting go of the modifier.
    //
    // The chord is Ctrl+↑: nothing in this application asks for
    // Shift any more.
    const { term, input } = fakeTerm()
    const menu = new Menu(term, new Screen(term), {})

    let order = ['a', 'b', 'c']
    const pending = menu.list<string>({
      title: 'Order',
      initialIndex: 2,
      choices: () => order.map((value) => ({ value, label: value })),
      onKey: (key, value, _index, list) => {
        if (value === null || !key.ctrl || key.name !== 'up') return 'ignored'
        const at = order.indexOf(value)
        if (at <= 0) return 'handled'
        const moved = [...order]
        const [item] = moved.splice(at, 1)
        moved.splice(at - 1, 0, item as string)
        order = moved
        list.moveTo(at - 1)
        return 'handled'
      }
    })

    await settle()
    input.write('\u001b[1;5A')
    await settle()
    input.write('\u001b[1;5A')
    await settle()
    input.write('\r')

    // Two presses without releasing Ctrl moved `c` two rows, not one and back.
    expect(order).toEqual(['c', 'a', 'b'])
    expect((await pending).value).toBe('c')
    menu.close()
  })

  it('keeps the highlight on a row that jumps between groups', async () => {
    // The defect this exists for, found driving the real menu through a pty:
    // the engine picker lists the enabled ones above a separator, so toggling
    // one on moves it up, the highlight lands on the separator, gets clamped to
    // the top - and the next Space toggles the row you just enabled straight
    // back off. Enabling two engines in a row was impossible.
    const { term, input } = fakeTerm()
    const menu = new Menu(term, new Screen(term), {})

    let on: string[] = []
    const all = ['a', 'b', 'c']
    const pending = menu.list<string>({
      title: 'Engines',
      choices: () => [
        ...on.map((value) => ({ value, label: `[x] ${value}` })),
        { value: '', label: '', separator: true },
        ...all.filter((value) => !on.includes(value)).map((value) => ({ value, label: `[ ] ${value}` }))
      ],
      onKey: (key, value, _index, list) => {
        if (value === null || value === '' || key.name !== 'space') return 'ignored'
        on = on.includes(value) ? on.filter((entry) => entry !== value) : [...on, value]
        list.follow(value)
        return 'handled'
      }
    })

    await settle()
    input.write(' ')
    await settle()
    input.write('\u001b[B')
    await settle()
    input.write(' ')
    await settle()
    // ← rather than Esc: this screen edits in place and is left, not abandoned.
    input.write('\u001b[D')

    await pending
    expect(on).toEqual(['a', 'b'])
    menu.close()
  })

  it('refuses a value the setting cannot take, and says why', async () => {
    const { term, input, frames } = fakeTerm()
    const menu = new Menu(term, new Screen(term), {})

    const pending = menu.prompt({
      title: 'Panel width',
      validate: (value) => (Number(value) < 320 ? 'must be between 320 and 4096' : null)
    })
    await settle()
    for (const character of '10') {
      input.write(character)
      await settle()
    }
    input.write('\r')
    await settle()
    expect(frames()).toContain('must be between 320 and 4096')

    // …and accepts a corrected one rather than dropping what was typed.
    for (const character of '00') {
      input.write(character)
      await settle()
    }
    input.write('\r')

    expect(await pending).toBe('1000')
    menu.close()
  })
})

/**
 * The whole menu, driven end to end.
 *
 * `lumanin config` is mostly composition - screens calling screens - and the two
 * things that changed here are exactly that: Escape now unwinds one screen
 * rather than the whole flow, and the command picker starts with "type your own".
 * Neither is visible from a unit test of a single screen.
 */
/**
 * Escape has to be instant, and was not.
 *
 * `Escape` is the first byte of every arrow key, so the keypress decoder holds a
 * lone one back to see whether more of a sequence follows. Node waits **500 ms**
 * by default, which is what "esc is so laggy in the config" was: every Esc in
 * every menu sat there for half a second. Measured before the fix at 502 ms.
 *
 * Asserted against the wall clock rather than against the constant, because the
 * constant being right is not the claim - the claim is that the key arrives.
 */
describe('escape latency', () => {
  it('delivers a lone Escape in a fraction of Node’s default wait', async () => {
    const { term, input } = fakeTerm()
    const keys = new Keys(term, () => undefined)

    const started = Date.now()
    const pressed = keys.read((key) => (key.name === 'escape' ? 'done' : 'continue'))
    input.write('\u001b')
    await pressed
    keys.dispose()

    expect(Date.now() - started).toBeLessThan(250)
  })
})

describe('the config menu, end to end', () => {
  const ESC = '\u001b'
  /** One step back. Esc abandons the whole flow - see the tui tests above. */
  const LEFT = '\u001b[D'
  const DOWN = '\u001b[B'
  const ENTER = '\r'
  /** The plugin browser's "look inside this" verb; Enter is "choose this". */
  const RIGHT = '\u001b[C'

  const beat = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

  async function type(input: PassThrough, keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      input.write(key)
      await beat()
    }
  }

  function driver(): {
    term: Term
    input: PassThrough
    frames: () => string
    configFile: string
  } {
    const { term, input, frames } = fakeTerm()
    const configFile = tempFile()
    writeFileSync(configFile, '')
    return { term, input, frames, configFile }
  }

  function open(term: Term, configFile: string): Promise<number> {
    return runConfigUi({
      term,
      env: {},
      configFile,
      home: '/nonexistent',
      extensionsDir: '/nonexistent',
      bundledDir: '/nonexistent',
      dataDir: '/nonexistent',
      applyChanges: null,
      restartDaemon: null,
      planBind: null,
      applyBind: null,
      enumerateItems: null,
      readBinds: null
    })
  }

  /**
   * Press Escape until something shows up, then stop.
   *
   * A bare `\u001b` is also the first byte of every arrow key, so Node's keypress
   * decoder holds it back to see whether more of a sequence follows - which makes
   * "one Escape closes one screen" true of a terminal and not of a pipe. Pressing
   * until the expected screen appears tests the navigation rather than the
   * decoder's buffering.
   */
  /** Walk back one screen at a time with ←, which is what it now means. */
  async function escapeUntil(
    input: PassThrough,
    frames: () => string,
    expected: string
  ): Promise<void> {
    const from = frames().length
    for (let attempt = 0; attempt < 24; attempt += 1) {
      input.write(LEFT)
      await beat()
      if (frames().slice(from).includes(expected)) return
    }
    throw new Error(`never got back to ${JSON.stringify(expected)}`)
  }

  /** Leave the menu: Escape unwinds every screen, and at the root it quits. */
  async function leave(input: PassThrough, pending: Promise<number>): Promise<void> {
    let done = false
    void pending.then(() => {
      done = true
    })
    for (let attempt = 0; attempt < 20 && !done; attempt += 1) {
      input.write(ESC)
      await beat()
    }
    await pending
  }

  /** A profile with one plugin that declares a category, for the Plugins tab. */
  function pluginProfile(): string {
    const root = mkdtempSync(join(tmpdir(), 'lumanin-config-ext-'))
    const dir = join(root, 'demo')
    mkdirSync(join(dir, 'commands'), { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'demo',
        title: 'Demo',
        description: 'x',
        author: 'me',
        license: 'MIT',
        categories: ['Other'],
        commands: [
          {
            name: 'search',
            title: 'Search Demo',
            description: 'x',
            mode: 'view',
            lumanin: { categories: [{ id: 'logins', title: 'Logins' }] }
          }
        ]
      })
    )
    writeFileSync(join(dir, 'commands', 'search.js'), '')
    return root
  }

  function openWith(
    term: Term,
    configFile: string,
    extensionsDir: string,
    enumerateItems: Parameters<typeof runConfigUi>[0]['enumerateItems']
  ): Promise<number> {
    return runConfigUi({
      term,
      env: {},
      configFile,
      home: '/nonexistent',
      extensionsDir,
      bundledDir: '/nonexistent',
      dataDir: '/nonexistent',
      applyChanges: null,
      restartDaemon: null,
      planBind: null,
      applyBind: null,
      enumerateItems,
      readBinds: null
    })
  }

  it('drops a half-finished flow on Escape, and keeps a finished one', async () => {
    // The pair, end to end. Adding an alias is two questions - the word, then
    // what it points at - and Esc at the second one has to leave *nothing*
    // behind: the word was typed but the alias was never made. ← would have
    // gone back to the word instead, which is the other half of the pair.
    const { term, input, frames, configFile } = driver()
    const pending = openWith(term, configFile, pluginProfile(), null)
    await beat()

    // Aliases → add → type a word → Enter → the target picker → Esc.
    // General, Appearance, Global Search, File Search, then Aliases.
    await type(input, [DOWN, DOWN, DOWN, DOWN, ENTER, 'a'])
    for (const character of 'zz') input.write(character)
    await type(input, [ENTER])
    await beat()
    await type(input, [ESC])
    await beat()

    // Straight back to the top, with nothing written.
    expect(frames().slice(-2000)).toContain('Lumanin - configuration')
    expect(readFileSync(configFile, 'utf8')).not.toContain('zz')

    await leave(input, pending)
  })

  it('pins a plugin category, one menu per level, with Space', async () => {
    const { term, input, frames, configFile } = driver()
    const pending = openWith(term, configFile, pluginProfile(), null)
    await beat()

    // Search -> Pinned rows -> add -> Plugins (the fourth kind, a row of its own).
    await type(input, [DOWN, DOWN, ENTER, DOWN, DOWN, DOWN, ENTER, 'a', DOWN, DOWN, DOWN, ENTER])
    expect(frames()).toContain('Plugins')
    expect(frames()).toContain('Demo')

    // Plugin -> its commands, each with its categories under it. One screen, so
    // the command is pinnable here rather than inside a copy of itself.
    await type(input, [ENTER])
    expect(frames()).toContain('Search Demo')
    expect(frames()).toContain('Logins')
    expect(frames()).not.toContain('Open Search Demo')
    await type(input, [DOWN, ' '])

    // Back on the pin list the category reads as a name, not a key.
    await escapeUntil(input, frames, 'Pins')
    expect(frames()).toContain('Demo: Logins')
    expect(frames()).toContain('extension:demo/search#logins')

    await leave(input, pending)
  })

  it('pins the command itself from the same screen its categories are on', async () => {
    // The complaint this fixes: opening "Search Godot" listed "Open Search
    // Godot" above its categories, so the command appeared as one of the things
    // inside itself. It is pinned where you can see it beside the other
    // commands instead - Space pins it; Enter goes into it.
    const { term, input, frames, configFile } = driver()
    const pending = openWith(term, configFile, pluginProfile(), null)
    await beat()

    await type(input, [DOWN, DOWN, ENTER, DOWN, DOWN, DOWN, ENTER, 'a', DOWN, DOWN, DOWN, ENTER, ENTER])
    expect(frames()).toContain('Search Demo')
    expect(frames()).not.toContain('Open Search Demo')

    await type(input, [' '])
    await escapeUntil(input, frames, 'Pins')
    expect(frames()).toContain('extension:demo/search')

    await leave(input, pending)
  })

  it('pins a single item, running the plugin through enumerate, and saves it as a table', async () => {
    const { term, input, frames, configFile } = driver()
    const asked: unknown[] = []
    const pending = openWith(term, configFile, pluginProfile(), (command, category) => {
      asked.push([command, category])
      return Promise.resolve([
        { id: 'a1', title: 'GitHub', subtitle: 'login', actions: ['Copy Password'], icon: 'https://example.test/gh.png' }
      ])
    })
    await beat()

    await type(input, [
      DOWN, DOWN, ENTER, DOWN, DOWN, DOWN, ENTER, 'a',
      DOWN, DOWN, DOWN, ENTER,   // Plugins
      ENTER,                     // Demo - its commands and their categories
      DOWN, RIGHT                // → into the category, Logins
    ])
    expect(asked).toEqual([['demo/search', 'logins']])
    expect(frames()).toContain('GitHub')

    // The category is not a row here - it is the row → was pressed on - so the
    // first item is the first row. Space pins it; Escape backs out of the add.
    await type(input, [' '])
    await escapeUntil(input, frames, 'Pins')
    expect(frames()).toContain('GitHub')

    // Already written: the item pin lands in the file as an { id, title } table,
    // because the root list has to draw it without running the plugin.
    await leave(input, pending)

    const written = readFileSync(configFile, 'utf8')
    expect(written).toContain('extension:demo/search#logins:a1')
    expect(written).toContain('GitHub')
    // The row's own face travels with the pin, so the root can draw it.
    expect(written).toContain('icon = "https://example.test/gh.png"')
  })

  /**
   * File search has a section, because it is a search rather than a plugin.
   *
   * The key is the only way in - its command is not at the root - so it is a
   * setting next to the launcher's own hotkey rather than one of the
   * `[[hotkeys]]` a user writes.
   */
  it('has a File Search section holding its key and its order', async () => {
    const { term, input, frames, configFile } = driver()
    const pending = open(term, configFile)
    await beat()

    // General, Appearance, Search, then this.
    await type(input, [DOWN, DOWN, DOWN, ENTER])
    expect(frames()).toContain('File Search')
    expect(frames()).toContain('Super+Shift+R')
    expect(frames()).toContain('File type order')
    // Opening a file is the end of a file search; the panel gets out of the way.
    expect(frames()).toContain('Close the panel when a file opens')

    await leave(input, pending)
  })

  it('reorders the file categories with ctrl+↓ and writes the whole list', async () => {
    const { term, input, frames, configFile } = driver()
    const pending = open(term, configFile)
    await beat()

    await type(input, [DOWN, DOWN, DOWN, ENTER, DOWN, ENTER])
    expect(frames()).toContain('File type order')
    expect(frames()).toContain('Folders')

    // Folders down one: Images leads, and every category is still listed -
    // there is no "off" here, because every file is in exactly one of them.
    await type(input, ['\u001b[1;5B'])
    // Back to the menu, where the cursor is still on File Search, then down to
    // the config.toml view - which renders what the edit already wrote.
    await type(input, [LEFT, LEFT])
    await type(input, [DOWN, DOWN, DOWN, DOWN, ENTER])

    // Written whole, in the new order. (That the list is always *complete* is
    // the resolver's job and is tested there; the review screen truncates a long
    // line to the terminal's width, so only the head of it is legible here.)
    expect(frames()).toContain('order = [')
    expect(frames()).toContain('"images", "folders"')

    await leave(input, pending)
  })

  it('writes every finished edit at once, without a Save step', async () => {
    const { term, input, frames, configFile } = driver()
    const pending = open(term, configFile)
    await beat()

    await type(input, [RIGHT])
    expect(frames()).toContain('Hide when focus is lost')
    await type(input, [ENTER])

    // On disk before the menu is left, and the daemon would have been told.
    expect(readFileSync(configFile, 'utf8')).toContain('hide_on_blur = false')
    expect(frames()).not.toContain('Save')

    await leave(input, pending)
    expect(readFileSync(configFile, 'utf8')).toContain('hide_on_blur = false')
  })

  /** → is Enter: into the row you are on, as ← is out of the screen you are on. */
  it('opens a screen with the right arrow as well as with Enter', async () => {
    const { term, input, frames, configFile } = driver()
    const pending = open(term, configFile)
    await beat()

    await type(input, [RIGHT])
    expect(frames()).toContain('Hide when focus is lost')

    await type(input, [LEFT])
    expect(frames()).toContain('Show config.toml')

    await leave(input, pending)
  })

  it('has a Hotkeys section of its own', async () => {
    const { term, input, frames, configFile } = driver()
    const pending = open(term, configFile)
    await beat()

    // General, Appearance, Search, File Search, Aliases, Action keys, then this.
    await type(input, [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER])
    expect(frames()).toContain('Plugin hotkeys')
    expect(frames()).toContain('None yet')

    await leave(input, pending)
  })

  /**
   * The reported bug, as a test: remove a hotkey, decline (here: never make)
   * the compositor write, and the key is still bound. The screen has to keep
   * saying so instead of drawing the removal as done.
   */
  it('reports what the compositor really binds, not what the draft intends', async () => {
    const { term, input, frames, configFile } = driver()
    writeFileSync(
      configFile,
      '[[hotkeys]]\nbind = "Super+P"\ntarget = "app:firefox.desktop"\n'
    )

    const pending = runConfigUi({
      term,
      env: {},
      configFile,
      home: '/nonexistent',
      extensionsDir: '/nonexistent',
      bundledDir: '/nonexistent',
      dataDir: '/nonexistent',
      applyChanges: null,
      restartDaemon: null,
      planBind: null,
      applyBind: null,
      enumerateItems: null,
      // What `hyprland.conf` says. Never changes here - nothing writes it -
      // which is exactly the situation where the two used to disagree in
      // silence.
      readBinds: () => [
        {
          path: '/home/x/.config/hypr/hyprland.conf',
          keyText: 'SUPER, P',
          hotkey: { mods: ['super'], key: 'p' },
          target: 'app:firefox.desktop'
        }
      ]
    })
    await beat()

    await type(input, [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER])
    // In both files: bound.
    expect(frames()).toContain('Super+P')
    expect(frames()).toContain('✔')

    // Remove it. The config no longer names it - and the key still works, so
    // the row moves to "still bound" rather than disappearing.
    await type(input, ['d'])
    expect(frames()).toContain('still bound')
    expect(frames()).toContain('hyprland.conf')

    await leave(input, pending)
  })

  /**
   * The follow-on bug, reported as "stuff doesn't delete when I press d".
   *
   * Removing the last entry leaves the cursor on the stale row directly beneath
   * it - there is nowhere else for it to go - and `d` there used to be silently
   * ignored, on a screen whose footer offers `d remove`. It is not a second
   * removal: what is left is the compositor's copy, and only the file write
   * clears that. So the key runs the write rather than nothing.
   */
  it('offers the window-rule diff when the panel height changes', async () => {
    // `[general].top` lives in the compositor's rule where there is one, so
    // picking a new value plans the same managed-block write the hotkey gets,
    // carrying the fraction, and asks about the panel rather than about a key.
    const { term, input, frames, configFile } = driver()
    const planned: (number | undefined)[] = []
    const pending = runConfigUi({
      term,
      env: {},
      configFile,
      home: '/nonexistent',
      extensionsDir: '/nonexistent',
      bundledDir: '/nonexistent',
      dataDir: '/nonexistent',
      applyChanges: null,
      restartDaemon: null,
      planBind: (choice) => {
        planned.push(choice.panelTop)
        return {
          edits: [
            {
              path: '/home/x/.config/hypr/lumanin.lua',
              state: 'will-update',
              before: 'monitor_h*0.24',
              after: 'monitor_h*0.45',
              diff: '-  move = { "(monitor_w-window_w)/2", "monitor_h*0.24" },\n+  move = { "(monitor_w-window_w)/2", "monitor_h*0.45" },',
              actions: [
                {
                  id: 'hyprland-lua-rules',
                  title: 'rules',
                  why: 'why',
                  file: 'hypr/lumanin.lua',
                  signature: /window_rule/,
                  body: [],
                  applicable: () => true
                }
              ]
            }
          ],
          commands: [],
          notes: []
        }
      },
      applyBind: (plan) =>
        Promise.resolve(plan.edits.map((edit) => ({ path: edit.path, ok: true, detail: 'written' }))),
      enumerateItems: null,
      readBinds: () => []
    })
    await beat()

    // General, then the rows: hide on blur, Esc, monitor, width, length, height.
    await type(input, [ENTER, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER])
    expect(frames()).toContain('Panel height')
    // Use the default, then Top, Default, Centre.
    await type(input, [DOWN, DOWN, DOWN, ENTER])
    expect(frames()).toContain('Move the panel in this desktop\u2019s window rule?')
    expect(frames()).toContain('monitor_h*0.45')
    expect(planned).toEqual([0.45])

    await leave(input, pending)
  })

  it('takes remove on an already-removed row as "clear the bind too"', async () => {
    const { term, input, frames, configFile } = driver()
    writeFileSync(configFile, '[[hotkeys]]\nbind = "Super+P"\ntarget = "app:firefox.desktop"\n')

    const planned: unknown[] = []
    const pending = runConfigUi({
      term,
      env: {},
      configFile,
      home: '/nonexistent',
      extensionsDir: '/nonexistent',
      bundledDir: '/nonexistent',
      dataDir: '/nonexistent',
      applyChanges: null,
      restartDaemon: null,
      planBind: (choice) => {
        planned.push((choice.extraBinds ?? []).map((bind) => bind.target))
        return {
          edits: [
            {
              path: '/home/x/.config/hypr/bindings.conf',
              state: 'will-update',
              before: 'bindd = SUPER, P, Firefox, exec, lumanin open …\n',
              after: '',
              diff: '- bindd = SUPER, P, …',
              actions: [
                {
                  id: 'hyprland-bind',
                  title: 'bind',
                  why: 'why',
                  file: 'hypr/bindings.conf',
                  signature: /bindd/,
                  body: [],
                  applicable: () => true
                }
              ]
            }
          ],
          commands: [],
          notes: ['Hyprland and Sway reload their config on save; no restart needed.']
        }
      },
      applyBind: (plan) =>
        Promise.resolve(plan.edits.map((edit) => ({ path: edit.path, ok: true, detail: 'written' }))),
      enumerateItems: null,
      readBinds: () => [
        {
          path: '/home/x/.config/hypr/bindings.conf',
          keyText: 'SUPER, P',
          hotkey: { mods: ['super'], key: 'p' },
          target: 'app:firefox.desktop'
        }
      ]
    })
    await beat()

    await type(input, [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER, 'd'])
    // The cursor is now on the stale row - it is the only selectable one left.
    expect(frames()).toContain('❯ ✘ Super+P')

    await type(input, ['d'])
    // …and the second press asks to write the file, rather than doing nothing.
    // Titled for what it is: the block is being made to match the list, so it
    // must not be announced as binding the *main* hotkey, which nobody touched.
    expect(frames()).toContain('Update this desktop\u2019s shortcuts?')
    expect(frames()).not.toContain('Bind Super+K in your compositor config?')
    // Planned from the draft, which no longer names Super+P.
    expect(planned).toEqual([[]])

    await leave(input, pending)
  })

  it('offers "type your own command" first, and writes it as a shell pin', async () => {
    const { term, input, frames, configFile } = driver()
    const pending = open(term, configFile)
    await beat()

    // Global Search -> Pinned rows -> add -> a command -> type your own.
    await type(input, [DOWN, DOWN, ENTER, DOWN, DOWN, DOWN, ENTER, 'a', DOWN, ENTER])
    expect(frames()).toContain('Type your own command')

    await type(input, [ENTER, 'systemctl suspend', ENTER])
    // The pin list shows the command line itself - there is nothing else to call
    // it, and a friendly name over a shell command is how you run the wrong one.
    expect(frames()).toContain('shell:systemctl suspend')

    await leave(input, pending)
  })

  it('takes Escape as one step back, not as cancelling the whole flow', async () => {
    const { term, input, frames, configFile } = driver()
    const pending = open(term, configFile)
    await beat()

    // Global Search → Pinned rows → add.
    await type(input, [DOWN, DOWN, ENTER, DOWN, DOWN, DOWN, ENTER, 'a'])
    expect(frames()).toContain('What do you want to add?')

    // Into the command list, then back out of it: the *kind* question returns,
    // rather than the whole "add" being abandoned back to the pin list.
    await type(input, [DOWN, ENTER])
    expect(frames()).toContain('Which command?')

    await escapeUntil(input, frames, 'What do you want to add?')

    await leave(input, pending)
  })
})
