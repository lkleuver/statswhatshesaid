import { describe, expect, it, vi } from 'vitest'

import { VisitorStore } from '../src/store.js'

describe('VisitorStore', () => {
  it('fresh store has no visitors and no history', () => {
    const s = VisitorStore.fresh('2026-04-07')
    expect(s.today).toBe('2026-04-07')
    expect(s.estimateToday()).toBe(0)
    expect(s.getHistoryDesc(90)).toEqual([])
  })

  it('track() increments the cardinality estimate and dedupes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-07T12:00:00Z'))
    try {
      const s = VisitorStore.fresh('2026-04-07')
      await s.track('1.1.1.1', 'ua-a')
      await s.track('2.2.2.2', 'ua-b')
      await s.track('1.1.1.1', 'ua-a') // duplicate
      expect(s.estimateToday()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rollOverIfNeeded finalizes the current day into history', () => {
    const s = VisitorStore.fresh('2026-04-07')
    expect(s.rollOverIfNeeded(new Date('2026-04-08T00:00:01Z'))).toBe(true)
    expect(s.today).toBe('2026-04-08')
  })

  it('rollOverIfNeeded preserves the previous day count in history', async () => {
    // track() consults the real clock via rollOverIfNeeded(), so freeze
    // wall time to a moment inside the fresh-store's day to keep the test
    // deterministic regardless of when CI runs.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-07T12:00:00Z'))
    try {
      const s = VisitorStore.fresh('2026-04-07')
      await s.track('1.1.1.1', 'ua')
      await s.track('2.2.2.2', 'ua')
      s.rollOverIfNeeded(new Date('2026-04-08T00:00:01Z'))
      const hist = s.getHistoryDesc(90)
      expect(hist).toEqual([{ date: '2026-04-07', uniqueVisitors: 2 }])
      expect(s.estimateToday()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rollOverIfNeeded is a no-op within the same UTC day', () => {
    const s = VisitorStore.fresh('2026-04-07')
    expect(s.rollOverIfNeeded(new Date('2026-04-07T23:59:59Z'))).toBe(false)
    expect(s.today).toBe('2026-04-07')
  })

  it('manual rollOverIfNeeded resets the salt so the same hash inputs produce a new HLL position', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-07T12:00:00Z'))
    try {
      const s = VisitorStore.fresh('2026-04-07')
      await s.track('1.1.1.1', 'ua-a')
      await s.track('2.2.2.2', 'ua-b')
      expect(s.estimateToday()).toBe(2)

      s.rollOverIfNeeded(new Date('2026-04-08T01:00:00Z'))
      expect(s.today).toBe('2026-04-08')
      expect(s.estimateToday()).toBe(0)
      expect(s.getHistoryDesc(90)).toEqual([{ date: '2026-04-07', uniqueVisitors: 2 }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('trimHistory drops the oldest entries past the cap', () => {
    const s = VisitorStore.fresh('2026-04-10')
    // Manually populate history via rollovers.
    const populate = (date: string) => {
      s['_history'].set(date, 1)
    }
    populate('2026-04-01')
    populate('2026-04-02')
    populate('2026-04-03')
    populate('2026-04-04')
    populate('2026-04-05')

    s.trimHistory(3)
    const hist = s.getHistoryDesc(90)
    expect(hist.map((h) => h.date)).toEqual(['2026-04-05', '2026-04-04', '2026-04-03'])
  })

  it('getHistoryDesc excludes today', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-07T12:00:00Z'))
    try {
      const s = VisitorStore.fresh('2026-04-07')
      await s.track('1.1.1.1', 'ua')
      s.rollOverIfNeeded(new Date('2026-04-08T01:00:00Z'))
      const hist = s.getHistoryDesc(90)
      expect(hist.find((h) => h.date === '2026-04-08')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

import { estimateRegisters } from '@swhsd/hll'
import type { StoreSnapshot } from '../src/types.js'

describe('VisitorStore snapshot/restore', () => {
  it('snapshot() captures today, 32-byte salt, 16 KB registers, and history', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-03T12:00:00Z'))
    try {
      const s = VisitorStore.fresh('2026-06-03')
      await s.track('1.1.1.1', 'ua-a')
      await s.track('2.2.2.2', 'ua-b')
      const snap = await s.snapshot()
      expect(snap.today).toBe('2026-06-03')
      expect(snap.salt.length).toBe(32)
      expect(snap.registers.length).toBe(16384)
      expect(estimateRegisters(snap.registers)).toBe(2)
      expect(snap.history).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('fromSnapshot() resumes the same day and dedupes returning visitors', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-03T12:00:00Z'))
    try {
      const s = VisitorStore.fresh('2026-06-03')
      await s.track('1.1.1.1', 'ua-a')
      await s.track('2.2.2.2', 'ua-b')
      const snap = await s.snapshot()

      const restored = VisitorStore.fromSnapshot(snap, '2026-06-03', null)
      expect(restored.estimateToday()).toBe(2)
      // Same visitor seen before the "restart" must NOT increment (proves the
      // salt was restored, not regenerated).
      await restored.track('1.1.1.1', 'ua-a')
      expect(restored.estimateToday()).toBe(2)
      // A genuinely new visitor does increment.
      await restored.track('3.3.3.3', 'ua-c')
      expect(restored.estimateToday()).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fromSnapshot() finalizes a past day into history and starts today fresh', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-02T12:00:00Z'))
    try {
      const s = VisitorStore.fresh('2026-06-02')
      await s.track('1.1.1.1', 'ua-a')
      await s.track('2.2.2.2', 'ua-b')
      const snap = await s.snapshot()

      const restored = VisitorStore.fromSnapshot(snap, '2026-06-03', null)
      expect(restored.today).toBe('2026-06-03')
      expect(restored.estimateToday()).toBe(0)
      expect(restored.getHistoryDesc(90)).toEqual([
        { date: '2026-06-02', uniqueVisitors: 2 },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('fromSnapshot() seeds prior history alongside a same-day resume', () => {
    const snap: StoreSnapshot = {
      today: '2026-06-03',
      salt: new Uint8Array(32),
      registers: new Uint8Array(16384),
      history: [{ date: '2026-06-01', uniqueVisitors: 11 }],
    }
    const restored = VisitorStore.fromSnapshot(snap, '2026-06-03', null)
    expect(restored.getHistoryDesc(90)).toEqual([
      { date: '2026-06-01', uniqueVisitors: 11 },
    ])
  })
})
