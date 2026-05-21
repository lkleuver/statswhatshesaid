import type Database from 'better-sqlite3'

export interface TodayRow {
  uniqueVisitors: number
  polledAt: string
}

export interface SeriesPoint {
  date: string
  uniqueVisitors: number
}

/**
 * Read-only access layer over the collector's SQLite database. Owns the
 * prepared statements the dashboard needs. Constructed once at server
 * startup; not safe to share across DB handles.
 */
export class Queries {
  private readonly stmtListApps: Database.Statement
  private readonly stmtSeries30d: Database.Statement
  private readonly stmtLatestToday: Database.Statement
  private readonly stmtLastPolled: Database.Statement
  private readonly handle: Database.Database

  constructor(db: Database.Database) {
    this.handle = db
    this.stmtListApps = db.prepare(
      `SELECT DISTINCT app FROM snapshots ORDER BY app`,
    )
    this.stmtSeries30d = db.prepare(
      `SELECT date, unique_visitors AS uniqueVisitors
       FROM daily
       WHERE app = ? AND date >= ?
       ORDER BY date`,
    )
    this.stmtLatestToday = db.prepare(
      `SELECT unique_visitors AS uniqueVisitors, polled_at AS polledAt
       FROM snapshots
       WHERE app = ? AND is_today = 1
       ORDER BY polled_at DESC, id DESC
       LIMIT 1`,
    )
    this.stmtLastPolled = db.prepare(
      `SELECT MAX(polled_at) AS polledAt
       FROM snapshots
       WHERE app = ?`,
    )
  }

  listApps(): string[] {
    return (this.stmtListApps.all() as Array<{ app: string }>).map((r) => r.app)
  }

  getSeries30d(app: string, cutoffDate: string): SeriesPoint[] {
    return this.stmtSeries30d.all(app, cutoffDate) as SeriesPoint[]
  }

  getLatestToday(app: string): TodayRow | null {
    const row = this.stmtLatestToday.get(app) as TodayRow | undefined
    return row ?? null
  }

  getLastPolledAt(app: string): string | null {
    const row = this.stmtLastPolled.get(app) as { polledAt: string | null } | undefined
    return row?.polledAt ?? null
  }

  close(): void {
    this.handle.close()
  }
}
