import { describe, expect, it } from 'vitest'

import {
  computeVisitorHash,
  isValidUtcDate,
  SALT_BYTES,
} from '../src/identity.js'
import { resolveConfig } from '../src/config.js'
import { HyperLogLog } from '../src/hll.js'

/**
 * Hardening tests: input-ambiguity in hash construction, config validation,
 * and HLL roundtrip after the Web Crypto switch.
 */

describe('computeVisitorHash — length-prefix prevents input ambiguity', () => {
  const salt = new Uint8Array(SALT_BYTES).fill(7)

  it('treats (ip="1::2", ua="foo") and (ip="1", ua=":2:foo") as distinct', async () => {
    const a = await computeVisitorHash('1::2', 'foo', salt)
    const b = await computeVisitorHash('1', ':2:foo', salt)
    expect(uint8Equal(a, b)).toBe(false)
  })

  it('is still deterministic for the same inputs', async () => {
    const a = await computeVisitorHash('10.0.0.1', 'Mozilla/5.0', salt)
    const b = await computeVisitorHash('10.0.0.1', 'Mozilla/5.0', salt)
    expect(uint8Equal(a, b)).toBe(true)
  })

  it('treats empty IP and empty UA as distinct from non-empty values', async () => {
    const a = await computeVisitorHash('', 'foo', salt)
    const b = await computeVisitorHash('foo', '', salt)
    expect(uint8Equal(a, b)).toBe(false)
  })
})

describe('isValidUtcDate', () => {
  it('accepts real calendar dates', () => {
    expect(isValidUtcDate('2026-04-07')).toBe(true)
    expect(isValidUtcDate('2024-02-29')).toBe(true)
  })

  it('rejects calendrically-impossible dates', () => {
    expect(isValidUtcDate('2026-02-30')).toBe(false)
    expect(isValidUtcDate('2025-02-29')).toBe(false)
    expect(isValidUtcDate('2026-13-01')).toBe(false)
  })

  it('rejects non-date strings', () => {
    expect(isValidUtcDate('yesterday')).toBe(false)
    expect(isValidUtcDate('2026/04/07')).toBe(false)
  })
})

describe('resolveConfig — numeric validation', () => {
  const LONG_TOKEN = 'a-long-enough-token-for-this-test-xxxxxxx'

  it('rejects negative historyDays', () => {
    expect(() => resolveConfig({ token: LONG_TOKEN, historyDays: -1 })).toThrow(/historyDays/)
  })

  it('rejects non-integer historyDays', () => {
    expect(() => resolveConfig({ token: LONG_TOKEN, historyDays: 1.5 })).toThrow(/historyDays/)
  })

  it('rejects negative maxHistoryDays', () => {
    expect(() => resolveConfig({ token: LONG_TOKEN, maxHistoryDays: -1 })).toThrow(/maxHistoryDays/)
  })

  it('accepts zero historyDays and maxHistoryDays', () => {
    expect(() => resolveConfig({
      token: LONG_TOKEN, historyDays: 0, maxHistoryDays: 0,
    })).not.toThrow()
  })

  it('rejects negative trustProxy', () => {
    expect(() => resolveConfig({ token: LONG_TOKEN, trustProxy: -1 })).toThrow(/trustProxy/)
  })

  it('rejects non-integer trustProxy', () => {
    expect(() => resolveConfig({ token: LONG_TOKEN, trustProxy: 1.5 })).toThrow(/trustProxy/)
  })

  it('accepts trustProxy: 0', () => {
    expect(() => resolveConfig({ token: LONG_TOKEN, trustProxy: 0 })).not.toThrow()
  })
})

describe('resolveConfig — endpointPath validation', () => {
  const LONG_TOKEN = 'a-long-enough-token-for-this-test-xxxxxxx'

  it('rejects whitespace, CR/LF, and shell metacharacters', () => {
    expect(() => resolveConfig({ token: LONG_TOKEN, endpointPath: '/foo bar' })).toThrow(/endpointPath/)
    expect(() => resolveConfig({ token: LONG_TOKEN, endpointPath: '/foo\nbar' })).toThrow(/endpointPath/)
    expect(() => resolveConfig({ token: LONG_TOKEN, endpointPath: '/foo;bar' })).toThrow(/endpointPath/)
    expect(() => resolveConfig({ token: LONG_TOKEN, endpointPath: '/foo?bar' })).toThrow(/endpointPath/)
  })

  it('accepts simple paths', () => {
    expect(() => resolveConfig({ token: LONG_TOKEN, endpointPath: '/stats' })).not.toThrow()
    expect(() => resolveConfig({ token: LONG_TOKEN, endpointPath: '/_internal/stats' })).not.toThrow()
    expect(() => resolveConfig({ token: LONG_TOKEN, endpointPath: '/stats.json' })).not.toThrow()
  })
})

describe('HyperLogLog roundtrip with Web Crypto hashes', () => {
  it('still estimates large-cardinality inputs within ~2%', async () => {
    const salt = new Uint8Array(SALT_BYTES).fill(0x42)
    const hll = new HyperLogLog()
    const n = 10_000
    for (let i = 0; i < n; i++) {
      const h = await computeVisitorHash(`10.0.${(i >> 8) & 0xff}.${i & 0xff}`, 'ua', salt)
      hll.addHashBuffer(h)
    }
    const est = hll.estimate()
    expect(Math.abs(est - n) / n).toBeLessThan(0.02)
  })
})

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
