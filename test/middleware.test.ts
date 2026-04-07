import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'

import { createMiddleware } from '../src/middleware.js'
import type { StatsRuntime } from '../src/lifecycle.js'

function makeReq(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://x.test${path}`, { headers })
}

function currentRuntime(): StatsRuntime {
  return (globalThis as { __statswhatshesaid__?: StatsRuntime }).__statswhatshesaid__!
}

describe('createMiddleware', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'statswhatshesaid-mw-'))
    process.env.STATS_TOKEN = 'secret'
    process.env.STATS_SNAPSHOT_PATH = join(tmpDir, 'stats.json')
    ;(globalThis as { __statswhatshesaid__?: unknown }).__statswhatshesaid__ = undefined
  })
  afterEach(() => {
    currentRuntime()?.shutdown()
    ;(globalThis as { __statswhatshesaid__?: unknown }).__statswhatshesaid__ = undefined
    delete process.env.STATS_SNAPSHOT_PATH
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes non-/stats requests through and increments the counter', async () => {
    const mw = createMiddleware()
    const res = await mw(
      makeReq('/', { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '1.1.1.1' }),
    )
    expect(res.status).toBe(200)
    expect(currentRuntime().store.estimateToday()).toBe(1)
  })

  it('dedupes the same visitor', async () => {
    const mw = createMiddleware()
    const headers = { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '2.2.2.2' }
    await mw(makeReq('/', headers))
    await mw(makeReq('/about', headers))
    await mw(makeReq('/contact', headers))
    expect(currentRuntime().store.estimateToday()).toBe(1)
  })

  it('counts distinct visitors separately', async () => {
    const mw = createMiddleware()
    await mw(makeReq('/', { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '3.3.3.3' }))
    await mw(makeReq('/', { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '4.4.4.4' }))
    expect(currentRuntime().store.estimateToday()).toBe(2)
  })

  it('skips bot user agents when filterBots is true', async () => {
    const mw = createMiddleware()
    await mw(makeReq('/', { 'user-agent': 'Googlebot/2.1', 'x-forwarded-for': '5.5.5.5' }))
    await mw(makeReq('/', { 'user-agent': 'curl/8.0', 'x-forwarded-for': '6.6.6.6' }))
    expect(currentRuntime().store.estimateToday()).toBe(0)
  })

  it('counts bots when filterBots is false', async () => {
    const mw = createMiddleware({ filterBots: false })
    await mw(makeReq('/', { 'user-agent': 'Googlebot/2.1', 'x-forwarded-for': '5.5.5.5' }))
    expect(currentRuntime().store.estimateToday()).toBe(1)
  })

  it('short-circuits to the stats endpoint with a correct token', async () => {
    const mw = createMiddleware()
    const res = await mw(makeReq('/stats?t=secret'))
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

  it('throws a clear error when STATS_TOKEN is missing', () => {
    delete process.env.STATS_TOKEN
    const mw = createMiddleware()
    expect(() => mw(makeReq('/'))).toThrow(/STATS_TOKEN/)
  })

  it('persists state across a simulated restart', async () => {
    const mw1 = createMiddleware()
    await mw1(makeReq('/', { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '7.7.7.7' }))
    await mw1(makeReq('/', { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '8.8.8.8' }))
    const before = currentRuntime().store.estimateToday()
    expect(before).toBe(2)

    // Simulate a restart: flush, shutdown, wipe the singleton, re-create.
    currentRuntime().flush()
    currentRuntime().shutdown()
    ;(globalThis as { __statswhatshesaid__?: unknown }).__statswhatshesaid__ = undefined

    const mw2 = createMiddleware()
    // Just initializing should restore the snapshot.
    await mw2(makeReq('/stats?t=secret')) // lazy init + read
    expect(currentRuntime().store.estimateToday()).toBe(2)

    // The original visitors should still be considered seen.
    await mw2(makeReq('/', { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '7.7.7.7' }))
    expect(currentRuntime().store.estimateToday()).toBe(2)
  })
})
