import { computeVisitorHash, generateSalt, utcDateString } from './identity.js'
import { HyperLogLog } from './hll.js'
import type { DailyCount } from './types.js'

/**
 * Owns the in-memory live state that `/stats` reads from: today's HLL
 * sketch, today's salt, and finalized historical daily counts.
 *
 * No persistence — counts and history live in process memory only and are
 * lost on process restart. Within a single Edge isolate or Node process,
 * state survives across requests because module-level singletons in Next.js
 * middleware persist for the worker's lifetime.
 *
 * `track` is async because the visitor hash uses Web Crypto's
 * `crypto.subtle.digest`, which has no synchronous counterpart in the Edge
 * runtime. Next.js middleware natively supports async functions.
 */
export class VisitorStore {
  private _today: string
  private _salt: Uint8Array
  private _hll: HyperLogLog
  private _history: Map<string, number>

  private constructor(args: {
    today: string
    salt: Uint8Array
    hll: HyperLogLog
    history: Map<string, number>
  }) {
    this._today = args.today
    this._salt = args.salt
    this._hll = args.hll
    this._history = args.history
  }

  static fresh(today: string): VisitorStore {
    return new VisitorStore({
      today,
      salt: generateSalt(),
      hll: new HyperLogLog(),
      history: new Map(),
    })
  }

  get today(): string {
    return this._today
  }

  /** Estimated unique visitors so far today. */
  estimateToday(): number {
    return this._hll.estimate()
  }

  /**
   * Hot path. Lazily rolls over the day if needed (so we don't depend on a
   * background timer that may be unreliable in Edge isolates), then hashes
   * and adds the visitor to the HLL sketch.
   */
  async track(ip: string, ua: string): Promise<void> {
    this.rollOverIfNeeded()
    const hash = await computeVisitorHash(ip, ua, this._salt)
    this._hll.addHashBuffer(hash)
  }

  /**
   * If the current UTC date has moved past `this._today`, finalize the
   * previous day into history and start a fresh HLL + salt for the new day.
   * Returns true if a rollover happened. Cheap enough to call on every
   * request (one Date allocation, one string compare).
   */
  rollOverIfNeeded(now: Date = new Date()): boolean {
    const current = utcDateString(now)
    if (current === this._today) return false

    this._history.set(this._today, this._hll.estimate())
    this._today = current
    this._salt = generateSalt()
    this._hll = new HyperLogLog()
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
}
