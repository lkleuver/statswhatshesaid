import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'

import { createMiddleware } from '../src/middleware.js'
import type { StatsRuntime } from '../src/lifecycle.js'

const TOKEN = 'a-long-enough-token-for-this-test-xxxxxxx'

function makeReq(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://x.test${path}`, { headers })
}

function currentRuntime(): StatsRuntime | undefined {
  return (globalThis as { __statswhatshesaid__?: StatsRuntime }).__statswhatshesaid__
}

function wipeSingleton(): void {
  ;(globalThis as { __statswhatshesaid__?: unknown }).__statswhatshesaid__ = undefined
}

describe('createMiddleware', () => {
  beforeEach(() => {
    process.env.STATS_TOKEN = TOKEN
    wipeSingleton()
  })
  afterEach(() => {
    wipeSingleton()
  })

  it('passes non-/stats requests through and increments the counter', async () => {
    const mw = createMiddleware()
    const res = await mw(
      makeReq('/', { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '1.1.1.1' }),
    )
    expect(res.status).toBe(200)
    expect(currentRuntime()!.store.estimateToday()).toBe(1)
  })

  it('dedupes the same visitor', async () => {
    const mw = createMiddleware()
    const headers = { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '2.2.2.2' }
    await mw(makeReq('/', headers))
    await mw(makeReq('/about', headers))
    await mw(makeReq('/contact', headers))
    expect(currentRuntime()!.store.estimateToday()).toBe(1)
  })

  it('counts distinct visitors separately', async () => {
    const mw = createMiddleware()
    await mw(makeReq('/', { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '3.3.3.3' }))
    await mw(makeReq('/', { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '4.4.4.4' }))
    expect(currentRuntime()!.store.estimateToday()).toBe(2)
  })

  it('skips bot user agents when filterBots is true', async () => {
    const mw = createMiddleware()
    await mw(makeReq('/', { 'user-agent': 'Googlebot/2.1', 'x-forwarded-for': '5.5.5.5' }))
    await mw(makeReq('/', { 'user-agent': 'curl/8.0', 'x-forwarded-for': '6.6.6.6' }))
    expect(currentRuntime()!.store.estimateToday()).toBe(0)
  })

  it('counts bots when filterBots is false', async () => {
    const mw = createMiddleware({ filterBots: false })
    await mw(makeReq('/', { 'user-agent': 'Googlebot/2.1', 'x-forwarded-for': '5.5.5.5' }))
    expect(currentRuntime()!.store.estimateToday()).toBe(1)
  })

  it('skips static paths without tracking', async () => {
    const mw = createMiddleware()
    await mw(makeReq('/_next/static/chunks/main.js', {
      'user-agent': 'Mozilla', 'x-forwarded-for': '1.1.1.1',
    }))
    await mw(makeReq('/favicon.ico', {
      'user-agent': 'Mozilla', 'x-forwarded-for': '2.2.2.2',
    }))
    await mw(makeReq('/robots.txt', {
      'user-agent': 'Mozilla', 'x-forwarded-for': '3.3.3.3',
    }))
    expect(currentRuntime()!.store.estimateToday()).toBe(0)
  })

  it('short-circuits to the stats endpoint with a correct token', async () => {
    const mw = createMiddleware()
    const res = await mw(makeReq(`/stats?t=${TOKEN}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(0)
  })

  it('returns 401 from the stats endpoint with the wrong token', async () => {
    const mw = createMiddleware()
    const res = await mw(makeReq('/stats?t=wrong'))
    expect(res.status).toBe(401)
  })

  it('throws a clear error when STATS_TOKEN is missing', async () => {
    delete process.env.STATS_TOKEN
    const mw = createMiddleware()
    await expect(mw(makeReq('/'))).rejects.toThrow(/STATS_TOKEN/)
  })
})
