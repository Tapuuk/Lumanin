import type { EscAtRoot } from './config'

/**
 * What Esc should do, given the configured root behaviour and where the user is.
 *
 * The setting is `esc_at_root` and it means what it says: it governs Esc *at the
 * root*, where there is nothing left to back out of. Applying it everywhere made
 * the default (`hide`) throw away a half-typed query on the first Esc, which is
 * the opposite of what every launcher does and made the key's name a lie.
 *
 * Away from the root, Esc always backs out one step. The first step is the
 * query; the extension navigation stack sits above it, and `atRoot` is
 * how the renderer reports that there is nothing above the root left to pop.
 */
export function escapeAction(setting: EscAtRoot, atRoot: boolean): EscAtRoot {
  return atRoot ? setting : 'clear'
}
