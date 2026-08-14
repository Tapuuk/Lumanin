import { describe, expect, it } from 'vitest'
import { parseManifest } from '../src/shared/extension'

/**
 * The manifest parser.
 *
 * The governing rule is in the module's own comment and every test here is an
 * instance of it: **unknown fields are preserved, never rejected**. The manifest
 * belongs to a third party and gains fields on Raycast's schedule, and refusing
 * to load an extension over a field we have not heard of is the one failure mode
 * a user cannot work around.
 */

const MINIMAL = {
  name: 'thing',
  title: 'Thing',
  commands: [{ name: 'run', title: 'Run Thing', mode: 'view' }]
}

describe('parseManifest', () => {
  it('reads a minimal manifest', () => {
    const { manifest, problems } = parseManifest(MINIMAL)
    expect(problems).toEqual([])
    expect(manifest?.name).toBe('thing')
    expect(manifest?.commands).toHaveLength(1)
    expect(manifest?.commands[0]).toMatchObject({ name: 'run', mode: 'view' })
  })

  it('refuses a manifest with no name or no usable command', () => {
    expect(parseManifest({ commands: [] }).manifest).toBeNull()
    expect(parseManifest({ name: 'x', commands: [] }).manifest).toBeNull()
    expect(parseManifest('not an object').manifest).toBeNull()
  })

  it('keeps the other commands when one is unusable', () => {
    const { manifest, problems } = parseManifest({
      ...MINIMAL,
      commands: [
        { name: 'good', title: 'Good', mode: 'view' },
        { name: 'bad', title: 'Bad', mode: 'telepathy' },
        { name: 'alsogood', title: 'Also Good', mode: 'no-view' }
      ]
    })
    expect(manifest?.commands.map((command) => command.name)).toEqual(['good', 'alsogood'])
    expect(problems.join(' ')).toContain('telepathy')
  })

  it('ignores a command that is disabled by default only at the registry, not here', () => {
    const { manifest } = parseManifest({
      ...MINIMAL,
      commands: [{ name: 'run', title: 'Run', mode: 'view', disabledByDefault: true }]
    })
    // Parsed and kept: whether to *offer* it is the registry's decision, and a
    // parser that dropped it would make `disabledByDefault` mean "deleted".
    expect(manifest?.commands[0]?.disabledByDefault).toBe(true)
  })

  /**
   * `platforms` can never contain `"Linux"` — the field's only legal values are
   * `"macOS"` and `"Windows"`. RAYCAST-COMPAT §"Signal 1" is explicit that this
   * must not be read as incompatibility, so the parser records it and judges
   * nothing.
   */
  it('records `platforms` without judging it', () => {
    const { manifest, problems } = parseManifest({ ...MINIMAL, platforms: ['macOS'] })
    expect(manifest?.platforms).toEqual(['macOS'])
    expect(problems).toEqual([])
  })

  it('forwards `external`, which esbuild needs and ignoring breaks native deps', () => {
    const { manifest } = parseManifest({ ...MINIMAL, external: ['sqlite3', 'sharp'] })
    expect(manifest?.external).toEqual(['sqlite3', 'sharp'])
  })

  it('parses preferences, including dropdown choices', () => {
    const { manifest } = parseManifest({
      ...MINIMAL,
      preferences: [
        { name: 'token', type: 'password', title: 'API Token', required: true },
        {
          name: 'sort',
          type: 'dropdown',
          title: 'Sort',
          default: 'new',
          data: [
            { title: 'Newest', value: 'new' },
            { title: 'Top', value: 'top' }
          ]
        }
      ]
    })

    expect(manifest?.preferences).toHaveLength(2)
    expect(manifest?.preferences[0]).toMatchObject({ name: 'token', type: 'password', required: true })
    expect(manifest?.preferences[1]?.data).toEqual([
      { title: 'Newest', value: 'new' },
      { title: 'Top', value: 'top' }
    ])
  })

  it('drops a preference whose type is not one of the seven, and says which', () => {
    const { manifest, problems } = parseManifest({
      ...MINIMAL,
      preferences: [{ name: 'weird', type: 'colorwheel' }]
    })
    expect(manifest?.preferences).toEqual([])
    expect(problems.join(' ')).toContain('weird')
  })

  /**
   * A platform-keyed default (`{macOS: …, Windows: …}`) has no value for us,
   * because neither key is ours. Treating it as absent is what "no default on
   * this platform" means; keeping the object would hand an extension a
   * `{macOS: "/usr"}` where it declared a string.
   */
  it('treats a platform-keyed default as no default', () => {
    const { manifest } = parseManifest({
      ...MINIMAL,
      preferences: [
        { name: 'path', type: 'textfield', default: { macOS: '/Applications', Windows: 'C:\\' } }
      ]
    })
    expect(manifest?.preferences[0]?.default).toBeUndefined()
  })

  it('parses tools, so an AI-capable extension still installs', () => {
    const { manifest } = parseManifest({
      ...MINIMAL,
      tools: [{ name: 'get-stories', title: 'Get Stories', description: 'read by the model' }]
    })
    expect(manifest?.tools[0]).toMatchObject({ name: 'get-stories', title: 'Get Stories' })
  })

  it('keeps our own `lumanin` namespace and ignores everything else it does not know', () => {
    const { manifest, problems } = parseManifest({
      ...MINIMAL,
      $schema: 'https://www.raycast.com/schemas/extension.json',
      somethingRaycastAddedLastWeek: { deeply: { nested: true } },
      lumanin: { hint: 'works offline' }
    })
    expect(problems).toEqual([])
    expect(manifest?.lumanin).toEqual({ hint: 'works offline' })
  })

  it('falls back to the command name for a missing title', () => {
    const { manifest } = parseManifest({
      name: 'thing',
      commands: [{ name: 'run', mode: 'view' }]
    })
    expect(manifest?.title).toBe('thing')
    expect(manifest?.commands[0]?.title).toBe('run')
  })
})

describe('command categories (lumanin.categories)', () => {
  const base = {
    name: 'onepw',
    commands: [
      {
        name: 'search',
        title: 'Search 1Password',
        mode: 'view',
        lumanin: {
          categories: [
            { id: 'logins', title: 'Logins' },
            { id: 'Bad Id!', title: 'Nope' },
            { id: 'cards' }
          ]
        }
      }
    ]
  }

  it('parses ids and titles, titling an untitled one after its id', () => {
    const { manifest, problems } = parseManifest(base)
    expect(manifest?.commands[0]?.categories).toEqual([
      { id: 'logins', title: 'Logins' },
      { id: 'cards', title: 'cards' }
    ])
    // The charset is the pin-key grammar; a violation is reported, not fatal.
    expect(problems.some((problem) => problem.includes('Bad Id!'))).toBe(true)
  })

  it('is empty for a command that declares none', () => {
    const { manifest } = parseManifest({
      name: 'x',
      commands: [{ name: 'go', title: 'Go', mode: 'view' }]
    })
    expect(manifest?.commands[0]?.categories).toEqual([])
  })
})

/**
 * `commands[].lumanin.root` — whether the root list may reach this command.
 *
 * Opt-*out*, because every plugin anyone writes exists to be found by typing its
 * name. The one command that declines is Search Files, which is a search surface
 * of its own with a key of its own; a filesystem is neither small enough to rank
 * against a few thousand application names nor fast enough to re-scan per
 * keystroke.
 */
describe('a command that is not at the root', () => {
  it('is at the root unless the manifest says otherwise', () => {
    const { manifest } = parseManifest({
      name: 'x',
      commands: [
        { name: 'go', title: 'Go', mode: 'view' },
        { name: 'stay', title: 'Stay', mode: 'view', lumanin: { categories: [{ id: 'a' }] } }
      ]
    })
    expect(manifest?.commands.map((command) => command.root)).toEqual([true, true])
  })

  it('takes only the exact literal as an opt-out', () => {
    const { manifest } = parseManifest({
      name: 'x',
      commands: [
        { name: 'out', title: 'Out', mode: 'view', lumanin: { root: false } },
        { name: 'in', title: 'In', mode: 'view', lumanin: { root: 'false' } },
        { name: 'also-in', title: 'Also', mode: 'view', lumanin: { root: true } }
      ]
    })
    expect(manifest?.commands.map((command) => command.root)).toEqual([false, true, true])
  })
})
