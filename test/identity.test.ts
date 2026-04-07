import { describe, expect, it } from 'vitest'

import {
  computeVisitorHash,
  extractIp,
  generateSalt,
  utcDateString,
} from '../src/identity.js'

describe('utcDateString', () => {
  it('formats a Date as YYYY-MM-DD in UTC', () => {
    expect(utcDateString(new Date('2026-04-07T23:59:59Z'))).toBe('2026-04-07')
    expect(utcDateString(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01')
  })
})

describe('extractIp', () => {
  const headersOf = (init: Record<string, string>): Headers => new Headers(init)

  describe('trustProxy = 0 (never trust forwarding headers)', () => {
    it('ignores X-Forwarded-For entirely', () => {
      const h = headersOf({ 'x-forwarded-for': '1.1.1.1' })
      expect(extractIp(h, 0)).toBe('0.0.0.0')
    })

    it('ignores a multi-hop chain too', () => {
      const h = headersOf({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' })
      expect(extractIp(h, 0)).toBe('0.0.0.0')
    })
  })

  describe('trustProxy = 1 (one trusted proxy, the default)', () => {
    it('returns the only entry of a single-hop chain', () => {
      const h = headersOf({ 'x-forwarded-for': '1.2.3.4' })
      expect(extractIp(h, 1)).toBe('1.2.3.4')
    })

    it('returns the rightmost entry of a longer chain, defeating client spoofing', () => {
      // Attacker sends `X-Forwarded-For: 9.9.9.9`. The trusted nginx
      // appends the real client IP: `9.9.9.9, 1.2.3.4`.
      const h = headersOf({ 'x-forwarded-for': '9.9.9.9, 1.2.3.4' })
      expect(extractIp(h, 1)).toBe('1.2.3.4')
    })

    it('trims whitespace around entries', () => {
      const h = headersOf({ 'x-forwarded-for': '  9.9.9.9  ,  10.0.0.1  ' })
      expect(extractIp(h, 1)).toBe('10.0.0.1')
    })

    it('falls back to 0.0.0.0 when XFF is absent', () => {
      expect(extractIp(headersOf({}), 1)).toBe('0.0.0.0')
    })

    it('ignores X-Real-IP entirely (only XFF is consulted)', () => {
      // X-Real-IP is deliberately NOT trusted — we have one clear trust
      // path (XFF + trustProxy hops) to keep semantics predictable.
      const h = headersOf({ 'x-real-ip': '5.5.5.5' })
      expect(extractIp(h, 1)).toBe('0.0.0.0')
    })
  })

  describe('trustProxy = 2 (two trusted proxies, e.g. Cloudflare → nginx → app)', () => {
    it('returns the second-from-right entry', () => {
      const h = headersOf({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })
      expect(extractIp(h, 2)).toBe('1.1.1.1')
    })

    it('defeats spoofing from the client with the correct hop count', () => {
      // Client spoofs `9.9.9.9`. CF appends client IP → `9.9.9.9, 1.1.1.1`.
      // nginx appends CF's IP → `9.9.9.9, 1.1.1.1, 2.2.2.2`.
      const h = headersOf({ 'x-forwarded-for': '9.9.9.9, 1.1.1.1, 2.2.2.2' })
      expect(extractIp(h, 2)).toBe('1.1.1.1')
    })

    it('falls back to 0.0.0.0 when the chain is shorter than trustProxy', () => {
      const h = headersOf({ 'x-forwarded-for': '1.1.1.1' })
      expect(extractIp(h, 2)).toBe('0.0.0.0')
    })
  })

  describe('malformed inputs', () => {
    it('skips empty entries in the chain', () => {
      const h = headersOf({ 'x-forwarded-for': '1.1.1.1,,,,2.2.2.2' })
      expect(extractIp(h, 1)).toBe('2.2.2.2')
    })
  })
})

describe('computeVisitorHash', () => {
  const salt = Buffer.alloc(32, 7)

  it('is deterministic for the same inputs and salt', () => {
    const a = computeVisitorHash('1.2.3.4', 'Mozilla/5.0', salt)
    const b = computeVisitorHash('1.2.3.4', 'Mozilla/5.0', salt)
    expect(a.equals(b)).toBe(true)
    expect(a.length).toBe(32) // SHA-256 digest
  })

  it('differs for different IPs', () => {
    const a = computeVisitorHash('1.2.3.4', 'ua', salt)
    const b = computeVisitorHash('1.2.3.5', 'ua', salt)
    expect(a.equals(b)).toBe(false)
  })

  it('differs for different user agents', () => {
    const a = computeVisitorHash('1.2.3.4', 'A', salt)
    const b = computeVisitorHash('1.2.3.4', 'B', salt)
    expect(a.equals(b)).toBe(false)
  })

  it('differs with a different salt', () => {
    const a = computeVisitorHash('1.2.3.4', 'ua', salt)
    const b = computeVisitorHash('1.2.3.4', 'ua', Buffer.alloc(32, 9))
    expect(a.equals(b)).toBe(false)
  })
})

describe('generateSalt', () => {
  it('returns 32 bytes of (effectively) random data', () => {
    const a = generateSalt()
    const b = generateSalt()
    expect(a.length).toBe(32)
    expect(b.length).toBe(32)
    expect(a.equals(b)).toBe(false)
  })
})
