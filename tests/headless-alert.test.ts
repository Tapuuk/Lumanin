import { describe, expect, it } from 'vitest'
import { answerHeadlessAlert, headlessAlertNotice } from '../src/main/extensions/headless-alert'
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
