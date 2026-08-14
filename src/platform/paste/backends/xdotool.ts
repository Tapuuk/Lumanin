import type { PasteBackend, PasteDeps } from '../index'
import { clipboardThenKeystroke } from './inject'

/**
 * `xdotool` (PLATFORM-MATRIX §5 backend 3) — the X11 path, via XTEST.
 *
 * `--clearmodifiers` is not optional here: the user reached this code by pressing
 * a hotkey, so Super (or whatever they bound) may still be physically held. XTEST
 * synthesises on top of the real modifier state, and without this the target
 * application receives Super+Ctrl+V and does nothing at all.
 *
 * Under XWayland this injects only into other XWayland clients, which is why it
 * sits below the two Wayland-native injectors rather than above them.
 */
export function createXdotool(deps: PasteDeps): PasteBackend {
  return clipboardThenKeystroke({
    id: 'xdotool',
    exec: deps.exec,
    clipboard: deps.clipboard,
    command: 'xdotool',
    args: ['key', '--clearmodifiers', 'ctrl+v'],
    helperHint: 'xdotool could not reach the focused window'
  })
}
