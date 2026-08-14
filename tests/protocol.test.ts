import { describe, expect, it } from 'vitest'
import { parseArgs, parseRequest, VERB_KINDS } from '../src/shared/protocol'

describe('parseArgs', () => {
  it('treats a bare invocation as toggle', () => {
    // This is what a compositor bind calls; it must not need an explicit verb.
    expect(parseArgs([])).toMatchObject({ verb: { kind: 'toggle' } })
  })

  it('accepts every allow-listed verb', () => {
    for (const kind of VERB_KINDS) {
      expect(parseArgs([kind]).verb).toEqual({ kind })
    }
  })

  it('reports an unknown verb rather than defaulting to toggle', () => {
    // Silently toggling on a typo would make `lumanin quti` look like it worked.
    const parsed = parseArgs(['frobnicate'])
    expect(parsed.verb).toBeNull()
    expect(parsed.unknown).toBe('frobnicate')
  })

  it('handles help and version flags', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['--version']).version).toBe(true)
    expect(parseArgs(['-v']).version).toBe(true)
  })

  it('lets help win over a verb', () => {
    expect(parseArgs(['toggle', '--help']).help).toBe(true)
  })

  it('parses both spellings of the plugin menu', () => {
    // `store` is the original name; it still parses so the CLI can print the
    // new spelling instead of answering "unknown verb" to a shipped command.
    expect(parseArgs(['plugins']).clientCommand).toBe('plugins')
    expect(parseArgs(['store']).clientCommand).toBe('store')
  })
})

describe('parseRequest', () => {
  it('accepts a well-formed request', () => {
    expect(parseRequest({ id: 3, verb: { kind: 'status' } })).toEqual({
      id: 3,
      verb: { kind: 'status' }
    })
  })

  it('rejects anything that is not an allow-listed verb', () => {
    // SECURITY.md §Local IPC: the verb set is closed and never eval-shaped.
    expect(parseRequest({ id: 1, verb: { kind: 'eval', code: '1+1' } })).toBeNull()
    expect(parseRequest({ id: 1, verb: { kind: '__proto__' } })).toBeNull()
    expect(parseRequest({ id: 1, verb: 'toggle' })).toBeNull()
    expect(parseRequest({ id: 1 })).toBeNull()
  })

  it('rejects malformed envelopes', () => {
    expect(parseRequest(null)).toBeNull()
    expect(parseRequest('toggle')).toBeNull()
    expect(parseRequest([])).toBeNull()
    expect(parseRequest({ id: 'one', verb: { kind: 'toggle' } })).toBeNull()
    expect(parseRequest({ id: Number.NaN, verb: { kind: 'toggle' } })).toBeNull()
  })

  it('drops extra properties instead of passing them through', () => {
    const request = parseRequest({ id: 1, verb: { kind: 'toggle', extra: 'ignored' }, rogue: true })
    expect(request).toEqual({ id: 1, verb: { kind: 'toggle' } })
  })
})

describe('parameterised verbs', () => {
  it('parses `open` with a target and refuses one without', () => {
    expect(parseRequest({ id: 1, verb: { kind: 'open', target: 'app:firefox.desktop' } })).toEqual({
      id: 1,
      verb: { kind: 'open', target: 'app:firefox.desktop' }
    })
    expect(parseRequest({ id: 1, verb: { kind: 'open' } })).toBeNull()
    expect(parseRequest({ id: 1, verb: { kind: 'open', target: '' } })).toBeNull()
    expect(parseRequest({ id: 1, verb: { kind: 'open', target: 'x'.repeat(2000) } })).toBeNull()
  })

  it('parses `enumerate` and requires an explicit null category', () => {
    expect(
      parseRequest({ id: 2, verb: { kind: 'enumerate', command: '1password/search', category: 'logins' } })
    ).toEqual({ id: 2, verb: { kind: 'enumerate', command: '1password/search', category: 'logins' } })
    expect(
      parseRequest({ id: 2, verb: { kind: 'enumerate', command: '1password/search', category: null } })
    ).not.toBeNull()
    expect(parseRequest({ id: 2, verb: { kind: 'enumerate', command: '' , category: null } })).toBeNull()
    expect(parseRequest({ id: 2, verb: { kind: 'enumerate', command: 'x', category: 3 } })).toBeNull()
  })

  it('reads `lumanin open <target>` off argv, keeping a missing target parseable', () => {
    expect(parseArgs(['open', 'extension:1password/search#logins']).verb).toEqual({
      kind: 'open',
      target: 'extension:1password/search#logins'
    })
    // The CLI turns the empty target into a usage message; "unknown verb 'open'"
    // for a verb we have would be the worse answer.
    expect(parseArgs(['open']).verb).toEqual({ kind: 'open', target: '' })
  })
})
