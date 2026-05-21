import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

import Database from 'better-sqlite3'

/**
 * Thin wrapper around a `better-sqlite3` connection. Owns schema creation,
 * prepared statements for the hot path, and a `close()` method for tests.
 */
export class CollectorDb {
  readonly db: Database.Database
  readonly insertSnapshot: Database.Statement
  readonly insertHistorySnapshot: Database.Statement
  readonly insertReplicaSnapshot: Database.Statement
  readonly setMeta: Database.Statement

  private constructor(db: Database.Database) {
    this.db = db
    this.insertSnapshot = db.prepare(
      `INSERT INTO snapshots
         (app, date, unique_visitors, source, polled_at, generated_at, is_today, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    // History days repeat identically on every poll once finalized, so use
    // INSERT OR IGNORE on a stable uniqueness key to keep the table small.
    this.insertHistorySnapshot = db.prepare(
      `INSERT OR IGNORE INTO snapshots
         (app, date, unique_visitors, source, polled_at, generated_at, is_today, raw)
       VALUES (?, ?, ?, ?, ?, NULL, 0, NULL)`,
    )
    this.insertReplicaSnapshot = db.prepare(
      `INSERT INTO replica_snapshots
         (app, replica_url, date, unique_visitors, salt_fingerprint, polled_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    this.setMeta = db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
  }

  static open(dbPath: string): CollectorDb {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    applySchema(db)
    return new CollectorDb(db)
  }

  close(): void {
    this.db.close()
  }

  transaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn)
    return tx()
  }
}

function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL)
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    app             TEXT NOT NULL,
    date            TEXT NOT NULL,
    unique_visitors INTEGER NOT NULL,
    source          TEXT NOT NULL,
    polled_at       TEXT NOT NULL,
    generated_at    TEXT,
    is_today        INTEGER NOT NULL,
    raw             TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_app_date
    ON snapshots(app, date);
  CREATE INDEX IF NOT EXISTS idx_snapshots_polled_at
    ON snapshots(polled_at);

  -- Uniqueness for past-day rows: once a day's number is finalized in
  -- the library, every subsequent poll observes the exact same value, so
  -- INSERT OR IGNORE keyed on (app, date, is_today=0) prevents bloat.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_history_unique
    ON snapshots(app, date)
    WHERE is_today = 0;

  CREATE TABLE IF NOT EXISTS replica_snapshots (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    app              TEXT NOT NULL,
    replica_url      TEXT NOT NULL,
    date             TEXT NOT NULL,
    unique_visitors  INTEGER NOT NULL,
    salt_fingerprint TEXT NOT NULL,
    polled_at        TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_replica_snapshots_app_polled
    ON replica_snapshots(app, polled_at);

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE VIEW IF NOT EXISTS daily AS
    SELECT app, date,
           MAX(unique_visitors) AS unique_visitors,
           MAX(polled_at)       AS last_polled_at
    FROM snapshots
    GROUP BY app, date;
`
