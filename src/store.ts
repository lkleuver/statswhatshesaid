import {
  computeVisitorHash,
  generateSalt,
  isValidUtcDate,
  SALT_BYTES,
  utcDateString,
} from './identity.js'
import { HLL_REGISTER_COUNT, HyperLogLog } from './hll.js'
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
   *
   * This path is the main "untrusted JSON" boundary — defensive at every
   * step. Any decode/validation failure degrades gracefully: we keep what
   * we can of history and start today fresh.
   */
  static fromSnapshot(snap: SnapshotV1, currentDate: string): VisitorStore {
    const history = sanitizeHistory(snap.history, currentDate)

    if (snap.today === currentDate) {
      // Same-day restore: try to recover the salt + HLL registers so that
      // a returning visitor within the same UTC day doesn't get double-
      // counted. On ANY failure, start fresh — dropping a few minutes of
      // deduped state is better than crashing the app.
      try {
        const salt = decodeSalt(snap.salt)
        const registers = decodeRegisters(snap.hllRegisters)
        const hll = new HyperLogLog(registers)
        return new VisitorStore({
          today: currentDate,
          salt,
          hll,
          history,
          dirty: false,
        })
      } catch {
        return new VisitorStore({
          today: currentDate,
          salt: generateSalt(),
          hll: new HyperLogLog(),
          history,
          dirty: true,
        })
      }
    }

    // Day boundary passed while the process was down. Finalize the old
    // sketch's estimate into history, then start today fresh.
    try {
      const registers = decodeRegisters(snap.hllRegisters)
      const oldHll = new HyperLogLog(registers)
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

/**
 * Decode and validate a base64 salt field. Throws if it doesn't decode to
 * exactly `SALT_BYTES` bytes. Callers should catch and fall back.
 */
function decodeSalt(saltBase64: string): Buffer {
  const salt = Buffer.from(saltBase64, 'base64')
  if (salt.length !== SALT_BYTES) {
    throw new Error(
      `invalid snapshot salt: expected ${SALT_BYTES} bytes, got ${salt.length}`,
    )
  }
  return salt
}

/**
 * Decode and validate a base64 HLL register array. Throws if it doesn't
 * decode to exactly `HLL_REGISTER_COUNT` bytes. `Buffer.from(x, 'base64')`
 * is lenient and silently ignores malformed characters, so we can't rely on
 * the base64 string length alone — the decoded byte count is the real
 * invariant the HLL constructor cares about.
 */
function decodeRegisters(registersBase64: string): Uint8Array {
  const buf = Buffer.from(registersBase64, 'base64')
  if (buf.length !== HLL_REGISTER_COUNT) {
    throw new Error(
      `invalid snapshot registers: expected ${HLL_REGISTER_COUNT} bytes, got ${buf.length}`,
    )
  }
  return new Uint8Array(buf)
}

/**
 * Filter a raw `history` object from an untrusted snapshot down to a clean
 * Map, dropping any entry that isn't a real `YYYY-MM-DD` date key mapped
 * to a non-negative integer. Also drops an entry matching `currentDate` —
 * today's count is owned by the live HLL, not history.
 */
function sanitizeHistory(
  raw: Record<string, number>,
  currentDate: string,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const [date, count] of Object.entries(raw)) {
    if (!isValidUtcDate(date)) continue
    if (date === currentDate) continue
    if (typeof count !== 'number') continue
    if (!Number.isFinite(count) || !Number.isInteger(count)) continue
    if (count < 0) continue
    out.set(date, count)
  }
  return out
}
