import { describe, expect, it } from 'vitest'
import {
  LIMIT,
  argsFor,
  escapeBasic,
  escapeExtended,
  fdPattern,
  locatePattern,
  parseSearchOutput,
  splitOutput
} from '../plugins/files/src/query'

/**
 * The pure half of the Search Files plugin — pattern building, the argv per
 * tool, and partial-result handling — tested without spawning `fd`/`locate`/
 * `find`. The argv is the only automated check on the locate and find command
 * lines, since no machine is guaranteed to have either.
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
    expect(locatePattern('report', '/home/alice', true)).toBe('^/home/alice/.*report[^/]*$')
  })

  it('keeps a multi-word query inside the last path component', () => {
    expect(locatePattern('quarterly report', '/home/alice', true)).toBe(
      '^/home/alice/.*quarterly[^/]*report[^/]*$'
    )
  })

  it('BRE-escapes the query but not the +/? operators — "c++" stays literal', () => {
    expect(locatePattern('c++', '/home/alice', true)).toBe('^/home/alice/.*c++[^/]*$')
  })

  it('requires every component under the root to start with a non-dot when hidden is off', () => {
    expect(locatePattern('report', '/home/alice', false)).toBe(
      '^/home/alice/\\([^./][^/]*/\\)*\\([^./][^/]*\\)\\{0,1\\}report[^/]*$'
    )
  })

  it('keeps the hidden-off prefix ahead of a multi-word query', () => {
    expect(locatePattern('quarterly report', '/home/alice', false)).toBe(
      '^/home/alice/\\([^./][^/]*/\\)*\\([^./][^/]*\\)\\{0,1\\}quarterly[^/]*report[^/]*$'
    )
  })
})

describe('argsFor', () => {
  it('builds the fd argv with neither hidden nor ignored files', () => {
    expect(argsFor('fd', 'report', '/home/alice', { hidden: false, noIgnore: false })).toEqual([
      '--absolute-path', '--color', 'never', '--ignore-case', '--print0',
      '--max-results', '200', '--exclude', '.git', '--', 'report', '/home/alice'
    ])
  })

  it('adds --hidden and --no-ignore to fd, and still excludes .git', () => {
    expect(argsFor('fd', 'report', '/home/alice', { hidden: true, noIgnore: true })).toEqual([
      '--absolute-path', '--color', 'never', '--ignore-case', '--print0',
      '--max-results', '200', '--hidden', '--no-ignore',
      '--exclude', '.git', '--', 'report', '/home/alice'
    ])
  })

  it('encodes the hidden rule in the locate pattern, not in a flag', () => {
    expect(argsFor('locate', 'report', '/home/alice', { hidden: false, noIgnore: false })).toEqual([
      '--null', '--ignore-case', '--limit', '800', '--regexp',
      '^/home/alice/\\([^./][^/]*/\\)*\\([^./][^/]*\\)\\{0,1\\}report[^/]*$'
    ])
  })

  it('drops the locate hidden prefix when hidden files are wanted', () => {
    expect(argsFor('locate', 'report', '/home/alice', { hidden: true, noIgnore: false })).toEqual([
      '--null', '--ignore-case', '--limit', '800', '--regexp', '^/home/alice/.*report[^/]*$'
    ])
  })

  it('prunes dotdirs in the find argv rather than filtering their contents out', () => {
    expect(argsFor('find', 'report', '/home/alice', { hidden: false, noIgnore: false })).toEqual([
      '/home/alice', '-maxdepth', '6',
      '-name', '.*', '-prune', '-o', '-iname', '*report*', '-print0'
    ])
  })

  it('drops the find prune when hidden files are wanted', () => {
    expect(argsFor('find', 'report', '/home/alice', { hidden: true, noIgnore: false })).toEqual([
      '/home/alice', '-maxdepth', '6', '-iname', '*report*', '-print0'
    ])
  })

  it('ignores noIgnore for find, which reads no ignore files', () => {
    expect(argsFor('find', 'report', '/home/alice', { hidden: false, noIgnore: true })).toEqual(
      argsFor('find', 'report', '/home/alice', { hidden: false, noIgnore: false })
    )
  })
})

describe('splitOutput', () => {
  it('keeps a trailing space, which trimming would have lost', () => {
    expect(splitOutput('/home/alice/a \0', '/home/alice', false)).toEqual(['/home/alice/a '])
  })

  it('keeps a name containing a newline as one path', () => {
    expect(splitOutput('/home/alice/x\ny\0', '/home/alice', false)).toEqual(['/home/alice/x\ny'])
  })

  it('drops a path with a hidden component unless hidden files are wanted', () => {
    const stdout = '/home/alice/.cache/report.md\0'
    expect(splitOutput(stdout, '/home/alice', false)).toEqual([])
    expect(splitOutput(stdout, '/home/alice', true)).toEqual(['/home/alice/.cache/report.md'])
  })

  it('does not read a dot in the middle of a name as hidden', () => {
    expect(splitOutput('/home/alice/my.config.toml\0', '/home/alice', false)).toEqual([
      '/home/alice/my.config.toml'
    ])
  })

  it('drops a record outside the root, which is how locate is scoped', () => {
    expect(splitOutput('/usr/share/report\0', '/home/alice', false)).toEqual([])
  })

  it('keeps the root itself', () => {
    expect(splitOutput('/home/alice\0', '/home/alice', false)).toEqual(['/home/alice'])
  })

  it('returns a final record that was cut off before its delimiter', () => {
    expect(splitOutput('/home/alice/a\0/home/alice/trunc', '/home/alice', false)).toEqual([
      '/home/alice/a',
      '/home/alice/trunc'
    ])
  })

  it('caps the list at LIMIT records', () => {
    const stdout = Array.from({ length: LIMIT + 50 }, (_, i) => `/home/alice/f${String(i)}\0`).join('')
    expect(splitOutput(stdout, '/home/alice', false)).toHaveLength(LIMIT)
  })
})

describe('parseSearchOutput', () => {
  it('returns stdout on a clean exit', () => {
    expect(parseSearchOutput({ stdout: 'a\0b\0', stderr: '', exitCode: 0 }, 'fd')).toBe('a\0b\0')
  })

  it('treats exit 1 with stderr as a partial result, not a failure, when stdout has matches', () => {
    const outcome = {
      stdout: '/home/alice/notes.txt\0',
      stderr: "find: '/home/alice/.cache/x': Permission denied\n",
      exitCode: 1
    }
    expect(parseSearchOutput(outcome, 'find')).toBe('/home/alice/notes.txt\0')
  })

  it('treats find exit 1 with stderr and empty stdout as "no results", not an error', () => {
    const outcome = {
      stdout: '',
      stderr: "find: '/home/alice/.cache/x': Permission denied\n",
      exitCode: 1
    }
    expect(parseSearchOutput(outcome, 'find')).toBe('')
  })

  it('reads locate exit 1 with stderr and no output as a database failure', () => {
    const outcome = {
      stdout: '',
      stderr: '/var/lib/plocate/plocate.db: Permission denied\n',
      exitCode: 1
    }
    expect(() => parseSearchOutput(outcome, 'locate')).toThrow(
      '/var/lib/plocate/plocate.db: Permission denied'
    )
  })

  it('reads locate exit 1 with a silent stderr as "no matches"', () => {
    expect(parseSearchOutput({ stdout: '', stderr: '', exitCode: 1 }, 'locate')).toBe('')
  })

  it('keeps a partial locate result, which is still a result', () => {
    const outcome = {
      stdout: '/home/alice/notes.txt\0',
      stderr: 'plocate: some warning\n',
      exitCode: 1
    }
    expect(parseSearchOutput(outcome, 'locate')).toBe('/home/alice/notes.txt\0')
  })

  it('throws on exit codes past 1', () => {
    const outcome = { stdout: '', stderr: 'fd: invalid pattern\n', exitCode: 2 }
    expect(() => parseSearchOutput(outcome, 'fd')).toThrow('fd: invalid pattern')
  })

  it('returns partial stdout when a timeout killed the tool mid-print', () => {
    const outcome = {
      stdout: '/home/alice/notes.txt\0',
      stderr: '',
      exitCode: null,
      error: new Error('fd pattern timed out after 4000 ms')
    }
    expect(parseSearchOutput(outcome, 'fd')).toBe('/home/alice/notes.txt\0')
  })

  it('rethrows a failed spawn regardless of exit code', () => {
    const spawnError = new Error('spawn fd ENOENT')
    const outcome = { stdout: '', stderr: '', exitCode: null, error: spawnError }
    expect(() => parseSearchOutput(outcome, 'fd')).toThrow(spawnError)
  })
})
