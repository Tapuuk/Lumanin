/**
 * Collapsing a burst of toggles into one.
 *
 * A compositor keybind fires `lumanin toggle` once per key event, and holding
 * the hotkey down produces one every ~30 ms at the key repeat rate. Each of
 * those is a real map or unmap of a Wayland surface, so fifteen presses meant
 * fifteen of them: the panel took visibly longer to settle, and whether it ended
 * up open or closed depended on how many events happened to arrive.
 *
 * Pure and separate from the daemon so the rule can be asserted without an
 * Electron window — the behaviour is entirely about arithmetic on timestamps.
 */

/**
 * How close together two toggles have to be before the second is ignored.
 *
 * Above a key repeat (25-40 ms at the usual 25-40 Hz rates) and below the
 * fastest deliberate presses a hand produces (about 80-100 ms when the key is
 * hammered), so holding the key opens the panel once and rapid presses still
 * each flip it. It was 120 ms, which swallowed every press of a fast burst but
 * the first: measured against a real daemon, 11 of 12 presses 90 ms apart did
 * nothing, which reads as the panel lagging.
 */
export const TOGGLE_COALESCE_MS = 60

/**
 * Whether this toggle should be ignored as part of a burst.
 *
 * The window is **trailing**: the caller records `now` as the last toggle time
 * whether or not it acted, so a continuous stream produces exactly one flip
 * however long it runs. A leading window would let every fourth press of a 30 ms
 * repeat through, which is how holding the key left the panel open or closed at
 * random — verified against a real daemon before this existed.
 */
export function coalesceToggle(now: number, lastToggleAt: number | null): boolean {
  // `null` rather than `0` for "never toggled": a sentinel that is also a valid
  // timestamp is a sentinel that eventually swallows a real press.
  return lastToggleAt !== null && now - lastToggleAt < TOGGLE_COALESCE_MS
}
