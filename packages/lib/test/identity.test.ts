import { describe, expect, it } from 'vitest'

import {
  computeVisitorHash,
  constantTimeStringEqual,
  extractIp,
  generateSalt,
  isStaticPath,
  isValidUtcDate,
  SALT_BYTES,
  utcDateString,
} from '../src/identity.js'

describe('utcDateString', () => {
  it('formats a Date as YYYY-MM-DD in UTC', () => {
    expect(utcDateString(new Date('2026-04-07T23:59:59Z'))).toBe('2026-04-07')
    expect(utcDateString(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01')
  })
})

describe('isValidUtcDate', () => {
  it('accepts real calendar dates', () => {
    expect(isValidUtcDate('2026-04-07')).toBe(true)
    expect(isValidUtcDate('2024-02-29')).toBe(true)
    expect(isValidUtcDate('2000-01-01')).toBe(true)
  })

  it('rejects calendrically-impossible dates', () => {
    expect(isValidUtcDate('2026-02-30')).toBe(false)
    expect(isValidUtcDate('2025-02-29')).toBe(false)
    expect(isValidUtcDate('2026-13-01')).toBe(false)
    expect(isValidUtcDate('2026-99-99')).toBe(false)
  })

  it('rejects non-date strings', () => {
    expect(isValidUtcDate('')).toBe(false)
    expect(isValidUtcDate('yesterday')).toBe(false)
    expect(isValidUtcDate('2026/04/07')).toBe(false)
    expect(isValidUtcDate('2026-4-7')).toBe(false)
  })
})

describe('extractIp', () => {
  const headersOf = (init: Record<string, string>): Headers => new Headers(init)

  describe('trustProxy = 0', () => {
    it('ignores X-Forwarded-For entirely', () => {
      expect(extractIp(headersOf({ 'x-forwarded-for': '1.1.1.1' }), 0)).toBe('0.0.0.0')
    })
  })

  describe('trustProxy = 1 (default)', () => {
    it('returns the only entry of a single-hop chain', () => {
      expect(extractIp(headersOf({ 'x-forwarded-for': '1.2.3.4' }), 1)).toBe('1.2.3.4')
    })

    it('returns the rightmost entry, defeating client spoofing', () => {
      const h = headersOf({ 'x-forwarded-for': '9.9.9.9, 1.2.3.4' })
      expect(extractIp(h, 1)).toBe('1.2.3.4')
    })

    it('falls back to 0.0.0.0 when XFF is absent', () => {
      expect(extractIp(headersOf({}), 1)).toBe('0.0.0.0')
    })

    it('ignores X-Real-IP', () => {
      expect(extractIp(headersOf({ 'x-real-ip': '5.5.5.5' }), 1)).toBe('0.0.0.0')
    })
  })

  describe('trustProxy = 2', () => {
    it('returns the second-from-right entry', () => {
      const h = headersOf({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })
      expect(extractIp(h, 2)).toBe('1.1.1.1')
    })

    it('defeats spoofing with the correct hop count', () => {
      const h = headersOf({ 'x-forwarded-for': '9.9.9.9, 1.1.1.1, 2.2.2.2' })
      expect(extractIp(h, 2)).toBe('1.1.1.1')
    })

    it('falls back when chain too short', () => {
      expect(extractIp(headersOf({ 'x-forwarded-for': '1.1.1.1' }), 2)).toBe('0.0.0.0')
    })
  })

  it('skips empty entries in the chain', () => {
    const h = headersOf({ 'x-forwarded-for': '1.1.1.1,,,,2.2.2.2' })
    expect(extractIp(h, 1)).toBe('2.2.2.2')
  })
})

describe('computeVisitorHash', () => {
  const salt = new Uint8Array(SALT_BYTES).fill(7)

  it('returns a 32-byte SHA-256 digest', async () => {
    const h = await computeVisitorHash('1.2.3.4', 'Mozilla', salt)
    expect(h.length).toBe(32)
  })

  it('is deterministic for the same inputs', async () => {
    const a = await computeVisitorHash('1.2.3.4', 'Mozilla', salt)
    const b = await computeVisitorHash('1.2.3.4', 'Mozilla', salt)
    expect(uint8Equal(a, b)).toBe(true)
  })

  it('differs for different IPs', async () => {
    const a = await computeVisitorHash('1.2.3.4', 'ua', salt)
    const b = await computeVisitorHash('1.2.3.5', 'ua', salt)
    expect(uint8Equal(a, b)).toBe(false)
  })

  it('differs for different user agents', async () => {
    const a = await computeVisitorHash('1.2.3.4', 'A', salt)
    const b = await computeVisitorHash('1.2.3.4', 'B', salt)
    expect(uint8Equal(a, b)).toBe(false)
  })

  it('differs with a different salt', async () => {
    const a = await computeVisitorHash('1.2.3.4', 'ua', salt)
    const b = await computeVisitorHash('1.2.3.4', 'ua', new Uint8Array(SALT_BYTES).fill(9))
    expect(uint8Equal(a, b)).toBe(false)
  })

  it('treats input-ambiguous (ip, ua) pairs as distinct via length-prefix', async () => {
    // Naive `ip + ":" + ua` would collide on these. Length-prefix prevents it.
    const a = await computeVisitorHash('1::2', 'foo', salt)
    const b = await computeVisitorHash('1', ':2:foo', salt)
    expect(uint8Equal(a, b)).toBe(false)
  })
})

describe('generateSalt', () => {
  it('returns SALT_BYTES of (effectively) random data', () => {
    const a = generateSalt()
    const b = generateSalt()
    expect(a.length).toBe(SALT_BYTES)
    expect(b.length).toBe(SALT_BYTES)
    expect(uint8Equal(a, b)).toBe(false)
  })
})

describe('constantTimeStringEqual', () => {
  it('returns true for equal strings', async () => {
    expect(await constantTimeStringEqual('hello', 'hello')).toBe(true)
  })

  it('returns false for different strings of equal length', async () => {
    expect(await constantTimeStringEqual('helloX', 'helloY')).toBe(false)
  })

  it('returns false for strings of different lengths', async () => {
    expect(await constantTimeStringEqual('a', 'abcdef')).toBe(false)
  })
})

describe('isStaticPath', () => {
  it('matches Next.js internals', () => {
    expect(isStaticPath('/_next/static/css/main.css')).toBe(true)
    expect(isStaticPath('/_next/image?url=foo')).toBe(true)
    expect(isStaticPath('/_next/webpack-hmr')).toBe(true)
  })

  it('matches well-known root files', () => {
    expect(isStaticPath('/favicon.ico')).toBe(true)
    expect(isStaticPath('/favicon.svg')).toBe(true)
    expect(isStaticPath('/robots.txt')).toBe(true)
    expect(isStaticPath('/sitemap.xml')).toBe(true)
    expect(isStaticPath('/manifest.json')).toBe(true)
    expect(isStaticPath('/site.webmanifest')).toBe(true)
    expect(isStaticPath('/apple-touch-icon.png')).toBe(true)
  })

  it('does NOT match real routes', () => {
    expect(isStaticPath('/')).toBe(false)
    expect(isStaticPath('/about')).toBe(false)
    expect(isStaticPath('/api/users')).toBe(false)
    expect(isStaticPath('/api/data.json')).toBe(false)
    expect(isStaticPath('/blog/2026-04-07')).toBe(false)
  })
})

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
