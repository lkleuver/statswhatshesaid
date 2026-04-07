import { describe, expect, it } from 'vitest'

import { computeVisitorHash, isValidUtcDate, SALT_BYTES } from '../src/identity.js'
import { resolveConfig } from '../src/config.js'
import { VisitorStore } from '../src/store.js'
import { HLL_REGISTER_COUNT, HyperLogLog } from '../src/hll.js'
import type { SnapshotV1 } from '../src/snapshot.js'

/**
 * Second-pass hardening tests: input-ambiguity in hash construction,
 * config validation, and graceful degradation on corrupt snapshots.
 */

const EMPTY_REGISTERS = Buffer.alloc(HLL_REGISTER_COUNT, 0).toString('base64')
const FAKE_SALT = Buffer.alloc(SALT_BYTES, 1).toString('base64')

function baseSnap(overrides: Partial<SnapshotV1> = {}): SnapshotV1 {
  return {
    version: 1,
    today: '2026-04-07',
    salt: FAKE_SALT,
    hllRegisters: EMPTY_REGISTERS,
    history: {},
    ...overrides,
  }
}

describe('computeVisitorHash — length-prefix prevents input ambiguity', () => {
  const salt = Buffer.alloc(SALT_BYTES, 7)

  it('treats (ip="1::2", ua="foo") and (ip="1", ua=":2:foo") as distinct', () => {
    // Under a naive `ip + ":" + ua + ":" + salt` encoding, both of these
    // produce the same byte sequence `1::2:foo:` before the salt, and
    // therefore the same hash. With length-prefixing, they're distinct.
    const a = computeVisitorHash('1::2', 'foo', salt)
    const b = computeVisitorHash('1', ':2:foo', salt)
    expect(a.equals(b)).toBe(false)
  })

  it('is still deterministic for the same inputs', () => {
    const a = computeVisitorHash('10.0.0.1', 'Mozilla/5.0', salt)
    const b = computeVisitorHash('10.0.0.1', 'Mozilla/5.0', salt)
    expect(a.equals(b)).toBe(true)
  })

  it('treats empty IP and empty UA as distinct from non-empty values', () => {
    const a = computeVisitorHash('', 'foo', salt)
    const b = computeVisitorHash('foo', '', salt)
    expect(a.equals(b)).toBe(false)
  })
})

describe('isValidUtcDate', () => {
  it('accepts real calendar dates', () => {
    expect(isValidUtcDate('2026-04-07')).toBe(true)
    expect(isValidUtcDate('2024-02-29')).toBe(true) // leap year
    expect(isValidUtcDate('2000-01-01')).toBe(true)
  })

  it('rejects calendrically-impossible dates', () => {
    expect(isValidUtcDate('2026-02-30')).toBe(false)
    expect(isValidUtcDate('2025-02-29')).toBe(false) // not leap
    expect(isValidUtcDate('2026-13-01')).toBe(false)
    expect(isValidUtcDate('2026-00-15')).toBe(false)
    expect(isValidUtcDate('2026-99-99')).toBe(false)
  })

  it('rejects non-date strings', () => {
    expect(isValidUtcDate('')).toBe(false)
    expect(isValidUtcDate('yesterday')).toBe(false)
    expect(isValidUtcDate('2026/04/07')).toBe(false)
    expect(isValidUtcDate('2026-4-7')).toBe(false)
  })
})

describe('resolveConfig — numeric validation', () => {
  const LONG_TOKEN = 'a-long-enough-token-for-this-test-xxxxxxx'

  it('rejects flushIntervalMs <= 0', () => {
    expect(() => resolveConfig({ token: LONG_TOKEN, flushIntervalMs: 0 })).toThrow(
      /flushIntervalMs/,
    )
    expect(() =>
      resolveConfig({ token: LONG_TOKEN, flushIntervalMs: -5 }),
    ).toThrow(/flushIntervalMs/)
  })

  it('rejects flushIntervalMs below the 1s floor', () => {
    expect(() => resolveConfig({ token: LONG_TOKEN, flushIntervalMs: 500 })).toThrow(
      /flushIntervalMs/,
    )
  })

  it('accepts flushIntervalMs >= 1000', () => {
    expect(() =>
      resolveConfig({ token: LONG_TOKEN, flushIntervalMs: 1000 }),
    ).not.toThrow()
  })

  it('rejects negative historyDays', () => {
    expect(() => resolveConfig({ token: LONG_TOKEN, historyDays: -1 })).toThrow(
      /historyDays/,
    )
  })

  it('rejects non-integer historyDays', () => {
    expect(() => resolveConfig({ token: LONG_TOKEN, historyDays: 1.5 })).toThrow(
      /historyDays/,
    )
  })

  it('rejects negative maxHistoryDays', () => {
    expect(() =>
      resolveConfig({ token: LONG_TOKEN, maxHistoryDays: -1 }),
    ).toThrow(/maxHistoryDays/)
  })

  it('accepts zero historyDays and maxHistoryDays (degenerate-but-valid)', () => {
    expect(() =>
      resolveConfig({
        token: LONG_TOKEN,
        historyDays: 0,
        maxHistoryDays: 0,
      }),
    ).not.toThrow()
  })
})

describe('resolveConfig — endpointPath validation', () => {
  const LONG_TOKEN = 'a-long-enough-token-for-this-test-xxxxxxx'

  it('rejects endpointPath containing whitespace', () => {
    expect(() =>
      resolveConfig({ token: LONG_TOKEN, endpointPath: '/foo bar' }),
    ).toThrow(/endpointPath/)
  })

  it('rejects endpointPath with CR/LF', () => {
    expect(() =>
      resolveConfig({ token: LONG_TOKEN, endpointPath: '/foo\nbar' }),
    ).toThrow(/endpointPath/)
  })

  it('rejects endpointPath with shell metacharacters', () => {
    expect(() =>
      resolveConfig({ token: LONG_TOKEN, endpointPath: '/foo;bar' }),
    ).toThrow(/endpointPath/)
    expect(() =>
      resolveConfig({ token: LONG_TOKEN, endpointPath: '/foo?bar' }),
    ).toThrow(/endpointPath/)
  })

  it('accepts simple paths', () => {
    expect(() =>
      resolveConfig({ token: LONG_TOKEN, endpointPath: '/stats' }),
    ).not.toThrow()
    expect(() =>
      resolveConfig({ token: LONG_TOKEN, endpointPath: '/_internal/stats' }),
    ).not.toThrow()
    expect(() =>
      resolveConfig({ token: LONG_TOKEN, endpointPath: '/stats.json' }),
    ).not.toThrow()
  })
})

describe('VisitorStore.fromSnapshot — graceful degradation on corrupt input', () => {
  it('starts fresh when same-day salt has the wrong decoded length', () => {
    // 1 byte of salt, should be 32.
    const snap = baseSnap({ salt: Buffer.alloc(1, 0xff).toString('base64') })
    const store = VisitorStore.fromSnapshot(snap, '2026-04-07')
    expect(store.today).toBe('2026-04-07')
    expect(store.estimateToday()).toBe(0)
    expect(store.dirty).toBe(true) // had to start fresh, needs persist
  })

  it('starts fresh when same-day registers have the wrong decoded length', () => {
    const badRegisters = Buffer.alloc(100, 0).toString('base64')
    // Fake the base64 length so the outer validator would pass (it won't
    // because we bypass it here and construct directly).
    const snap = baseSnap({ hllRegisters: badRegisters })
    const store = VisitorStore.fromSnapshot(snap, '2026-04-07')
    expect(store.today).toBe('2026-04-07')
    expect(store.estimateToday()).toBe(0)
    expect(store.dirty).toBe(true)
  })

  it('drops history entries with non-date keys', () => {
    const snap = baseSnap({
      history: {
        '2026-04-06': 10,
        '<script>': 99,
        'yesterday': 5,
        '2026-13-01': 7, // bad month
        '2025-02-29': 3, // non-leap
      },
    })
    const store = VisitorStore.fromSnapshot(snap, '2026-04-07')
    const hist = store.getHistoryDesc(90)
    expect(hist).toEqual([{ date: '2026-04-06', uniqueVisitors: 10 }])
  })

  it('drops history entries with non-integer or negative counts', () => {
    const snap = baseSnap({
      history: {
        '2026-04-06': 10,
        '2026-04-05': -5,
        '2026-04-04': 3.14,
        '2026-04-03': Number.POSITIVE_INFINITY,
        '2026-04-02': Number.NaN,
      },
    })
    const store = VisitorStore.fromSnapshot(snap, '2026-04-07')
    const hist = store.getHistoryDesc(90)
    expect(hist).toEqual([{ date: '2026-04-06', uniqueVisitors: 10 }])
  })

  it('drops a history entry for today (owned by the live HLL)', () => {
    const snap = baseSnap({
      today: '2026-04-07',
      history: {
        '2026-04-07': 999, // would double-count
        '2026-04-06': 10,
      },
    })
    const store = VisitorStore.fromSnapshot(snap, '2026-04-07')
    const hist = store.getHistoryDesc(90)
    expect(hist).toEqual([{ date: '2026-04-06', uniqueVisitors: 10 }])
  })
})

describe('HyperLogLog roundtrip after hash construction change', () => {
  it('still estimates large-cardinality inputs within ~2%', () => {
    // Sanity check that the length-prefixed hash still flows cleanly
    // through the HLL sketch.
    const salt = Buffer.alloc(SALT_BYTES, 0x42)
    const hll = new HyperLogLog()
    const n = 10_000
    for (let i = 0; i < n; i++) {
      const h = computeVisitorHash(`10.0.${(i >> 8) & 0xff}.${i & 0xff}`, 'ua', salt)
      hll.addHashBuffer(h)
    }
    const est = hll.estimate()
    expect(Math.abs(est - n) / n).toBeLessThan(0.02)
  })
})
