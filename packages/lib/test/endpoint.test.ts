import { describe, expect, it, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

import { handleStatsEndpoint } from '../src/endpoint.js'
import { VisitorStore } from '../src/store.js'
import type { StatsRuntime } from '../src/lifecycle.js'
import type { ResolvedConfig } from '../src/types.js'

const TOKEN = 'a-long-enough-token-for-this-test-xxxxxxx'

function makeRuntime(token = TOKEN, saltSecret: string | null = null): StatsRuntime {
  const config: ResolvedConfig = {
    token,
    endpointPath: '/stats',
    historyDays: 90,
    maxHistoryDays: 365,
    filterBots: true,
    trustProxy: 1,
    saltSecret,
  }
  return {
    config,
    store: VisitorStore.fresh('2026-04-07', saltSecret),
  }
}

function reqWithQuery(token: string | null): NextRequest {
  const url = token === null ? 'http://x.test/stats' : `http://x.test/stats?t=${token}`
  return new NextRequest(url)
}

function reqWithAuth(header: string): NextRequest {
  return new NextRequest('http://x.test/stats', {
    headers: { authorization: header },
  })
}

describe('handleStatsEndpoint', () => {
  let runtime: StatsRuntime
  beforeEach(() => {
    runtime = makeRuntime()
  })

  it('returns 401 when no token is provided', async () => {
    expect((await handleStatsEndpoint(reqWithQuery(null), runtime)).status).toBe(401)
  })

  it('returns 401 for the wrong token (query)', async () => {
    expect((await handleStatsEndpoint(reqWithQuery('nope'), runtime)).status).toBe(401)
  })

  it('returns 401 for a wrong-length token', async () => {
    expect((await handleStatsEndpoint(reqWithQuery('a'), runtime)).status).toBe(401)
  })

  it('returns 401 for a bogus Authorization header', async () => {
    expect((await handleStatsEndpoint(reqWithAuth('Bearer nope'), runtime)).status).toBe(401)
  })

  it('returns 401 for an Authorization header without the Bearer prefix', async () => {
    expect((await handleStatsEndpoint(reqWithAuth(TOKEN), runtime)).status).toBe(401)
  })

  it('returns 200 with the expected JSON shape for a correct token (query)', async () => {
    await runtime.store.track('1.1.1.1', 'ua-a')
    await runtime.store.track('2.2.2.2', 'ua-b')

    const res = await handleStatsEndpoint(reqWithQuery(TOKEN), runtime)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = (await res.json()) as {
      today: { date: string; uniqueVisitors: number }
      history: unknown[]
      generatedAt: string
    }
    expect(body.today.uniqueVisitors).toBe(2)
    expect(body.today.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Array.isArray(body.history)).toBe(true)
    expect(typeof body.generatedAt).toBe('string')
  })

  it('accepts the token via Authorization: Bearer', async () => {
    expect((await handleStatsEndpoint(reqWithAuth(`Bearer ${TOKEN}`), runtime)).status).toBe(200)
  })

  it('accepts the Bearer prefix case-insensitively', async () => {
    expect((await handleStatsEndpoint(reqWithAuth(`bearer ${TOKEN}`), runtime)).status).toBe(200)
  })

  it('prefers the Authorization header over the query string', async () => {
    const req = new NextRequest(`http://x.test/stats?t=wrong`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect((await handleStatsEndpoint(req, runtime)).status).toBe(200)
  })
})

describe('handleStatsEndpoint ?format=raw', () => {
  it('omits sketch and saltFingerprint when shared-salt mode is OFF', async () => {
    const runtime = makeRuntime(TOKEN, null)
    const req = new NextRequest(`http://x.test/stats?t=${TOKEN}&format=raw`)
    const res = await handleStatsEndpoint(req, runtime)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      today: { sketch?: string; saltFingerprint?: string }
    }
    expect(body.today.sketch).toBeUndefined()
    expect(body.today.saltFingerprint).toBeUndefined()
  })

  it('returns sketch and saltFingerprint when shared-salt mode is ON', async () => {
    const runtime = makeRuntime(TOKEN, 'a-strong-shared-salt-secret-xxxxxxxxxxxx')
    await runtime.store.track('1.1.1.1', 'ua-a')
    const req = new NextRequest(`http://x.test/stats?t=${TOKEN}&format=raw`)
    const res = await handleStatsEndpoint(req, runtime)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      today: {
        date: string
        uniqueVisitors: number
        sketch?: string
        saltFingerprint?: string
      }
    }
    expect(body.today.uniqueVisitors).toBe(1)
    expect(body.today.sketch).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(body.today.saltFingerprint).toMatch(/^[0-9a-f]{16}$/)
  })

  it('two stores with the same secret produce the same saltFingerprint for the same date', async () => {
    const secret = 'shared-secret-across-replicas-xxxxxxxxxxxxx'
    const a = makeRuntime(TOKEN, secret)
    const b = makeRuntime(TOKEN, secret)
    // Force salts to materialize.
    await a.store.track('1.1.1.1', 'ua')
    await b.store.track('2.2.2.2', 'ua')

    const fpA = await a.store.exposeTodaySketch()
    const fpB = await b.store.exposeTodaySketch()
    expect(fpA.saltFingerprint).toBe(fpB.saltFingerprint)
  })

  it('omits sketch when ?format=raw is not requested', async () => {
    const runtime = makeRuntime(TOKEN, 'a-strong-shared-salt-secret-xxxxxxxxxxxx')
    const req = new NextRequest(`http://x.test/stats?t=${TOKEN}`)
    const res = await handleStatsEndpoint(req, runtime)
    const body = (await res.json()) as {
      today: { sketch?: string; saltFingerprint?: string }
    }
    expect(body.today.sketch).toBeUndefined()
    expect(body.today.saltFingerprint).toBeUndefined()
  })
})
