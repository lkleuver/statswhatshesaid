import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CollectorDb } from '../src/db.js'
import { runOnce } from '../src/run.js'
import type { PollResponse, ResolvedConfig } from '../src/types.js'

interface FakeApp {
  server: Server
  url: string
  setResponse: (next: PollResponse | 'error') => void
  setStatus: (status: number) => void
}

async function startFakeApp(initial: PollResponse): Promise<FakeApp> {
  let response: PollResponse | 'error' = initial
  let status = 200
  const server = createServer((_req, res: ServerResponse) => {
    if (response === 'error') {
      res.destroy()
      return
    }
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(response))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server address')
  return {
    server,
    url: `http://127.0.0.1:${addr.port}/stats`,
    setResponse: (next) => {
      response = next
    },
    setStatus: (next) => {
      status = next
    },
  }
}

function stop(app: FakeApp): Promise<void> {
  return new Promise((resolve) => app.server.close(() => resolve()))
}

function makeDb(): { db: CollectorDb; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'swhsd-collector-run-'))
  const path = join(dir, 'c.db')
  return { db: CollectorDb.open(path), path }
}

describe('runOnce', () => {
  let app: FakeApp
  let db: ReturnType<typeof makeDb>

  beforeEach(async () => {
    app = await startFakeApp({
      today: { date: '2026-04-07', uniqueVisitors: 12 },
      history: [{ date: '2026-04-06', uniqueVisitors: 88 }],
      generatedAt: '2026-04-07T12:00:00Z',
    })
    db = makeDb()
  })

  afterEach(async () => {
    db.db.close()
    await stop(app)
  })

  function configWith(url: string): ResolvedConfig {
    return {
      dbPath: db.path,
      apps: [
        {
          kind: 'single',
          name: 'fake',
          url,
          token: 'a'.repeat(32),
          timeoutMs: 5000,
          userAgent: 'swhsd-test',
        },
      ],
    }
  }

  it('records today + history when the app responds OK', async () => {
    const result = await runOnce({ config: configWith(app.url), db: db.db })
    expect(result.outcomes).toEqual([
      { app: 'fake', status: 'ok', today: 12, historyRows: 1 },
    ])

    const rows = db.db.db
      .prepare(`SELECT date, unique_visitors, is_today FROM snapshots ORDER BY date`)
      .all()
    expect(rows).toEqual([
      { date: '2026-04-06', unique_visitors: 88, is_today: 0 },
      { date: '2026-04-07', unique_visitors: 12, is_today: 1 },
    ])
  })

  it('dry-run does not write any rows', async () => {
    const result = await runOnce({
      config: configWith(app.url),
      db: db.db,
      dryRun: true,
    })
    expect(result.outcomes[0]?.status).toBe('ok')
    const count = db.db.db.prepare(`SELECT COUNT(*) AS c FROM snapshots`).get() as { c: number }
    expect(count.c).toBe(0)
  })

  it('marks the cycle FAILED on HTTP 401', async () => {
    app.setStatus(401)
    const result = await runOnce({ config: configWith(app.url), db: db.db })
    expect(result.outcomes[0]?.status).toBe('failed')
    if (result.outcomes[0]?.status === 'failed') {
      expect(result.outcomes[0].reason).toMatch(/401/)
    }
  })

  it('marks the cycle FAILED on network error', async () => {
    app.setResponse('error')
    const result = await runOnce({ config: configWith(app.url), db: db.db })
    expect(result.outcomes[0]?.status).toBe('failed')
  })

  it('continues to other apps when one fails', async () => {
    const goodApp = await startFakeApp({
      today: { date: '2026-04-07', uniqueVisitors: 5 },
      history: [],
      generatedAt: '2026-04-07T12:00:00Z',
    })
    app.setStatus(500)

    const cfg: ResolvedConfig = {
      dbPath: db.path,
      apps: [
        { kind: 'single', name: 'broken', url: app.url, token: 'a'.repeat(32), timeoutMs: 2000, userAgent: 'swhsd-test' },
        { kind: 'single', name: 'good', url: goodApp.url, token: 'a'.repeat(32), timeoutMs: 2000, userAgent: 'swhsd-test' },
      ],
    }
    const result = await runOnce({ config: cfg, db: db.db })
    expect(result.outcomes.map((o) => o.status).sort()).toEqual(['failed', 'ok'])
    await stop(goodApp)
  })

  it('marks replicated apps as FAILED when replicas are unreachable', async () => {
    const cfg: ResolvedConfig = {
      dbPath: db.path,
      apps: [
        {
          kind: 'replicated',
          name: 'api',
          // Hit a guaranteed-unbound port so the request immediately fails
          // instead of waiting for DNS / a real network round trip.
          replicas: ['http://127.0.0.1:1/stats', 'http://127.0.0.1:2/stats'],
          token: 'a'.repeat(32),
          timeoutMs: 500,
          userAgent: 'swhsd-test',
        },
      ],
    }
    const result = await runOnce({ config: cfg, db: db.db })
    expect(result.outcomes[0]?.status).toBe('failed')
  })
})
