import { useEffect, useState } from 'react'
import { DEFAULT_KEYS, type KeyMap } from '@shared/keys'

/**
 * The panel's keybindings, kept in step with `config.toml`.
 *
 * Held here rather than asked for per keystroke: key handling is on the one path
 * in this application measured in milliseconds, and a round trip to main to ask
 * "was that Enter?" would put an IPC hop inside every keypress.
 *
 * It starts at the defaults instead of at `null`, which is the difference
 * between a panel that ignores the first key pressed after it opens and one that
 * does not. The fetch below replaces them a frame later; a user who has not
 * rebound anything cannot tell, and one who has sees their own binding take over
 * before they could have reached for it.
 */
export function useKeys(): KeyMap {
  const [keys, setKeys] = useState<KeyMap>(DEFAULT_KEYS)

  useEffect(() => {
    let cancelled = false

    void window.lumanin.invoke('keys.current').then((payload) => {
      if (!cancelled) setKeys(payload)
    })

    const unsubscribe = window.lumanin.on('keys.changed', setKeys) as () => void
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return keys
}
