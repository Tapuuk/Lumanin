import { describe, expect, it } from 'vitest'
import { answerHeadlessAlert, headlessAlertNotice } from '../src/main/extensions/headless-alert'
import { AlertRegistry } from '../src/main/extensions/alerts'
import type { AlertPayload } from '../src/shared/ext-protocol'

/**
 * `confirmAlert` in a headless session — the policy behind a bound action.
 *
 * A key bound to a destructive action ("Stop Container") dispatches its handler
 * with no window; the alert the plugin raises there has no renderer to answer
 * it. Main answers instead, and the contract is one-sided by design: the alert
 * is always dismissed (`false`), never confirmed, and a notice tells the user
 * where to run the action for real. Auto-confirming would take the destructive
 * branch the plugin put the alert in front of.
 */

function alert(sessionId: string): AlertPayload {
  return {
    sessionId,
    token: 'alert-7',
    title: 'Stop this container?',
    primaryTitle: 'Stop',
    dismissTitle: 'Cancel',
    destructive: true
  }
}

describe('answerHeadlessAlert', () => {
  it('answers a headless alert with false and emits the notice', () => {
    const headless = new Map([['session-1', 'Stop Container']])
    const answers: Array<{ token: string; confirmed: boolean }> = []
    const notices: string[] = []

    const consumed = answerHeadlessAlert(
      alert('session-1'),
      (sessionId) => headless.get(sessionId),
      (token, confirmed) => answers.push({ token, confirmed }),
      (text) => notices.push(text)
    )

    expect(consumed).toBe(true)
    expect(answers).toEqual([{ token: 'alert-7', confirmed: false }])
    expect(notices).toEqual(['Stop Container needs confirmation - run it from the launcher window'])
  })

  it('names the command when the session was not launched by a bound action', () => {
    const headless = new Map([['session-2', 'Search Docker']])
    const notices: string[] = []

    answerHeadlessAlert(
      alert('session-2'),
      (sessionId) => headless.get(sessionId),
      () => {},
      (text) => notices.push(text)
    )

    expect(notices).toEqual([headlessAlertNotice('Search Docker')])
  })

  it('leaves an alert from a windowed session alone', () => {
    const answers: unknown[] = []
    const notices: unknown[] = []

    const consumed = answerHeadlessAlert(
      alert('session-3'),
      () => undefined,
      (token, confirmed) => answers.push({ token, confirmed }),
      (text) => notices.push(text)
    )

    expect(consumed).toBe(false)
    expect(answers).toEqual([])
    expect(notices).toEqual([])
  })
})

/**
 * The registry behind `confirmAlert` in a windowed session. Without it, hiding
 * the panel deleted the session and left the worker parked on a promise nobody
 * could answer, for the life of the host process.
 */
describe('AlertRegistry', () => {
  it('resolves an answered alert once and forgets it', () => {
    const registry = new AlertRegistry()
    const answers: boolean[] = []
    registry.register('s1', 'alert-1', (confirmed) => answers.push(confirmed))
    expect(registry.answer('alert-1', true)).toBe(true)
    expect(registry.answer('alert-1', false)).toBe(false)
    expect(answers).toEqual([true])
    expect(registry.size).toBe(0)
  })

  it('dismisses a closing session’s alerts and leaves another session’s alone', () => {
    const registry = new AlertRegistry()
    const answers: Array<[string, boolean]> = []
    registry.register('s1', 'alert-1', (confirmed) => answers.push(['alert-1', confirmed]))
    registry.register('s2', 'alert-2', (confirmed) => answers.push(['alert-2', confirmed]))
    registry.closeSession('s1')
    expect(answers).toEqual([['alert-1', false]])
    expect(registry.size).toBe(1)
  })

  it('closeAll empties it, every alert dismissed', () => {
    const registry = new AlertRegistry()
    const answers: boolean[] = []
    registry.register('s1', 'alert-1', (confirmed) => answers.push(confirmed))
    registry.register('s2', 'alert-2', (confirmed) => answers.push(confirmed))
    registry.closeAll()
    expect(answers).toEqual([false, false])
    expect(registry.size).toBe(0)
  })

  it('ignores an unknown token', () => {
    const registry = new AlertRegistry()
    expect(registry.answer('alert-none', true)).toBe(false)
  })
})
