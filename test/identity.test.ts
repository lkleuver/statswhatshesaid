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

  it('returns the first hop from x-forwarded-for', () => {
    const h = headersOf({ 'x-forwarded-for': '203.0.113.10, 70.41.3.18, 150.172.238.178' })
    expect(extractIp(h)).toBe('203.0.113.10')
  })

  it('falls back to x-real-ip', () => {
    expect(extractIp(headersOf({ 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7')
  })

  it('uses the provided fallback ip when no headers are present', () => {
    expect(extractIp(headersOf({}), '127.0.0.1')).toBe('127.0.0.1')
  })

  it('returns 0.0.0.0 when nothing is available', () => {
    expect(extractIp(headersOf({}))).toBe('0.0.0.0')
  })

  it('trims whitespace in xff entries', () => {
    const h = headersOf({ 'x-forwarded-for': '  10.0.0.1  ,  10.0.0.2' })
    expect(extractIp(h)).toBe('10.0.0.1')
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
