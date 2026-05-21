import {
  computeSaltFingerprint,
  computeVisitorHash,
  deriveDailySalt,
  generateSalt,
  utcDateString,
} from './identity.js'
import { HyperLogLog } from '@swhsd/hll'
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
 *
 * When `saltSecret` is set, the daily salt is derived as
 * `HMAC-SHA-256(saltSecret, today)`. Derivation is async, so it happens
 * lazily on the first `track()` of each day. When unset, salts are
 * generated synchronously with `crypto.getRandomValues`.
 */
export class VisitorStore {
  private _today: string
  private _salt: Uint8Array | null
  private readonly _saltSecret: string | null
  private _hll: HyperLogLog
  private _history: Map<string, number>

  private constructor(args: {
    today: string
    salt: Uint8Array | null
    saltSecret: string | null
    hll: HyperLogLog
    history: Map<string, number>
  }) {
    this._today = args.today
    this._salt = args.salt
    this._saltSecret = args.saltSecret
    this._hll = args.hll
    this._history = args.history
  }

  static fresh(today: string, saltSecret: string | null = null): VisitorStore {
    return new VisitorStore({
      today,
      // In shared-salt mode the salt is derived lazily on first track,
      // since HMAC requires `await crypto.subtle.sign` and we want `fresh()`
      // to stay synchronous.
      salt: saltSecret ? null : generateSalt(),
      saltSecret,
      hll: new HyperLogLog(),
      history: new Map(),
    })
  }

  get today(): string {
    return this._today
  }

  /** Whether the store is using deterministic (shared) salt derivation. */
  isSharedSaltMode(): boolean {
    return this._saltSecret !== null
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
    const salt = await this.getOrDeriveSalt()
    const hash = await computeVisitorHash(ip, ua, salt)
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
    this._salt = this._saltSecret ? null : generateSalt()
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

  /**
   * Return today's raw HLL register array plus a fingerprint of the salt,
   * for `/stats?format=raw` consumers. Only meaningful in shared-salt mode
   * — fingerprints from random salts can't be cross-checked across
   * replicas. The caller should gate on `isSharedSaltMode()` before calling.
   */
  async exposeTodaySketch(): Promise<{
    registers: Uint8Array
    saltFingerprint: string
  }> {
    this.rollOverIfNeeded()
    const salt = await this.getOrDeriveSalt()
    return {
      registers: this._hll.cloneRegisters(),
      saltFingerprint: await computeSaltFingerprint(salt),
    }
  }

  /**
   * Returns the salt for the current day, deriving it from the shared
   * secret on first call if necessary. Subsequent calls within the same
   * day return the cached value.
   */
  private async getOrDeriveSalt(): Promise<Uint8Array> {
    if (this._salt) return this._salt
    // In shared-salt mode `_salt` is null until first use.
    if (!this._saltSecret) {
      // Defensive — `fresh()` always populates a random salt in non-shared
      // mode, so this branch should be unreachable.
      this._salt = generateSalt()
      return this._salt
    }
    this._salt = await deriveDailySalt(this._saltSecret, this._today)
    return this._salt
  }
}
