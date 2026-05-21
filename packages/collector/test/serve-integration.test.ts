import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CollectorDb } from '../src/db.js'
import { reconcileApp } from '../src/reconcile.js'
import { startServer, type RunningServer } from '../src/serve/index.js'
import type { PollResponse } from '../src/types.js'

function seed(db: CollectorDb, app: string, todayCount: number) {
  const response: PollResponse = {
    today: { date: '2026-05-21', uniqueVisitors: todayCount },
    history: [{ date: '2026-05-20', uniqueVisitors: 50 }],
    generatedAt: '2026-05-21T12:00:00Z',
  }
  reconcileApp(db, {
    app,
    source: 'single',
    polledAt: '2026-05-21T12:00:01Z',
    response,
  })
}

describe('startServer integration', () => {
  let dbPath: string
  let server: RunningServer | null

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'swhsd-serve-int-'))
    dbPath = join(dir, 'c.db')
    server = null
  })

  afterEach(async () => {
    if (server) await server.close()
  })

  it('serves an empty-state HTML page when the DB has no rows', async () => {
    CollectorDb.open(dbPath).close()
    server = await startServer({ dbPath, host: '127.0.0.1', port: 0 })
    const res = await fetch(server.url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const body = await res.text()
    expect(body).toContain('No data yet')
  })

  it('serves a populated dashboard and matching /api/overview.json', async () => {
    const db = CollectorDb.open(dbPath)
    seed(db, 'blog', 12)
    db.close()
    server = await startServer({ dbPath, host: '127.0.0.1', port: 0 })

    const html = await (await fetch(server.url)).text()
    expect(html).toContain('blog')
    expect(html).toContain('<table')

    const json = (await (await fetch(`${server.url}/api/overview.json`)).json()) as {
      apps: Array<{ name: string; today: number }>
    }
    expect(json.apps[0]?.name).toBe('blog')
    expect(json.apps[0]?.today).toBe(12)
  })

  it('returns 404 for unknown paths', async () => {
    CollectorDb.open(dbPath).close()
    server = await startServer({ dbPath, host: '127.0.0.1', port: 0 })
    const res = await fetch(`${server.url}/nope`)
    expect(res.status).toBe(404)
  })

  it('rejects bind on a port already in use with a clear error', async () => {
    CollectorDb.open(dbPath).close()
    const first = await startServer({ dbPath, host: '127.0.0.1', port: 0 })
    const port = Number(new URL(first.url).port)
    await expect(
      startServer({ dbPath, host: '127.0.0.1', port }),
    ).rejects.toThrow(/EADDRINUSE|in use/)
    await first.close()
  })

  it('close() releases the socket so a follow-up bind on the same port succeeds', async () => {
    CollectorDb.open(dbPath).close()
    const first = await startServer({ dbPath, host: '127.0.0.1', port: 0 })
    const port = Number(new URL(first.url).port)
    await first.close()
    const second = await startServer({ dbPath, host: '127.0.0.1', port })
    await second.close()
  })
})
