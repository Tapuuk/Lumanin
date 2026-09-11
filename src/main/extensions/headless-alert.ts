import type { AlertPayload } from '../../shared/ext-protocol'

/**
 * `confirmAlert` in a session that has no window.
 *
 * A bound action runs headless: the plugin renders offscreen, the handler is
 * dispatched, and nothing ever maps a surface. An alert raised there used to
 * block on a renderer that does not exist until the grace window killed the
 * worker — the action silently did nothing while the user believed it ran.
 *
 * The contract now: a headless alert is answered by main itself, always with
 * `false`. Auto-dismiss is the only safe answer — the alert exists precisely
 * because the plugin wanted a human in front of a destructive branch, so
 * `if (await confirmAlert(...))` skips that branch, and the notice tells the
 * user where to run it for real.
 */
export function headlessAlertNotice(label: string): string {
  return `${label} needs confirmation - run it from the launcher window`
}

/**
 * Answer an alert if its session is headless.
 *
 * `labelOf` is the headless registry: the action title when a bound action
 * launched the session, else the command title. Returns `true` when the alert
 * was consumed here, so the caller knows not to forward it to the renderer.
 */
export function answerHeadlessAlert(
  alert: AlertPayload,
  labelOf: (sessionId: string) => string | undefined,
  answer: (token: string, confirmed: boolean) => void,
  notify: (text: string) => void
): boolean {
  const label = labelOf(alert.sessionId)
  if (label === undefined) return false
  answer(alert.token, false)
  notify(headlessAlertNotice(label))
  return true
}
