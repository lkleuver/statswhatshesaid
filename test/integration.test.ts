import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { createMiddleware } from '../src/middleware.js'
import { HLL_REGISTER_COUNT } from '../src/hll.js'

/**
 * End-to-end integration tests exercising the full middleware → endpoint
 * pipeline with the in-memory store. No filesystem, no persistence.
 */

const TOKEN = 'integration-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx'

function req(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://app.test${path}`, { headers })
}

function wipeSingleton(): void {
  ;(globalThis as { __statswhatshesaid__?: unknown }).__statswhatshesaid__ = undefined
}

describe('integration: middleware + endpoint', () => {
  beforeEach(() => wipeSingleton())
  afterEach(() => wipeSingleton())

  it('full happy path: tracks distinct visitors, dedupes, serves /stats', async () => {
    const mw = createMiddleware({ token: TOKEN })

    // Visitor A hits two pages → one unique.
    await mw(req('/', { 'user-agent': 'Mozilla Firefox', 'x-forwarded-for': '10.0.0.1' }))
    await mw(req('/about', { 'user-agent': 'Mozilla Firefox', 'x-forwarded-for': '10.0.0.1' }))

    // Visitor B (different IP).
    await mw(req('/', { 'user-agent': 'Mozilla Firefox', 'x-forwarded-for': '10.0.0.2' }))

    // Visitor C (different UA).
    await mw(req('/', { 'user-agent': 'Safari', 'x-forwarded-for': '10.0.0.3' }))

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

  it('does not count a visit to the /stats endpoint itself', async () => {
    const mw = createMiddleware({ token: TOKEN })
    await mw(req('/', { 'user-agent': 'A', 'x-forwarded-for': '1.1.1.1' }))
    for (let i = 0; i < 5; i++) {
      await mw(req(`/stats?t=${TOKEN}`, { 'user-agent': 'B', 'x-forwarded-for': '9.9.9.9' }))
    }
    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(1)
  })

  it('does not count visits to common static asset paths', async () => {
    const mw = createMiddleware({ token: TOKEN })
    // All these are skipped by the in-library static-path filter.
    await mw(req('/_next/static/chunks/main.js', {
      'user-agent': 'Mozilla', 'x-forwarded-for': '1.1.1.1',
    }))
    await mw(req('/favicon.ico', {
      'user-agent': 'Mozilla', 'x-forwarded-for': '2.2.2.2',
    }))
    await mw(req('/robots.txt', {
      'user-agent': 'Mozilla', 'x-forwarded-for': '3.3.3.3',
    }))
    await mw(req('/manifest.json', {
      'user-agent': 'Mozilla', 'x-forwarded-for': '4.4.4.4',
    }))
    // A real page route still counts.
    await mw(req('/', {
      'user-agent': 'Mozilla', 'x-forwarded-for': '5.5.5.5',
    }))

    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(1)
  })

  it('does not count bot user agents', async () => {
    const mw = createMiddleware({ token: TOKEN })
    await mw(req('/', { 'user-agent': 'Googlebot/2.1', 'x-forwarded-for': '1.1.1.1' }))
    await mw(req('/', { 'user-agent': 'curl/8.0', 'x-forwarded-for': '2.2.2.2' }))
    await mw(req('/', { 'user-agent': 'SemrushBot', 'x-forwarded-for': '3.3.3.3' }))
    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(0)
  })

  it('401s with a wrong token and does not leak data', async () => {
    const mw = createMiddleware({ token: TOKEN })
    await mw(req('/', { 'user-agent': 'A', 'x-forwarded-for': '1.1.1.1' }))

    const missing = await mw(req('/stats'))
    const wrong = await mw(req('/stats?t=nope'))
    const diffLength = await mw(req('/stats?t=a'))

    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(diffLength.status).toBe(401)
    expect(await missing.text()).not.toMatch(/unique/i)
  })

  it('a tracking error never breaks the user request', async () => {
    // Construct a request whose Headers throw on read. The library should
    // swallow and still return next().
    const mw = createMiddleware({ token: TOKEN })
    const r = new NextRequest('http://x.test/')
    const realGet = r.headers.get.bind(r.headers)
    let firstCall = true
    ;(r.headers as { get: (name: string) => string | null }).get = (name: string) => {
      if (firstCall) {
        firstCall = false
        throw new Error('boom')
      }
      return realGet(name)
    }
    // Silence the expected console.error from the catch block.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await mw(r)
    expect(res.status).toBe(200)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[statswhatshesaid] track failed:'),
      expect.any(Error),
    )
    errSpy.mockRestore()
  })
})

describe('integration: trustProxy and XFF spoofing', () => {
  beforeEach(() => wipeSingleton())
  afterEach(() => wipeSingleton())

  it('trustProxy=1 (default) defeats client XFF spoofing behind a single proxy', async () => {
    const mw = createMiddleware({ token: TOKEN })

    // Attacker spoofs `9.9.9.9`. Trusted proxy appends real client IP.
    await mw(req('/', { 'user-agent': 'Firefox', 'x-forwarded-for': '9.9.9.9, 1.1.1.1' }))
    // Different attacker spoof, same real client → still dedupes.
    await mw(req('/', { 'user-agent': 'Firefox', 'x-forwarded-for': '7.7.7.7, 1.1.1.1' }))
    // New real client.
    await mw(req('/', { 'user-agent': 'Firefox', 'x-forwarded-for': '9.9.9.9, 2.2.2.2' }))

    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(2)
  })

  it('trustProxy=0 + same UA + different spoofed XFF = one visitor', async () => {
    const mw = createMiddleware({ token: TOKEN, trustProxy: 0 })
    for (let i = 0; i < 10; i++) {
      await mw(req('/', { 'user-agent': 'same-ua', 'x-forwarded-for': `10.0.0.${i}` }))
    }
    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(1)
  })

  it('trustProxy=2 (Cloudflare → nginx → app) picks the client correctly', async () => {
    const mw = createMiddleware({ token: TOKEN, trustProxy: 2 })

    // attacker-spoof, real-client, cloudflare-edge
    await mw(req('/', {
      'user-agent': 'Firefox',
      'x-forwarded-for': '9.9.9.9, 1.1.1.1, 2.2.2.2',
    }))
    // Same real client from a different CF edge → dedupe.
    await mw(req('/', {
      'user-agent': 'Firefox',
      'x-forwarded-for': '5.5.5.5, 1.1.1.1, 3.3.3.3',
    }))
    // Different real client.
    await mw(req('/', {
      'user-agent': 'Firefox',
      'x-forwarded-for': '9.9.9.9, 4.4.4.4, 2.2.2.2',
    }))

    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(2)
  })

  it('rejects invalid trustProxy values', async () => {
    await expect(
      createMiddleware({ token: TOKEN, trustProxy: -1 })(req('/')),
    ).rejects.toThrow(/trustProxy/)
    await expect(
      createMiddleware({ token: TOKEN, trustProxy: 1.5 })(req('/')),
    ).rejects.toThrow(/trustProxy/)
  })
})

describe('integration: Authorization header', () => {
  beforeEach(() => wipeSingleton())
  afterEach(() => wipeSingleton())

  it('accepts the token via Authorization: Bearer on /stats', async () => {
    const mw = createMiddleware({ token: TOKEN })
    await mw(req('/', { 'user-agent': 'A', 'x-forwarded-for': '1.1.1.1' }))

    const res = await mw(req('/stats', { authorization: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(1)
  })

  it('Authorization beats the query string when both are provided', async () => {
    const mw = createMiddleware({ token: TOKEN })
    const r = new NextRequest(`http://app.test/stats?t=wrong`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect((await mw(r)).status).toBe(200)
  })
})

describe('integration: User-Agent truncation', () => {
  beforeEach(() => wipeSingleton())
  afterEach(() => wipeSingleton())

  it('treats two oversized UAs with the same 512-byte prefix as the same visitor', async () => {
    const mw = createMiddleware({ token: TOKEN })

    const prefix = 'Mozilla/5.0 '.repeat(50) // 600 chars, identical first 512
    const uaA = prefix + 'AAAAAAAA'
    const uaB = prefix + 'BBBBBBBB'

    await mw(req('/', { 'user-agent': uaA, 'x-forwarded-for': '1.1.1.1' }))
    await mw(req('/', { 'user-agent': uaB, 'x-forwarded-for': '1.1.1.1' }))

    const res = await mw(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(1)
  })
})

describe('integration: HLL register count constant', () => {
  it('the HLL register count matches the documented 16384', () => {
    expect(HLL_REGISTER_COUNT).toBe(16384)
  })
})
