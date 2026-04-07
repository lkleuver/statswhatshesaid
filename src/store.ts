import { computeVisitorHash, generateSalt, utcDateString } from './identity.js'
import { HyperLogLog } from './hll.js'
import type { SnapshotV1 } from './snapshot.js'
import type { DailyCount } from './types.js'

/**
 * Owns the live state that `/stats` reads from: today's HLL sketch, today's
 * salt, and finalized historical daily counts.
 *
 * All mutating operations are synchronous and allocation-light so they can be
 * called from the middleware hot path.
 */
export class VisitorStore {
  private _today: string
  private _salt: Buffer
  private _hll: HyperLogLog
  private _history: Map<string, number>
  private _dirty: boolean

  private constructor(args: {
    today: string
    salt: Buffer
    hll: HyperLogLog
    history: Map<string, number>
    dirty: boolean
  }) {
    this._today = args.today
    this._salt = args.salt
    this._hll = args.hll
    this._history = args.history
    this._dirty = args.dirty
  }

  static fresh(today: string): VisitorStore {
    return new VisitorStore({
      today,
      salt: generateSalt(),
      hll: new HyperLogLog(),
      history: new Map(),
      dirty: true,
    })
  }

  /**
   * Build a store from a persisted snapshot. If the snapshot's `today` no
   * longer matches the current UTC date, the snapshot's HLL is finalized into
   * history and a fresh HLL + salt is created for `currentDate`.
   */
  static fromSnapshot(snap: SnapshotV1, currentDate: string): VisitorStore {
    const history = new Map<string, number>()
    for (const [date, count] of Object.entries(snap.history)) {
      if (typeof count === 'number' && Number.isFinite(count)) {
        history.set(date, count)
      }
    }

    if (snap.today === currentDate) {
      const salt = Buffer.from(snap.salt, 'base64')
      const registers = Buffer.from(snap.hllRegisters, 'base64')
      const hll = new HyperLogLog(new Uint8Array(registers))
      return new VisitorStore({
        today: currentDate,
        salt,
        hll,
        history,
        dirty: false,
      })
    }

    // Day boundary passed while the process was down. Finalize the old
    // sketch's estimate into history, then start today fresh.
    try {
      const registers = Buffer.from(snap.hllRegisters, 'base64')
      const oldHll = new HyperLogLog(new Uint8Array(registers))
      history.set(snap.today, oldHll.estimate())
    } catch {
      /* ignore bad registers; we'd rather lose one day than crash */
    }

    return new VisitorStore({
      today: currentDate,
      salt: generateSalt(),
      hll: new HyperLogLog(),
      history,
      dirty: true,
    })
  }

  get today(): string {
    return this._today
  }

  get dirty(): boolean {
    return this._dirty
  }

  /** Estimated unique visitors so far today. */
  estimateToday(): number {
    return this._hll.estimate()
  }

  /** Hot path. */
  track(ip: string, ua: string): void {
    const hash = computeVisitorHash(ip, ua, this._salt)
    this._hll.addHashBuffer(hash)
    this._dirty = true
  }

  /**
   * If the current UTC date has moved past `this._today`, finalize the
   * previous day into history and start a fresh HLL + salt for the new day.
   * Returns true if a rollover happened.
   */
  rollOverIfNeeded(now: Date = new Date()): boolean {
    const current = utcDateString(now)
    if (current === this._today) return false

    this._history.set(this._today, this._hll.estimate())
    this._today = current
    this._salt = generateSalt()
    this._hll = new HyperLogLog()
    this._dirty = true
    return true
  }

  /** Drop history entries older than `maxDays` days from today (inclusive). */
  trimHistory(maxDays: number): void {
    if (maxDays <= 0) return
    if (this._history.size <= maxDays) return
    const sortedDesc = [...this._history.keys()].sort().reverse()
    for (let i = maxDays; i < sortedDesc.length; i++) {
      this._history.delete(sortedDesc[i]!)
    }
    this._dirty = true
  }

  /** History (excluding today) in descending date order, capped at `limit`. */
  getHistoryDesc(limit: number): DailyCount[] {
    const rows: DailyCount[] = []
    for (const [date, count] of this._history) {
      if (date === this._today) continue
      rows.push({ date, uniqueVisitors: count })
    }
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    return rows.slice(0, limit)
  }

  toSnapshot(): SnapshotV1 {
    return {
      version: 1,
      today: this._today,
      salt: this._salt.toString('base64'),
      hllRegisters: Buffer.from(this._hll.cloneRegisters()).toString('base64'),
      history: Object.fromEntries(this._history),
    }
  }

  markClean(): void {
    this._dirty = false
  }
}
