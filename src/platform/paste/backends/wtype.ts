import type { PasteBackend, PasteDeps } from '../index'
import { clipboardThenKeystroke } from './inject'

/**
 * `wtype` (PLATFORM-MATRIX §5 backend 2) — no daemon, no udev rule, no root.
 *
 * It speaks `zwp_virtual_keyboard_manager_v1` directly, which is why it is
 * simpler than ydotool and also why it is narrower: compositors that do not
 * expose that protocol (GNOME, notably) will refuse it at runtime even when the
 * binary is installed. The probe checks `hasVirtualKeyboard` for exactly this.
 *
 * `-M ctrl` presses a modifier, `-k v` presses and releases a named key, `-m ctrl`
 * releases the modifier. Ordering matters the same way it does for ydotool.
 */
export function createWtype(deps: PasteDeps): PasteBackend {
  return clipboardThenKeystroke({
    id: 'wtype',
    exec: deps.exec,
    clipboard: deps.clipboard,
    command: 'wtype',
    args: ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'],
    helperHint: 'wtype was rejected - the compositor may not offer virtual-keyboard'
  })
}
