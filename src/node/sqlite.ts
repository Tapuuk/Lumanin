import { chmodSync } from 'node:fs'
import Database, { type Database as Db } from 'better-sqlite3'

/**
 * Opening one of our SQLite files, owner-readable and nothing else.
 *
 * The databases hold every plugin's `LocalStorage` and every stored preference
 * value, `password`-typed ones included. Until this existed they were created
 * with the process umask — `0644` on a default Arch install — inside a `0700`
 * directory, which meant the *directory* was the only thing keeping them
 * private. That holds exactly as long as the file stays where we put it: copy it
 * into a tarball, an rsync backup or a restored disk image and the mode travels
 * with the file while the directory that was protecting it does not.
 *
 * SQLite's WAL mode writes two sidecar files (`-wal`, `-shm`) holding the same
 * data, so they are restricted too — a `0600` database beside a `0644` write-
 * ahead log is not a private database.
 *
 * This is *not* a claim that secrets are safe here. Anything running as this
 * user can still read them, and SECURITY.md is honest that plugins are not
 * sandboxed. It is the file mode matching the directory that already says who
 * this data belongs to. Real encryption at rest is a separate decision — see
 * SHIP.md §10d for why it is deferred rather than forgotten.
 */

/** `0600`, applied best-effort: a filesystem that cannot do it must not stop the daemon. */
function restrictToOwner(file: string): void {
  try {
    chmodSync(file, 0o600)
  } catch {
    // Nothing to do and nothing worth failing over: a mode we cannot set is a
    // filesystem that does not have modes (or a file another user owns, which
    // we could not open anyway). The alternative — refusing to start — would
    // trade a privacy defence for the whole application.
  }
}

/**
 * Open a database, apply its schema, and make it owner-only.
 *
 * Called on every open rather than only at creation, so an installation that
 * predates this repairs itself the next time the daemon starts. The sidecars are
 * restricted after the schema runs, because that is what creates them —
 * `PRAGMA journal_mode = WAL` is the first statement of both schemas.
 */
export function openOwnerOnly(file: string, schema: string): Db {
  const db = new Database(file)
  restrictToOwner(file)
  db.exec(schema)
  restrictToOwner(`${file}-wal`)
  restrictToOwner(`${file}-shm`)
  return db
}
