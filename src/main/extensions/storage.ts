import { join } from 'node:path'
import { type Database as Db } from 'better-sqlite3'
import { openOwnerOnly } from '../../node/sqlite'

/**
 * `LocalStorage` and preference values, per extension.
 *
 * One database file for both, and one row-space per extension, because the
 * namespace is the security boundary such as it is: the threat is an extension
 * reading another extension's secrets, and the mitigation is
 * that the api-shim exposes no cross-extension read path. That works only while
 * the namespace comes from the session main already knows rather than from a
 * name the worker sends — which is why every method here takes the extension as
 * a parameter and none of them take a table.
 *
 * The honest caveat: an extension has full filesystem
 * access and can open this file directly. This is a speed bump, not a wall.
 *
 * One file per concern — this one is extensions, and a corrupt
 * clipboard database can never cost someone their extension data.
 */

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS storage (
    extension TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    kind      TEXT NOT NULL,
    PRIMARY KEY (extension, key)
  );

  CREATE TABLE IF NOT EXISTS preferences (
    extension TEXT NOT NULL,
    command   TEXT NOT NULL,
    name      TEXT NOT NULL,
    value     TEXT NOT NULL,
    kind      TEXT NOT NULL,
    PRIMARY KEY (extension, command, name)
  );
`

/** What `LocalStorage.Value` allows: string | number | boolean. */
export type StorageValue = string | number | boolean

/**
 * The type travels with the value.
 *
 * SQLite would happily store a number and hand it back as one, but the column is
 * TEXT so that `true` and `"true"` stay distinguishable — an extension that
 * stored a boolean and read back the string `"false"` would find it truthy, which
 * is the kind of bug that survives for months.
 */
function encode(value: StorageValue): { value: string; kind: string } {
  return { value: String(value), kind: typeof value }
}

function decode(row: { value: string; kind: string } | undefined): StorageValue | null {
  if (row === undefined) return null
  switch (row.kind) {
    case 'number':
      return Number(row.value)
    case 'boolean':
      return row.value === 'true'
    default:
      return row.value
  }
}

export class ExtensionStore {
  private readonly db: Db

  constructor(directory: string, filename = 'extensions.db') {
    // Owner-only: this file holds every plugin's LocalStorage and every stored
    // preference value, `password`-typed ones included. See `node/sqlite.ts`.
    this.db = openOwnerOnly(join(directory, filename), SCHEMA)
  }

  // --- LocalStorage ---------------------------------------------------------

  get(extension: string, key: string): StorageValue | null {
    const row = this.db
      .prepare('SELECT value, kind FROM storage WHERE extension = ? AND key = ?')
      .get(extension, key) as { value: string; kind: string } | undefined
    return decode(row)
  }

  set(extension: string, key: string, value: StorageValue): void {
    const encoded = encode(value)
    this.db
      .prepare(
        `INSERT INTO storage (extension, key, value, kind) VALUES (?, ?, ?, ?)
         ON CONFLICT(extension, key) DO UPDATE SET value = excluded.value, kind = excluded.kind`
      )
      .run(extension, key, encoded.value, encoded.kind)
  }

  remove(extension: string, key: string): void {
    this.db.prepare('DELETE FROM storage WHERE extension = ? AND key = ?').run(extension, key)
  }

  clear(extension: string): void {
    this.db.prepare('DELETE FROM storage WHERE extension = ?').run(extension)
  }

  all(extension: string): Record<string, StorageValue> {
    const rows = this.db
      .prepare('SELECT key, value, kind FROM storage WHERE extension = ?')
      .all(extension) as { key: string; value: string; kind: string }[]

    const values: Record<string, StorageValue> = {}
    for (const row of rows) {
      const decoded = decode(row)
      if (decoded !== null) values[row.key] = decoded
    }
    return values
  }

  // --- preferences ----------------------------------------------------------

  /**
   * A command's stored preferences: the extension's, then the command's own on
   * top. `''` is the command name for an extension-wide preference, so both live
   * in one table with one primary key rather than in two tables that have to be
   * merged identically at every call site.
   */
  preferences(extension: string, command: string): Record<string, StorageValue> {
    const rows = this.db
      .prepare(
        `SELECT name, value, kind, command FROM preferences
         WHERE extension = ? AND (command = '' OR command = ?)
         ORDER BY CASE WHEN command = '' THEN 0 ELSE 1 END`
      )
      .all(extension, command) as { name: string; value: string; kind: string }[]

    const values: Record<string, StorageValue> = {}
    for (const row of rows) {
      const decoded = decode(row)
      if (decoded !== null) values[row.name] = decoded
    }
    return values
  }

  setPreference(extension: string, command: string, name: string, value: StorageValue): void {
    const encoded = encode(value)
    this.db
      .prepare(
        `INSERT INTO preferences (extension, command, name, value, kind) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(extension, command, name) DO UPDATE SET value = excluded.value, kind = excluded.kind`
      )
      .run(extension, command, name, encoded.value, encoded.kind)
  }

  /** Forget everything an extension stored. Called when it is uninstalled. */
  forget(extension: string): void {
    this.db.prepare('DELETE FROM storage WHERE extension = ?').run(extension)
    this.db.prepare('DELETE FROM preferences WHERE extension = ?').run(extension)
  }

  close(): void {
    this.db.close()
  }
}
