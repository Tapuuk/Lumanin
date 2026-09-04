/**
 * When a search text reaches the extension that asked for it.
 *
 * A list declaring `throttle` is saying that answering a query is expensive, so
 * it would rather hear the word than every prefix of it. The collapse is a
 * trailing debounce, not a leading one: the first character of a query is the
 * broadest and slowest thing a plugin can be handed, so firing on it and then
 * throttling is exactly backwards. Waiting instead means a burst of typing costs
 * one round trip, and a deliberate pause is answered a frame or two after the
 * user stops.
 *
 * The window is the same for everyone. A fast typist leaves 60-120 ms between
 * keys, so 150 ms sits above a within-word burst and below a pause.
 *
 * What is shown never waits on this. The search box and any filtering the panel
 * does itself are updated straight away; only the message to the extension is
 * held back.
 */
export const SEARCH_THROTTLE_MS = 150

export interface SearchDispatch {
  /** Deliver `text`, now or at the end of the current burst. */
  send(handlerId: string, text: string, throttled: boolean): void
  /** Drop a pending delivery without making it. */
  cancel(): void
}

export function createSearchDispatch(
  deliver: (handlerId: string, text: string) => void,
  delayMs: number = SEARCH_THROTTLE_MS
): SearchDispatch {
  let timer: ReturnType<typeof setTimeout> | null = null

  const clear = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  return {
    send(handlerId, text, throttled) {
      clear()
      // Emptying the box is the user cancelling, and cancelling is never worth
      // waiting for. It also asks for no work, so deferring it saves nothing.
      if (!throttled || text === '') {
        deliver(handlerId, text)
        return
      }
      timer = setTimeout(() => {
        timer = null
        deliver(handlerId, text)
      }, delayMs)
    },
    cancel: clear
  }
}
