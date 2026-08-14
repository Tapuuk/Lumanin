import { describe, expect, it } from 'vitest'
import { Logger, parseLevel, redact, type LogRecord } from '../src/node/logger'

function capture(): { records: LogRecord[]; logger: Logger } {
  const records: LogRecord[] = []
  return { records, logger: new Logger('debug', [(record) => records.push(record)]) }
}

describe('redaction', () => {
  // SECURITY.md: clipboard contents and password-typed preference values
  // must never reach disk. Enforced here so no call site has to remember.
  it('redacts secret-shaped keys in any casing or separator style', () => {
    const out = redact({
      password: 'hunter2',
      apiKey: 'sk-live-1',
      api_key: 'sk-live-2',
      accessToken: 'ya29.a0',
      refresh_token: 'r1',
      Authorization: 'Bearer x',
      clipboardText: 'card number',
      privateKey: '-----BEGIN',
      username: 'tapkich'
    }) as Record<string, unknown>

    for (const key of [
      'password',
      'apiKey',
      'api_key',
      'accessToken',
      'refresh_token',
      'Authorization',
      'clipboardText',
      'privateKey'
    ]) {
      expect(out[key], key).toBe('[redacted]')
    }
    // Non-secret fields survive; redaction that eats everything is useless.
    expect(out['username']).toBe('tapkich')
  })

  it('redacts nested values', () => {
    const out = redact({ prefs: { deep: { token: 'abc' } } }) as {
      prefs: { deep: { token: string } }
    }
    expect(out.prefs.deep.token).toBe('[redacted]')
  })

  it('serialises errors rather than dropping them to {}', () => {
    const out = redact(new Error('boom')) as { name: string; message: string }
    expect(out.name).toBe('Error')
    expect(out.message).toBe('boom')
  })

  it('caps long strings, wide arrays and deep objects', () => {
    expect(String(redact('x'.repeat(5000)))).toContain('[5000 chars]')

    const wide = redact(Array.from({ length: 200 }, (_, i) => i)) as unknown[]
    expect(wide).toHaveLength(51)
    expect(String(wide[50])).toContain('150 more')

    let deep: unknown = 'leaf'
    for (let i = 0; i < 20; i += 1) deep = { deep }
    expect(JSON.stringify(redact(deep))).toContain('depth-limit')
  })
})

describe('Logger', () => {
  it('filters below the configured level', () => {
    const records: LogRecord[] = []
    const logger = new Logger('warn', [(record) => records.push(record)])

    logger.debug('nope')
    logger.info('nope')
    logger.warn('yes')
    logger.error('yes')

    expect(records.map((r) => r.level)).toEqual(['warn', 'error'])
  })

  it('redacts fields on the way to the sink', () => {
    const { records, logger } = capture()
    logger.info('prefs loaded', { token: 'secret', extensionName: 'hacker-news' })

    expect(records[0]?.['token']).toBe('[redacted]')
    expect(records[0]?.['extensionName']).toBe('hacker-news')
  })

  it('stamps child fields onto every record', () => {
    const { records, logger } = capture()
    logger.child({ sessionId: 's1' }).info('render')

    expect(records[0]?.['sessionId']).toBe('s1')
  })

  it('survives a throwing sink', () => {
    const records: LogRecord[] = []
    const logger = new Logger('debug', [
      () => {
        throw new Error('sink is broken')
      },
      (record) => records.push(record)
    ])

    expect(() => logger.info('still fine')).not.toThrow()
    expect(records).toHaveLength(1)
  })
})

describe('parseLevel', () => {
  it('accepts known levels and falls back otherwise', () => {
    expect(parseLevel('debug')).toBe('debug')
    expect(parseLevel('WARN')).toBe('warn')
    expect(parseLevel('verbose')).toBe('info')
    expect(parseLevel(undefined)).toBe('info')
  })
})
