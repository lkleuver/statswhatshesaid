import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { HLL_REGISTER_COUNT, HyperLogLog } from '../src/hll.js'
import { VisitorStore } from '../src/store.js'
import type { SnapshotV1 } from '../src/snapshot.js'

const hashOf = (s: string): Buffer => createHash('sha256').update(s).digest()

const emptyRegisters = Buffer.alloc(HLL_REGISTER_COUNT, 0).toString('base64')
const fakeSalt = Buffer.alloc(32, 1).toString('base64')

function snap(overrides: Partial<SnapshotV1> = {}): SnapshotV1 {
  return {
    version: 1,
    today: '2026-04-07',
    salt: fakeSalt,
    hllRegisters: emptyRegisters,
    history: {},
    ...overrides,
  }
}

describe('VisitorStore', () => {
  it('fresh store has no visitors and no history', () => {
    const s = VisitorStore.fresh('2026-04-07')
    expect(s.today).toBe('2026-04-07')
    expect(s.estimateToday()).toBe(0)
    expect(s.getHistoryDesc(90)).toEqual([])
  })

  it('track() increments the cardinality estimate and dedupes', () => {
    const s = VisitorStore.fresh('2026-04-07')
    s.track('1.1.1.1', 'ua-a')
    s.track('2.2.2.2', 'ua-b')
    s.track('1.1.1.1', 'ua-a') // duplicate
    expect(s.estimateToday()).toBe(2)
    expect(s.dirty).toBe(true)
  })

  it('fromSnapshot restores today when dates match', () => {
    const hll = new HyperLogLog()
    for (let i = 0; i < 500; i++) hll.addHashBuffer(hashOf(`user-${i}`))
    const s = VisitorStore.fromSnapshot(
      snap({
        today: '2026-04-07',
        hllRegisters: Buffer.from(hll.cloneRegisters()).toString('base64'),
      }),
      '2026-04-07',
    )
    expect(s.today).toBe('2026-04-07')
    expect(Math.abs(s.estimateToday() - 500)).toBeLessThan(20) // ~1% of 500
    expect(s.dirty).toBe(false)
  })

  it('fromSnapshot finalizes the old day into history when dates differ', () => {
    const hll = new HyperLogLog()
    for (let i = 0; i < 123; i++) hll.addHashBuffer(hashOf(`visitor-${i}`))
    const s = VisitorStore.fromSnapshot(
      snap({
        today: '2026-04-06',
        hllRegisters: Buffer.from(hll.cloneRegisters()).toString('base64'),
      }),
      '2026-04-07',
    )
    expect(s.today).toBe('2026-04-07')
    expect(s.estimateToday()).toBe(0)
    const hist = s.getHistoryDesc(90)
    expect(hist).toHaveLength(1)
    expect(hist[0]!.date).toBe('2026-04-06')
    // HLL has ~0.8% standard error; allow a small absolute slack at low N.
    expect(Math.abs(hist[0]!.uniqueVisitors - 123)).toBeLessThanOrEqual(3)
    expect(s.dirty).toBe(true)
  })

  it('rollOverIfNeeded finalizes the current day into history', () => {
    const s = VisitorStore.fresh('2026-04-07')
    s.track('1.1.1.1', 'ua')
    s.track('2.2.2.2', 'ua')
    expect(s.rollOverIfNeeded(new Date('2026-04-08T00:00:01Z'))).toBe(true)
    expect(s.today).toBe('2026-04-08')
    expect(s.estimateToday()).toBe(0)
    const hist = s.getHistoryDesc(90)
    expect(hist).toEqual([{ date: '2026-04-07', uniqueVisitors: 2 }])
  })

  it('rollOverIfNeeded is a no-op within the same UTC day', () => {
    const s = VisitorStore.fresh('2026-04-07')
    expect(s.rollOverIfNeeded(new Date('2026-04-07T23:59:59Z'))).toBe(false)
    expect(s.today).toBe('2026-04-07')
  })

  it('trimHistory drops the oldest entries past the cap', () => {
    const s = VisitorStore.fromSnapshot(
      snap({
        today: '2026-04-10',
        history: {
          '2026-04-01': 1,
          '2026-04-02': 2,
          '2026-04-03': 3,
          '2026-04-04': 4,
          '2026-04-05': 5,
        },
      }),
      '2026-04-10',
    )
    s.trimHistory(3)
    const hist = s.getHistoryDesc(90)
    expect(hist.map((h) => h.date)).toEqual(['2026-04-05', '2026-04-04', '2026-04-03'])
  })

  it('toSnapshot roundtrips through fromSnapshot preserving the HLL', () => {
    const a = VisitorStore.fresh('2026-04-07')
    a.track('1.1.1.1', 'ua-a')
    a.track('2.2.2.2', 'ua-b')
    a.track('3.3.3.3', 'ua-c')
    const b = VisitorStore.fromSnapshot(a.toSnapshot(), '2026-04-07')
    expect(b.today).toBe(a.today)
    expect(b.estimateToday()).toBe(a.estimateToday())
    // Re-tracking the same IPs shouldn't bump the count.
    b.track('1.1.1.1', 'ua-a')
    expect(b.estimateToday()).toBe(a.estimateToday())
  })
})
