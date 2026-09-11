import { useEffect, useState } from 'react'
import { DEFAULT_MAX_TYPOS } from '@shared/fuzzy'

/**
 * `[search].typos`, kept in step with `config.toml` the way `useKeys` keeps the
 * keymap: a plugin list filters in the renderer, so the number it forgives has
 * to be here rather than a round trip away. Starts at the default so the first
 * keystroke after opening is filtered the way an untouched config would.
 */
export function useTypos(): number {
  const [typos, setTypos] = useState<number>(DEFAULT_MAX_TYPOS)

  useEffect(() => {
    let cancelled = false

    void window.lumanin.invoke('typos.current').then((payload) => {
      if (!cancelled) setTypos(payload)
    })

    const unsubscribe = window.lumanin.on('typos.changed', setTypos) as () => void
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return typos
}
