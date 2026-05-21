import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CollectorDb } from '../src/db.js'
import { reconcileApp } from '../src/reconcile.js'
import type { PollResponse } from '../src/types.js'

function freshResponse(today: string, todayCount: number): PollResponse {
  return {
    today: { date: today, uniqueVisitors: todayCount },
    history: [
      { date: '2026-04-06', uniqueVisitors: 100 },
      { date: '2026-04-05', uniqueVisitors: 95 },
    ],
    generatedAt: '2026-04-07T12:00:00Z',
  }
}

describe('reconcileApp', () => {
  let dbPath: string
  let db: CollectorDb

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'swhsd-collector-recon-'))
    dbPath = join(dir, 'collector.db')
    db = CollectorDb.open(dbPath)
  })

  afterEach(() => {
    db.close()
  })

  it('inserts one today row and two history rows on first poll', () => {
    const result = reconcileApp(db, {
      app: 'blog',
      source: 'single',
      polledAt: '2026-04-07T12:00:01Z',
      response: freshResponse('2026-04-07', 50),
    })
    expect(result.todayInserted).toBe(true)
    expect(result.historyRowsInserted).toBe(2)

    const rows = db.db
      .prepare('SELECT app, date, unique_visitors, is_today FROM snapshots ORDER BY date')
      .all()
    expect(rows).toEqual([
      { app: 'blog', date: '2026-04-05', unique_visitors: 95, is_today: 0 },
      { app: 'blog', date: '2026-04-06', unique_visitors: 100, is_today: 0 },
      { app: 'blog', date: '2026-04-07', unique_visitors: 50, is_today: 1 },
    ])
  })

  it('is idempotent on history rows across repeated polls', () => {
    reconcileApp(db, {
      app: 'blog',
      source: 'single',
      polledAt: '2026-04-07T12:00:01Z',
      response: freshResponse('2026-04-07', 50),
    })
    const second = reconcileApp(db, {
      app: 'blog',
      source: 'single',
      polledAt: '2026-04-07T12:15:01Z',
      response: freshResponse('2026-04-07', 62), // today count grew
    })
    expect(second.historyRowsInserted).toBe(0)

    const historyCount = db.db
      .prepare('SELECT COUNT(*) AS c FROM snapshots WHERE is_today = 0')
      .get() as { c: number }
    expect(historyCount.c).toBe(2)

    const todayCount = db.db
      .prepare('SELECT COUNT(*) AS c FROM snapshots WHERE is_today = 1')
      .get() as { c: number }
    expect(todayCount.c).toBe(2)
  })

  it('the daily view returns max unique_visitors per (app, date)', () => {
    reconcileApp(db, {
      app: 'blog',
      source: 'single',
      polledAt: '2026-04-07T12:00:01Z',
      response: freshResponse('2026-04-07', 50),
    })
    reconcileApp(db, {
      app: 'blog',
      source: 'single',
      polledAt: '2026-04-07T13:00:01Z',
      response: freshResponse('2026-04-07', 75),
    })

    const today = db.db
      .prepare(`SELECT unique_visitors FROM daily WHERE app = 'blog' AND date = '2026-04-07'`)
      .get() as { unique_visitors: number }
    expect(today.unique_visitors).toBe(75)
  })

  it('keepRaw stores the response JSON in the raw column', () => {
    reconcileApp(db, {
      app: 'blog',
      source: 'single',
      polledAt: '2026-04-07T12:00:01Z',
      response: freshResponse('2026-04-07', 50),
      keepRaw: true,
    })
    const row = db.db
      .prepare(`SELECT raw FROM snapshots WHERE is_today = 1`)
      .get() as { raw: string }
    expect(JSON.parse(row.raw)).toMatchObject({
      today: { date: '2026-04-07', uniqueVisitors: 50 },
    })
  })

  it('writes source=merged when the caller passes it', () => {
    reconcileApp(db, {
      app: 'api',
      source: 'merged',
      polledAt: '2026-04-07T12:00:01Z',
      response: freshResponse('2026-04-07', 50),
    })
    const row = db.db
      .prepare(`SELECT source FROM snapshots WHERE is_today = 1`)
      .get() as { source: string }
    expect(row.source).toBe('merged')
  })
})
