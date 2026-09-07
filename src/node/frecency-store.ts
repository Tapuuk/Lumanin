import { join } from 'node:path'
import { type Database as Db, type Statement } from 'better-sqlite3'
import { openOwnerOnly } from './sqlite'
import { decay, launchWeight, type Frecency } from '../shared/frecency'

/**
 * Launch history, persisted.
 *
 * **One database file per concern** — this one is only frecency.
 * The reason is recovery rather than tidiness: a corrupt clipboard database
 * should never cost the user their launch habits, and a schema migration for one
 * feature should never be able to take another offline.
 *
 * better-sqlite3 v13 ships **Node-API prebuilds**, which are ABI-stable across
 * Node and Electron versions. Verified on this tree: Electron 43 reports ABI 148
 * and local Node reports 147, and the same `prebuilds/linux-x64.node` loads under
 * both. So an `electron-rebuild` step is not
 * needed, and packaging does not have to rebuild per Electron bump.
 */

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS launches (
    id          TEXT PRIMARY KEY,
    score       REAL NOT NULL DEFAULT 0,
    last_used   INTEGER NOT NULL,
    launches    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

/**
 * Decay is anchored to a fixed epoch stored with the database rather than
 * recomputed against "now".
 *
 * Without an anchor, every read would have to decay every row before comparing
 * them, and every write would have to rewrite the whole table to keep the totals
 * comparable. With one, a launch's weight is `2^((t - epoch) / half-life)` and
 * totals from different times can simply be added — one UPDATE per launch, no
 * background maintenance.
 *
 * The cost is that weights grow without bound over years. `rank()` takes the
 * logarithm, so the growth is harmless, and {@link maybeRebase} keeps the raw
 * numbers inside double precision anyway.
 */
const EPOCH_KEY = 'frecency_epoch'
const REBASE_ABOVE = 1e12

export interface LaunchRecord extends Frecency {
  readonly id: string
  readonly launches: number
}

export class FrecencyStore {
  private readonly db: Db
  private readonly selectAll: Statement
  private readonly upsertLaunch: Statement
  private readonly deleteLaunch: Statement
  private readonly peakScore: Statement
  private epoch: number

  /**
   * The last result of {@link all}, or `null` when a write has invalidated it.
   *
   * Safe because this process holds the only handle on the launches table: no
   * row can change without going through `record`, `forget` or `maybeRebase`,
   * and each of those drops the snapshot.
   */
  private snapshot: ReadonlyMap<string, LaunchRecord> | null = null

  constructor(directory: string, filename = 'frecency.db') {
    // Owner-only, like every database of ours — `node/sqlite.ts` says why.
    this.db = openOwnerOnly(join(directory, filename), SCHEMA)
    this.selectAll = this.db.prepare('SELECT id, score, last_used AS lastUsed, launches FROM launches')
    this.upsertLaunch = this.db.prepare(
      `INSERT INTO launches (id, score, last_used, launches) VALUES (?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         score = score + excluded.score,
         last_used = excluded.last_used,
         launches = launches + 1`
    )
    this.deleteLaunch = this.db.prepare('DELETE FROM launches WHERE id = ?')
    this.peakScore = this.db.prepare('SELECT MAX(score) AS peak FROM launches')
    this.epoch = this.readEpoch()
  }

  private readEpoch(): number {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(EPOCH_KEY) as
      | { value: string }
      | undefined
    if (row !== undefined) {
      const parsed = Number(row.value)
      if (Number.isFinite(parsed)) return parsed
    }

    const now = Date.now()
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(EPOCH_KEY, String(now))
    return now
  }

  /** Record one launch. */
  record(id: string, at = Date.now()): void {
    const weight = launchWeight(at, this.epoch)
    this.upsertLaunch.run(id, weight, at)
    this.snapshot = null

    this.maybeRebase()
  }

  /**
   * Everything known, keyed by id.
   *
   * Read whole rather than queried per item: the table has one row per app the
   * user has ever launched — hundreds, not millions — and a Map handed to the
   * ranker beats a prepared statement executed once per candidate on every
   * keystroke.
   */
  all(): ReadonlyMap<string, LaunchRecord> {
    if (this.snapshot !== null) return this.snapshot

    const rows = this.selectAll.all() as LaunchRecord[]
    this.snapshot = new Map(rows.map((row) => [row.id, row]))
    return this.snapshot
  }

  /** Forget one item — the reverse of `record`, for a removed app. */
  forget(id: string): void {
    this.deleteLaunch.run(id)
    this.snapshot = null
  }

  /**
   * Move the epoch forward when weights get large, rescaling every score so the
   * *relative* order is untouched. Without this, a database used for a decade
   * would eventually overflow to Infinity and every app would rank equally.
   */
  private maybeRebase(): void {
    const row = this.peakScore.get() as { peak: number | null }
    if (row.peak === null || row.peak < REBASE_ABOVE) return

    const now = Date.now()
    const factor = decay(1, this.epoch, now)
    this.db.prepare('UPDATE launches SET score = score * ?').run(factor)
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(EPOCH_KEY, String(now))
    this.epoch = now
    this.snapshot = null
  }

  close(): void {
    this.db.close()
  }
}
