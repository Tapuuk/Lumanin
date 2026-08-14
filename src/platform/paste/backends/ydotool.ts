import type { PasteBackend, PasteDeps } from '../index'
import { clipboardThenKeystroke } from './inject'

/**
 * `ydotool` (PLATFORM-MATRIX §5 backend 1) — the only injector that works on
 * GNOME Wayland, because it goes through `/dev/uinput` at the kernel level
 * rather than through a Wayland protocol the compositor may not expose.
 *
 * The price is a daemon and a udev rule: `ydotoold` must be running and the user
 * must be able to open `/dev/uinput`. Both are what `doctor --fix` assists with,
 * and a missing daemon is why the probe flags it DEGRADED rather than absent.
 *
 * The argument form is raw Linux keycodes with press/release flags, not key
 * names: `29` is `KEY_LEFTCTRL` and `47` is `KEY_V` from `linux/input-event-codes.h`.
 * They are released in reverse order because a modifier released before the key
 * it modifies produces a bare `v` in the target application.
 */
const KEY_LEFTCTRL = 29
const KEY_V = 47

export function createYdotool(deps: PasteDeps): PasteBackend {
  return clipboardThenKeystroke({
    id: 'ydotool',
    exec: deps.exec,
    clipboard: deps.clipboard,
    command: 'ydotool',
    args: [
      'key',
      `${String(KEY_LEFTCTRL)}:1`,
      `${String(KEY_V)}:1`,
      `${String(KEY_V)}:0`,
      `${String(KEY_LEFTCTRL)}:0`
    ],
    helperHint: 'ydotool could not inject - is ydotoold running?'
  })
}
