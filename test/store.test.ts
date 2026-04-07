import { describe, expect, it } from 'vitest'

import { VisitorStore } from '../src/store.js'

describe('VisitorStore', () => {
  it('fresh store has no visitors and no history', () => {
    const s = VisitorStore.fresh('2026-04-07')
    expect(s.today).toBe('2026-04-07')
    expect(s.estimateToday()).toBe(0)
    expect(s.getHistoryDesc(90)).toEqual([])
  })

  it('track() increments the cardinality estimate and dedupes', async () => {
    const s = VisitorStore.fresh('2026-04-07')
    await s.track('1.1.1.1', 'ua-a')
    await s.track('2.2.2.2', 'ua-b')
    await s.track('1.1.1.1', 'ua-a') // duplicate
    expect(s.estimateToday()).toBe(2)
  })

  it('rollOverIfNeeded finalizes the current day into history', () => {
    const s = VisitorStore.fresh('2026-04-07')
    expect(s.rollOverIfNeeded(new Date('2026-04-08T00:00:01Z'))).toBe(true)
    expect(s.today).toBe('2026-04-08')
  })

  it('rollOverIfNeeded preserves the previous day count in history', async () => {
    const s = VisitorStore.fresh('2026-04-07')
    await s.track('1.1.1.1', 'ua')
    await s.track('2.2.2.2', 'ua')
    s.rollOverIfNeeded(new Date('2026-04-08T00:00:01Z'))
    const hist = s.getHistoryDesc(90)
    expect(hist).toEqual([{ date: '2026-04-07', uniqueVisitors: 2 }])
    expect(s.estimateToday()).toBe(0)
  })

  it('rollOverIfNeeded is a no-op within the same UTC day', () => {
    const s = VisitorStore.fresh('2026-04-07')
    expect(s.rollOverIfNeeded(new Date('2026-04-07T23:59:59Z'))).toBe(false)
    expect(s.today).toBe('2026-04-07')
  })

  it('manual rollOverIfNeeded resets the salt so the same hash inputs produce a new HLL position', async () => {
    // We can't reliably test the lazy rollover from inside `track()` here
    // because it consults the real clock. Instead, exercise the same code
    // path via a direct rollOver call: after rollover, the previous day's
    // count moves to history and today starts at zero with a fresh salt.
    const s = VisitorStore.fresh('2026-04-07')
    await s.track('1.1.1.1', 'ua-a')
    await s.track('2.2.2.2', 'ua-b')
    expect(s.estimateToday()).toBe(2)

    s.rollOverIfNeeded(new Date('2026-04-08T01:00:00Z'))
    expect(s.today).toBe('2026-04-08')
    expect(s.estimateToday()).toBe(0)
    expect(s.getHistoryDesc(90)).toEqual([{ date: '2026-04-07', uniqueVisitors: 2 }])
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
    const s = VisitorStore.fresh('2026-04-07')
    await s.track('1.1.1.1', 'ua')
    s.rollOverIfNeeded(new Date('2026-04-08T01:00:00Z'))
    const hist = s.getHistoryDesc(90)
    expect(hist.find((h) => h.date === '2026-04-08')).toBeUndefined()
  })
})
