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

function makeRuntime(token = 'secret'): StatsRuntime {
  const config: ResolvedConfig = {
    token,
    snapshotPath: '(unused)',
    persist: nullPersist,
    flushIntervalMs: 60_000,
    endpointPath: '/stats',
    historyDays: 90,
    maxHistoryDays: 365,
    filterBots: true,
  }
  return {
    config,
    store: VisitorStore.fresh('2026-04-07'),
    persist: nullPersist,
    flush: () => {},
    shutdown: () => {},
  }
}

function reqWithToken(token: string | null): NextRequest {
  const url = token === null ? 'http://x.test/stats' : `http://x.test/stats?t=${token}`
  return new NextRequest(url)
}

describe('handleStatsEndpoint', () => {
  let runtime: StatsRuntime
  beforeEach(() => {
    runtime = makeRuntime('secret')
  })

  it('returns 401 when no token is provided', () => {
    expect(handleStatsEndpoint(reqWithToken(null), runtime).status).toBe(401)
  })

  it('returns 401 for the wrong token', () => {
    expect(handleStatsEndpoint(reqWithToken('nope'), runtime).status).toBe(401)
  })

  it('returns 401 for a wrong-length token (timing-safe path)', () => {
    expect(handleStatsEndpoint(reqWithToken('a'), runtime).status).toBe(401)
  })

  it('returns 200 with the expected JSON shape for a correct token', async () => {
    runtime.store.track('1.1.1.1', 'ua-a')
    runtime.store.track('2.2.2.2', 'ua-b')

    const res = handleStatsEndpoint(reqWithToken('secret'), runtime)
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
})
