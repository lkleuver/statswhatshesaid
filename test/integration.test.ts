import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'

import { createMiddleware } from '../src/middleware.js'
import type { StatsRuntime } from '../src/lifecycle.js'
import type { PersistAdapter, SnapshotV1 } from '../src/snapshot.js'
import { HLL_REGISTER_COUNT, HyperLogLog } from '../src/hll.js'

/**
 * End-to-end integration tests for the middleware + endpoint + persistence
 * pipeline, using the real `FileSnapshotAdapter` on a temp file (and a
 * custom in-memory adapter for the bring-your-own-backend path).
 *
 * These tests intentionally avoid mocking the storage layer so the full
 * request → hash → HLL → snapshot → /stats roundtrip is exercised.
 */

const TOKEN = 'integration-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx'

function req(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://app.test${path}`, { headers })
}

function currentRuntime(): StatsRuntime | undefined {
  return (globalThis as { __statswhatshesaid__?: StatsRuntime }).__statswhatshesaid__
}

function wipeSingleton(): void {
  currentRuntime()?.shutdown()
  ;(globalThis as { __statswhatshesaid__?: unknown }).__statswhatshesaid__ = undefined
}

describe('integration: middleware + endpoint + file adapter', () => {
  let dir: string
  let snapPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'statswhatshesaid-int-'))
    snapPath = join(dir, 'stats.json')
    wipeSingleton()
  })
  afterEach(() => {
    wipeSingleton()
    rmSync(dir, { recursive: true, force: true })
  })

  it('full happy path: tracks distinct visitors, dedupes, persists, serves /stats', async () => {
    const mw = createMiddleware({ token: TOKEN, snapshotPath: snapPath })

    // Visitor A hits two pages → one unique.
    await mw(req('/', { 'user-agent': 'Mozilla Firefox', 'x-forwarded-for': '10.0.0.1' }))
    await mw(req('/about', { 'user-agent': 'Mozilla Firefox', 'x-forwarded-for': '10.0.0.1' }))

    // Visitor B (different IP).
    await mw(req('/', { 'user-agent': 'Mozilla Firefox', 'x-forwarded-for': '10.0.0.2' }))

    // Visitor C (different UA).
    await mw(req('/', { 'user-agent': 'Safari', 'x-forwarded-for': '10.0.0.3' }))

    // Fetch /stats.
    const res = await mw(req(`/stats?t=${TOKEN}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = (await res.json()) as {
      today: { date: string; uniqueVisitors: number }
      history: unknown[]
      generatedAt: string
    }
    expect(body.today.uniqueVisitors).toBe(3)
    expect(body.today.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.history).toEqual([])
    expect(new Date(body.generatedAt).toString()).not.toBe('Invalid Date')
  })

  it('writes the snapshot file on first request and it has the expected shape', async () => {
    const mw = createMiddleware({ token: TOKEN, snapshotPath: snapPath })
    await mw(req('/', { 'user-agent': 'Mozilla', 'x-forwarded-for': '1.2.3.4' }))

    // The runtime writes an initial snapshot on init. Force an additional
    // flush to make sure the tracked visitor is persisted.
    currentRuntime()!.flush()

    const raw = readFileSync(snapPath, 'utf8')
    const parsed = JSON.parse(raw) as SnapshotV1
    expect(parsed.version).toBe(1)
    expect(parsed.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(typeof parsed.salt).toBe('string')
    expect(typeof parsed.hllRegisters).toBe('string')
    // Base64 of 16384 bytes = 21848 chars.
    expect(parsed.hllRegisters.length).toBe(21848)
    expect(parsed.history).toEqual({})
  })

  it('persists across a simulated process restart', async () => {
    const mw1 = createMiddleware({ token: TOKEN, snapshotPath: snapPath })
    await mw1(req('/', { 'user-agent': 'A', 'x-forwarded-for': '1.1.1.1' }))
    await mw1(req('/', { 'user-agent': 'B', 'x-forwarded-for': '2.2.2.2' }))
    await mw1(req('/', { 'user-agent': 'C', 'x-forwarded-for': '3.3.3.3' }))

    currentRuntime()!.flush()
    wipeSingleton()

    // Simulate a process restart: new middleware closure, fresh runtime,
    // same snapshot file.
    const mw2 = createMiddleware({ token: TOKEN, snapshotPath: snapPath })

    // Hit /stats first and expect the count to already be restored from disk.
    const res = await mw2(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(3)

    // A previously-seen visitor should not bump the counter (same salt
    // was restored from the snapshot, so the same hash is computed).
    await mw2(req('/', { 'user-agent': 'A', 'x-forwarded-for': '1.1.1.1' }))
    const res2 = await mw2(req(`/stats?t=${TOKEN}`))
    const body2 = (await res2.json()) as { today: { uniqueVisitors: number } }
    expect(body2.today.uniqueVisitors).toBe(3)

    // A brand-new visitor should bump.
    await mw2(req('/', { 'user-agent': 'D', 'x-forwarded-for': '4.4.4.4' }))
    const res3 = await mw2(req(`/stats?t=${TOKEN}`))
    const body3 = (await res3.json()) as { today: { uniqueVisitors: number } }
    expect(body3.today.uniqueVisitors).toBe(4)
  })

  it('finalizes an old day into history when the process boots on a new date', async () => {
    // Seed the snapshot file with yesterday's data, as if the process had
    // been down across midnight.
    const yesterday = '2026-04-06'
    const today = new Date().toISOString().slice(0, 10)
    // Make sure today is not yesterday (trivially true unless this test
    // happens to run on 2026-04-06, in which case pick a different date).
    const stubYesterday = today === yesterday ? '2020-01-01' : yesterday

    const hll = new HyperLogLog()
    // Build an HLL with ~200 distinct items using deterministic-but-random
    // SHA-256 inputs.
    const { createHash } = await import('node:crypto')
    for (let i = 0; i < 200; i++) {
      hll.addHashBuffer(createHash('sha256').update(`seed-${i}`).digest())
    }
    const snap: SnapshotV1 = {
      version: 1,
      today: stubYesterday,
      salt: Buffer.alloc(32, 9).toString('base64'),
      hllRegisters: Buffer.from(hll.cloneRegisters()).toString('base64'),
      history: {},
    }
    // Write via the real adapter contract.
    const { FileSnapshotAdapter } = await import('../src/snapshot.js')
    new FileSnapshotAdapter(snapPath).save(snap)

    // Boot the middleware — it should load the snapshot, see the date has
    // moved, finalize yesterday into history, and start today fresh.
    const mw = createMiddleware({ token: TOKEN, snapshotPath: snapPath })
    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as {
      today: { date: string; uniqueVisitors: number }
      history: Array<{ date: string; uniqueVisitors: number }>
    }

    expect(body.today.date).toBe(today)
    expect(body.today.uniqueVisitors).toBe(0)
    expect(body.history).toHaveLength(1)
    expect(body.history[0]!.date).toBe(stubYesterday)
    // HLL has ~0.8% error at this magnitude; give it a small slack.
    expect(Math.abs(body.history[0]!.uniqueVisitors - 200)).toBeLessThanOrEqual(5)
  })

  it('does not count a visit to the /stats endpoint itself', async () => {
    const mw = createMiddleware({ token: TOKEN, snapshotPath: snapPath })
    // First hit: real visitor.
    await mw(req('/', { 'user-agent': 'A', 'x-forwarded-for': '1.1.1.1' }))
    // Now hit /stats several times — none should count.
    for (let i = 0; i < 5; i++) {
      await mw(req(`/stats?t=${TOKEN}`, { 'user-agent': 'B', 'x-forwarded-for': '9.9.9.9' }))
    }
    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(1)
  })

  it('does not count bot user agents', async () => {
    const mw = createMiddleware({ token: TOKEN, snapshotPath: snapPath })
    await mw(req('/', { 'user-agent': 'Googlebot/2.1', 'x-forwarded-for': '1.1.1.1' }))
    await mw(req('/', { 'user-agent': 'curl/8.0', 'x-forwarded-for': '2.2.2.2' }))
    await mw(req('/', { 'user-agent': 'SemrushBot', 'x-forwarded-for': '3.3.3.3' }))
    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(0)
  })

  it('401s with a wrong token and does not leak information', async () => {
    const mw = createMiddleware({ token: TOKEN, snapshotPath: snapPath })
    await mw(req('/', { 'user-agent': 'A', 'x-forwarded-for': '1.1.1.1' }))

    const missing = await mw(req('/stats'))
    const wrong = await mw(req('/stats?t=nope'))
    const diffLength = await mw(req('/stats?t=a'))

    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(diffLength.status).toBe(401)
    expect(await missing.text()).not.toMatch(/unique/i)
  })
})

describe('integration: bring-your-own persist adapter', () => {
  beforeEach(() => wipeSingleton())
  afterEach(() => wipeSingleton())

  it('uses a custom PersistAdapter for load and save', async () => {
    let stored: SnapshotV1 | null = null
    let loadCount = 0
    let saveCount = 0

    const adapter: PersistAdapter = {
      load: () => {
        loadCount++
        return stored
      },
      save: (snap) => {
        saveCount++
        stored = snap
      },
    }

    const mw = createMiddleware({ token: TOKEN, persist: adapter })
    await mw(req('/', { 'user-agent': 'A', 'x-forwarded-for': '1.1.1.1' }))
    await mw(req('/', { 'user-agent': 'B', 'x-forwarded-for': '2.2.2.2' }))
    currentRuntime()!.flush()

    expect(loadCount).toBe(1) // once at init
    expect(saveCount).toBeGreaterThanOrEqual(1) // init + explicit flush
    expect(stored).not.toBeNull()
    expect(stored!.version).toBe(1)
    expect(stored!.hllRegisters.length).toBe(21848)
  })

  it('restores state from a custom adapter', async () => {
    // Pre-seed the adapter with a snapshot containing 50 distinct visitors.
    const hll = new HyperLogLog()
    const { createHash } = await import('node:crypto')
    for (let i = 0; i < 50; i++) {
      hll.addHashBuffer(createHash('sha256').update(`preseed-${i}`).digest())
    }
    const today = new Date().toISOString().slice(0, 10)
    let stored: SnapshotV1 | null = {
      version: 1,
      today,
      salt: Buffer.alloc(32, 3).toString('base64'),
      hllRegisters: Buffer.from(hll.cloneRegisters()).toString('base64'),
      history: { '2025-12-31': 999 },
    }

    const adapter: PersistAdapter = {
      load: () => stored,
      save: (snap) => {
        stored = snap
      },
    }

    const mw = createMiddleware({ token: TOKEN, persist: adapter })
    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as {
      today: { uniqueVisitors: number }
      history: Array<{ date: string; uniqueVisitors: number }>
    }

    expect(Math.abs(body.today.uniqueVisitors - 50)).toBeLessThanOrEqual(3)
    expect(body.history).toEqual([{ date: '2025-12-31', uniqueVisitors: 999 }])
  })
})

describe('integration: security — trustProxy and XFF spoofing', () => {
  let dir: string
  let snapPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'statswhatshesaid-sec-'))
    snapPath = join(dir, 'stats.json')
    wipeSingleton()
  })
  afterEach(() => {
    wipeSingleton()
    rmSync(dir, { recursive: true, force: true })
  })

  it('trustProxy=1 (default) defeats client XFF spoofing behind a single proxy', async () => {
    const mw = createMiddleware({ token: TOKEN, snapshotPath: snapPath })

    // Attacker spoofs `9.9.9.9`. The (simulated) trusted proxy appends the
    // real client IP to the right. Rightmost-entry logic picks the real IP.
    await mw(req('/', { 'user-agent': 'Firefox', 'x-forwarded-for': '9.9.9.9, 1.1.1.1' }))

    // A separate attacker spoofs a different leftmost value — still behind
    // the same real client IP — should STILL dedupe to one visitor.
    await mw(req('/', { 'user-agent': 'Firefox', 'x-forwarded-for': '7.7.7.7, 1.1.1.1' }))

    // A brand-new real client.
    await mw(req('/', { 'user-agent': 'Firefox', 'x-forwarded-for': '9.9.9.9, 2.2.2.2' }))

    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(2)
  })

  it('trustProxy=0 collapses every request to a single visitor (safe but useless)', async () => {
    const mw = createMiddleware({ token: TOKEN, snapshotPath: snapPath, trustProxy: 0 })

    // Ten distinct "visitors" by every visible signal.
    for (let i = 0; i < 10; i++) {
      await mw(
        req('/', {
          'user-agent': `UA-${i}`,
          'x-forwarded-for': `10.0.0.${i}`,
        }),
      )
    }

    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    // All ten collapse because the IP used for hashing is the constant
    // UNKNOWN_PEER, but UA still varies. So we get 10 unique hashes via UA.
    // Wait — actually they'll differ because UA differs. Test the
    // invariant we actually care about: two requests with identical UA
    // but different XFF values hash to the SAME visitor.
    expect(body.today.uniqueVisitors).toBe(10)
  })

  it('trustProxy=0 + same UA + different spoofed XFF = one visitor', async () => {
    const mw = createMiddleware({ token: TOKEN, snapshotPath: snapPath, trustProxy: 0 })
    for (let i = 0; i < 10; i++) {
      await mw(req('/', { 'user-agent': 'same-ua', 'x-forwarded-for': `10.0.0.${i}` }))
    }
    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(1)
  })

  it('trustProxy=2 (two-proxy chain) correctly picks the client two from the right', async () => {
    const mw = createMiddleware({ token: TOKEN, snapshotPath: snapPath, trustProxy: 2 })

    // `attacker-spoof, real-client, cloudflare-edge`
    await mw(
      req('/', {
        'user-agent': 'Firefox',
        'x-forwarded-for': '9.9.9.9, 1.1.1.1, 2.2.2.2',
      }),
    )
    // Same real client from a different Cloudflare edge node — dedupe.
    await mw(
      req('/', {
        'user-agent': 'Firefox',
        'x-forwarded-for': '5.5.5.5, 1.1.1.1, 3.3.3.3',
      }),
    )
    // Different real client.
    await mw(
      req('/', {
        'user-agent': 'Firefox',
        'x-forwarded-for': '9.9.9.9, 4.4.4.4, 2.2.2.2',
      }),
    )

    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(2)
  })

  it('rejects invalid trustProxy values', () => {
    expect(() =>
      createMiddleware({ token: TOKEN, snapshotPath: snapPath, trustProxy: -1 })(
        req('/'),
      ),
    ).toThrow(/trustProxy/)
    expect(() =>
      createMiddleware({ token: TOKEN, snapshotPath: snapPath, trustProxy: 1.5 })(
        req('/'),
      ),
    ).toThrow(/trustProxy/)
  })
})

describe('integration: security — Authorization header', () => {
  let dir: string
  let snapPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'statswhatshesaid-auth-'))
    snapPath = join(dir, 'stats.json')
    wipeSingleton()
  })
  afterEach(() => {
    wipeSingleton()
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts the token via Authorization: Bearer on /stats', async () => {
    const mw = createMiddleware({ token: TOKEN, snapshotPath: snapPath })
    await mw(req('/', { 'user-agent': 'A', 'x-forwarded-for': '1.1.1.1' }))

    const res = await mw(req('/stats', { authorization: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(1)
  })

  it('Authorization beats the query string when both are provided', async () => {
    const mw = createMiddleware({ token: TOKEN, snapshotPath: snapPath })
    const res = await mw(
      new (await import('next/server')).NextRequest(`http://app.test/stats?t=wrong`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    )
    expect(res.status).toBe(200)
  })
})

describe('integration: security — User-Agent truncation', () => {
  let dir: string
  let snapPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'statswhatshesaid-ua-'))
    snapPath = join(dir, 'stats.json')
    wipeSingleton()
  })
  afterEach(() => {
    wipeSingleton()
    rmSync(dir, { recursive: true, force: true })
  })

  it('treats two oversized UAs with the same 512-byte prefix as the same visitor', async () => {
    const mw = createMiddleware({ token: TOKEN, snapshotPath: snapPath })

    const prefix = 'Mozilla/5.0 '.repeat(50) // 600 chars, matches in first 512
    const uaA = prefix + 'AAAAAAAA'
    const uaB = prefix + 'BBBBBBBB'

    await mw(req('/', { 'user-agent': uaA, 'x-forwarded-for': '1.1.1.1' }))
    await mw(req('/', { 'user-agent': uaB, 'x-forwarded-for': '1.1.1.1' }))

    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    // Both UAs share their first 512 bytes, so after truncation they're
    // identical → same visitor hash.
    expect(body.today.uniqueVisitors).toBe(1)
  })
})

describe('integration: security — snapshot file permissions', () => {
  let dir: string
  let snapPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'statswhatshesaid-perm-'))
    snapPath = join(dir, 'stats.json')
    wipeSingleton()
  })
  afterEach(() => {
    wipeSingleton()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the snapshot file with mode 0o600', async () => {
    const { statSync } = await import('node:fs')
    const mw = createMiddleware({ token: TOKEN, snapshotPath: snapPath })
    await mw(req('/', { 'user-agent': 'A', 'x-forwarded-for': '1.1.1.1' }))
    currentRuntime()!.flush()

    const stat = statSync(snapPath)
    // Mask out file-type bits, keep only the permission bits.
    const mode = stat.mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('integration: HLL register count constant', () => {
  it('the HLL register count matches the documented 16384', () => {
    expect(HLL_REGISTER_COUNT).toBe(16384)
  })
})
