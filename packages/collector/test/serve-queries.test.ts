import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CollectorDb } from '../src/db.js'
import { reconcileApp } from '../src/reconcile.js'
import { Queries } from '../src/serve/queries.js'
import type { PollResponse } from '../src/types.js'

function seed(db: CollectorDb, app: string, today: string, todayCount: number) {
  const response: PollResponse = {
    today: { date: today, uniqueVisitors: todayCount },
    history: [
      { date: '2026-05-18', uniqueVisitors: 50 },
      { date: '2026-05-19', uniqueVisitors: 60 },
      { date: '2026-05-20', uniqueVisitors: 70 },
    ],
    generatedAt: `${today}T12:00:00Z`,
  }
  reconcileApp(db, { app, source: 'single', polledAt: `${today}T12:00:01Z`, response })
}

describe('Queries', () => {
  let dbPath: string
  let writeDb: CollectorDb
  let queries: Queries | null
  let readHandle: Database.Database | null

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'swhsd-serve-queries-'))
    dbPath = join(dir, 'collector.db')
    writeDb = CollectorDb.open(dbPath)
    queries = null
    readHandle = null
  })

  afterEach(() => {
    queries?.close()
    writeDb.close()
  })

  function openReadonly() {
    readHandle = new Database(dbPath, { readonly: true, fileMustExist: true })
    queries = new Queries(readHandle)
    return queries
  }

  it('listApps returns empty array on a fresh DB', () => {
    expect(openReadonly().listApps()).toEqual([])
  })

  it('listApps returns distinct app names sorted ascending', () => {
    seed(writeDb, 'blog', '2026-05-21', 10)
    seed(writeDb, 'api', '2026-05-21', 20)
    seed(writeDb, 'api', '2026-05-21', 25)
    expect(openReadonly().listApps()).toEqual(['api', 'blog'])
  })

  it('getLatestToday returns the latest is_today row for that app', () => {
    seed(writeDb, 'blog', '2026-05-21', 10)
    seed(writeDb, 'blog', '2026-05-21', 22)
    const row = openReadonly().getLatestToday('blog')
    expect(row?.uniqueVisitors).toBe(22)
    expect(row?.polledAt).toBe('2026-05-21T12:00:01Z')
  })

  it('getLatestToday returns null when no rows for that app', () => {
    seed(writeDb, 'blog', '2026-05-21', 10)
    expect(openReadonly().getLatestToday('missing')).toBeNull()
  })

  it('getLastPolledAt returns the max polled_at across all snapshots for the app', () => {
    seed(writeDb, 'blog', '2026-05-21', 10)
    expect(openReadonly().getLastPolledAt('blog')).toBe('2026-05-21T12:00:01Z')
  })

  it('getLastPolledAt returns null for unknown app', () => {
    expect(openReadonly().getLastPolledAt('missing')).toBeNull()
  })

  it('getSeries30d returns rows on or after the cutoff date in ascending order', () => {
    seed(writeDb, 'blog', '2026-05-21', 10)
    const rows = openReadonly().getSeries30d('blog', '2026-04-22')
    expect(rows.map((r) => r.date)).toEqual([
      '2026-05-18',
      '2026-05-19',
      '2026-05-20',
      '2026-05-21',
    ])
    expect(rows[3]?.uniqueVisitors).toBe(10)
  })

  it('getSeries30d filters out dates earlier than the cutoff', () => {
    seed(writeDb, 'blog', '2026-05-21', 10)
    const rows = openReadonly().getSeries30d('blog', '2026-05-20')
    expect(rows.map((r) => r.date)).toEqual(['2026-05-20', '2026-05-21'])
  })
})
