import { describe, expect, it, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

import { handleStatsEndpoint } from '../src/endpoint.js'
import { VisitorStore } from '../src/store.js'
import type { StatsRuntime } from '../src/lifecycle.js'
import type { PersistAdapter } from '../src/snapshot.js'
import type { ResolvedConfig } from '../src/types.js'

const nullPersist: PersistAdapter = {
  load: () => null,
  save: () => {},
}

function makeRuntime(token = 'a-long-enough-token-for-this-test-xxxxxxx'): StatsRuntime {
  const config: ResolvedConfig = {
    token,
    snapshotPath: '(unused)',
    persist: nullPersist,
    flushIntervalMs: 60_000,
    endpointPath: '/stats',
    historyDays: 90,
    maxHistoryDays: 365,
    filterBots: true,
    trustProxy: 1,
  }
  return {
    config,
    store: VisitorStore.fresh('2026-04-07'),
    persist: nullPersist,
    flush: () => {},
    shutdown: () => {},
  }
}

const TOKEN = 'a-long-enough-token-for-this-test-xxxxxxx'

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
    runtime = makeRuntime(TOKEN)
  })

  it('returns 401 when no token is provided', () => {
    expect(handleStatsEndpoint(reqWithQuery(null), runtime).status).toBe(401)
  })

  it('returns 401 for the wrong token (query)', () => {
    expect(handleStatsEndpoint(reqWithQuery('nope'), runtime).status).toBe(401)
  })

  it('returns 401 for a wrong-length token', () => {
    expect(handleStatsEndpoint(reqWithQuery('a'), runtime).status).toBe(401)
  })

  it('returns 401 for a bogus Authorization header', () => {
    expect(handleStatsEndpoint(reqWithAuth('Bearer nope'), runtime).status).toBe(401)
  })

  it('returns 401 for an Authorization header without the Bearer prefix', () => {
    expect(handleStatsEndpoint(reqWithAuth(TOKEN), runtime).status).toBe(401)
  })

  it('returns 200 with the expected JSON shape for a correct token (query)', async () => {
    runtime.store.track('1.1.1.1', 'ua-a')
    runtime.store.track('2.2.2.2', 'ua-b')

    const res = handleStatsEndpoint(reqWithQuery(TOKEN), runtime)
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

  it('accepts the token via Authorization: Bearer', () => {
    const res = handleStatsEndpoint(reqWithAuth(`Bearer ${TOKEN}`), runtime)
    expect(res.status).toBe(200)
  })

  it('accepts the Bearer prefix case-insensitively', () => {
    const res = handleStatsEndpoint(reqWithAuth(`bearer ${TOKEN}`), runtime)
    expect(res.status).toBe(200)
  })

  it('prefers the Authorization header over the query string', () => {
    // Authorization is correct, query is wrong. Should accept the header.
    const req = new NextRequest(`http://x.test/stats?t=wrong`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(handleStatsEndpoint(req, runtime).status).toBe(200)
  })
})
