import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CollectorDb } from '../src/db.js'
import { reconcileApp } from '../src/reconcile.js'
import { Queries } from '../src/serve/queries.js'
import {
  handleOverviewJson,
  handlePageHtml,
  buildOverview,
} from '../src/serve/handlers.js'
import type { PollResponse } from '../src/types.js'

function seed(db: CollectorDb, app: string, today: string, todayCount: number) {
  const response: PollResponse = {
    today: { date: today, uniqueVisitors: todayCount },
    history: [
      { date: '2026-05-19', uniqueVisitors: 60 },
      { date: '2026-05-20', uniqueVisitors: 70 },
    ],
    generatedAt: `${today}T12:00:00Z`,
  }
  reconcileApp(db, {
    app,
    source: 'single',
    polledAt: `${today}T12:00:01Z`,
    response,
  })
}

describe('handlers', () => {
  let dbPath: string
  let writeDb: CollectorDb
  let queries: Queries | null
  let readHandle: Database.Database | null
  const now = () => new Date('2026-05-21T12:00:30Z')

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'swhsd-handlers-'))
    dbPath = join(dir, 'c.db')
    writeDb = CollectorDb.open(dbPath)
    queries = null
    readHandle = null
  })

  afterEach(() => {
    queries?.close()
    writeDb.close()
  })

  function open() {
    readHandle = new Database(dbPath, { readonly: true, fileMustExist: true })
    queries = new Queries(readHandle)
    return queries
  }

  it('buildOverview returns empty apps[] for a fresh DB', () => {
    const overview = buildOverview({ queries: open(), now, dbPath })
    expect(overview.apps).toEqual([])
    expect(overview.dbPath).toBe(dbPath)
    expect(overview.generatedAt).toBe('2026-05-21T12:00:30.000Z')
  })

  it('buildOverview zero-fills missing dates in the 30-day series', () => {
    seed(writeDb, 'blog', '2026-05-21', 42)
    const overview = buildOverview({ queries: open(), now, dbPath })
    const blog = overview.apps.find((a) => a.name === 'blog')!
    expect(blog.series30d).toHaveLength(30)
    expect(blog.series30d[0]?.date).toBe('2026-04-22')
    expect(blog.series30d[29]?.date).toBe('2026-05-21')
    expect(blog.series30d[27]?.uniqueVisitors).toBe(60)
    expect(blog.series30d[28]?.uniqueVisitors).toBe(70)
    expect(blog.series30d[29]?.uniqueVisitors).toBe(42)
    expect(blog.series30d[0]?.uniqueVisitors).toBe(0)
    expect(blog.total30d).toBe(60 + 70 + 42)
    expect(blog.today).toBe(42)
    expect(blog.lastPolledAt).toBe('2026-05-21T12:00:01Z')
  })

  it('handleOverviewJson returns 200 + application/json + valid JSON body', () => {
    seed(writeDb, 'blog', '2026-05-21', 7)
    const res = handleOverviewJson({ queries: open(), now, dbPath })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    const parsed = JSON.parse(res.body)
    expect(parsed.apps[0].name).toBe('blog')
  })

  it('handlePageHtml returns 200 + text/html and contains an app name', () => {
    seed(writeDb, 'api', '2026-05-21', 9)
    const res = handlePageHtml({ queries: open(), now, dbPath })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('api')
    expect(res.body).toContain('<!doctype html>')
  })
})
