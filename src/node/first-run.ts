import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commentsOnly, readConfigDocument } from './config-file'

/**
 * First run, answered from either door.
 *
 * The setup wizard lives in the settings app, but nobody opens the settings app
 * on a machine they have not set up yet — they press the hotkey, or they type
 * `lumanin` into a terminal. So both of those offer it: the daemon opens the
 * wizard the first time the panel is actually summoned, and the CLI asks first
 * when it has a terminal to ask in.
 *
 * Three files decide, all under the state dir except the config itself:
 * `config.toml` existing means the machine is set up (however that happened),
 * unless it is comments alone, as "Open Configuration File" creates on a
 * fresh install: that configures nothing and settles nothing;
 * `first-run-done` means the wizard ran to its end; `first-run-offered` means
 * one of the doors already asked. The last one is what keeps this from nagging:
 * being offered setup once is a welcome, being offered it on every command is a
 * bug report.
 */

const DONE = 'first-run-done'
const OFFERED = 'first-run-offered'

export function firstRunPending(configFile: string, stateDir: string): boolean {
  // Ordered by likelihood: on every machine that is set up, the first stat
  // answers and the toggle path pays exactly one.
  if (existsSync(configFile) && !commentsOnly(readConfigDocument(configFile).original)) return false
  if (existsSync(join(stateDir, DONE))) return false
  if (existsSync(join(stateDir, OFFERED))) return false
  return true
}

/** Recorded before the offer is shown, so a crash mid-offer still counts as asked. */
export function markFirstRunOffered(stateDir: string): void {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(stateDir, OFFERED), `${new Date().toISOString()}\n`)
  } catch {
    // Losing the marker means being offered setup again — annoying, not broken.
  }
}
