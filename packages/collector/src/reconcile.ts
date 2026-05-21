import type { CollectorDb } from './db.js'
import type { PollResponse } from './types.js'

export interface ReconcileResult {
  todayInserted: boolean
  historyRowsInserted: number
}

export interface ReconcileOptions {
  app: string
  source: 'single' | 'merged'
  polledAt: string
  response: PollResponse
  keepRaw?: boolean
}

/**
 * Persist one poll cycle's data for one app. Writes one `today` row plus
 * one row per historical date returned (idempotent — past-day rows use
 * INSERT OR IGNORE keyed on (app, date) for is_today=0).
 *
 * All writes happen inside a single transaction so a mid-cycle crash
 * leaves the DB unchanged.
 */
export function reconcileApp(
  db: CollectorDb,
  opts: ReconcileOptions,
): ReconcileResult {
  return db.transaction(() => {
    const { app, source, polledAt, response, keepRaw } = opts
    const raw = keepRaw ? JSON.stringify(response) : null

    db.insertSnapshot.run(
      app,
      response.today.date,
      response.today.uniqueVisitors,
      source,
      polledAt,
      response.generatedAt,
      1, // is_today
      raw,
    )
    let historyRowsInserted = 0
    for (const day of response.history) {
      const result = db.insertHistorySnapshot.run(
        app,
        day.date,
        day.uniqueVisitors,
        source,
        polledAt,
      )
      if (result.changes > 0) historyRowsInserted++
    }
    return { todayInserted: true, historyRowsInserted }
  })
}
