import { useEffect, useState } from 'react'
import type { ThemePayload } from '@shared/ipc'

/**
 * Applies the resolved theme's tokens as CSS custom properties on `:root` and
 * keeps them in sync with the daemon.
 *
 * THEMING.md requires live hot-swapping without a reload, which is why tokens
 * arrive as custom properties rather than being compiled into the stylesheet —
 * swapping a theme is one write per token, not a rebuild.
 */
export function useTheme(): ThemePayload | null {
  const [theme, setTheme] = useState<ThemePayload | null>(null)

  useEffect(() => {
    let cancelled = false

    void window.lumanin.invoke('theme.current').then((payload) => {
      if (!cancelled) setTheme(payload)
    })

    return window.lumanin.on('theme.changed', setTheme) as () => void
  }, [])

  useEffect(() => {
    if (theme === null) return
    const root = document.documentElement
    for (const [name, value] of Object.entries(theme.cssVars)) {
      root.style.setProperty(name, value)
    }
  }, [theme])

  return theme
}
