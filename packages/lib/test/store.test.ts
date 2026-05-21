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
