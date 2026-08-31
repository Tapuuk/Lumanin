import { describe, expect, it } from 'vitest'
import {
  escapeBasic,
  escapeExtended,
  fdPattern,
  locatePattern,
  parseSearchOutput
} from '../plugins/files/src/query'

/**
 * The pure half of the Search Files plugin — pattern building and
 * partial-result handling — tested without spawning `fd`/`locate`/`find`.
 */

describe('escapeExtended (fd, ERE-shaped)', () => {
  it('escapes every ERE metacharacter, including + and ?', () => {
    expect(escapeExtended('c++')).toBe('c\\+\\+')
    expect(escapeExtended('a?b')).toBe('a\\?b')
    expect(escapeExtended('a.b*c^d$e{f}g(h)i|j[k]l\\m')).toBe(
      'a\\.b\\*c\\^d\\$e\\{f\\}g\\(h\\)i\\|j\\[k\\]l\\\\m'
    )
  })

  it('leaves ordinary characters alone', () => {
    expect(escapeExtended('report v2 final')).toBe('report v2 final')
  })
})

describe('escapeBasic (locate --regexp, BRE-shaped)', () => {
  it('leaves + and ? unescaped — escaping them would create BRE operators', () => {
    expect(escapeBasic('c++')).toBe('c++')
    expect(escapeBasic('a?b')).toBe('a?b')
  })

  it('escapes . [ * ^ $ and the backslash itself', () => {
    expect(escapeBasic('a.b[c*d^e$f\\g')).toBe('a\\.b\\[c\\*d\\^e\\$f\\\\g')
  })

  it('leaves BRE-inert punctuation alone', () => {
    expect(escapeBasic('a{b}c(d)e|f')).toBe('a{b}c(d)e|f')
  })
})

describe('fdPattern', () => {
  it('joins words with .* so a two-word query finds a path in order', () => {
    expect(fdPattern('src index')).toBe('src.*index')
  })

  it('quotes ERE-special characters word by word', () => {
    expect(fdPattern('c++ report')).toBe('c\\+\\+.*report')
  })
})

describe('locatePattern', () => {
  it('anchors the pattern under the root so --limit counts in-scope rows', () => {
    expect(locatePattern('report', '/home/alice')).toBe('^/home/alice/.*report[^/]*$')
  })

  it('keeps a multi-word query inside the last path component', () => {
    expect(locatePattern('quarterly report', '/home/alice')).toBe(
      '^/home/alice/.*quarterly[^/]*report[^/]*$'
    )
  })

  it('BRE-escapes the query but not the +/? operators — "c++" stays literal', () => {
    expect(locatePattern('c++', '/home/alice')).toBe('^/home/alice/.*c++[^/]*$')
  })
})

describe('parseSearchOutput', () => {
  it('returns stdout on a clean exit', () => {
    expect(parseSearchOutput({ stdout: 'a\nb\n', stderr: '', exitCode: 0 })).toBe('a\nb\n')
  })

  it('treats exit 1 with stderr as a partial result, not a failure, when stdout has matches', () => {
    const outcome = {
      stdout: '/home/alice/notes.txt\n',
      stderr: "find: '/home/alice/.cache/x': Permission denied\n",
      exitCode: 1
    }
    expect(parseSearchOutput(outcome)).toBe('/home/alice/notes.txt\n')
  })

  it('treats exit 1 with stderr and empty stdout as "no results", not an error', () => {
    const outcome = {
      stdout: '',
      stderr: "find: '/home/alice/.cache/x': Permission denied\n",
      exitCode: 1
    }
    expect(parseSearchOutput(outcome)).toBe('')
  })

  it('throws on exit codes past 1', () => {
    const outcome = { stdout: '', stderr: 'fd: invalid pattern\n', exitCode: 2 }
    expect(() => parseSearchOutput(outcome)).toThrow('fd: invalid pattern')
  })

  it('rethrows a failed spawn regardless of exit code', () => {
    const spawnError = new Error('spawn fd ENOENT')
    const outcome = { stdout: '', stderr: '', exitCode: null, error: spawnError }
    expect(() => parseSearchOutput(outcome)).toThrow(spawnError)
  })
})
