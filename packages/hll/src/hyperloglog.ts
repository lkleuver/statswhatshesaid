/**
 * Pure-JS HyperLogLog sketch for cardinality estimation.
 *
 * Parameters:
 *   - p = 14 (precision)
 *   - m = 2^14 = 16384 registers (one byte each → 16 KB fixed footprint)
 *   - Expected standard error ≈ 1.04 / sqrt(m) ≈ 0.81%
 *
 * The input is the first 8 bytes of a pre-computed hash (we use SHA-256 in
 * `identity.ts`, so we have plenty of bits to work with). The top `P` bits
 * select a register; the remaining `64 - P = 50` bits are scanned for their
 * leading-zero rank.
 *
 * Reference: Flajolet et al., "HyperLogLog: the analysis of a near-optimal
 * cardinality estimation algorithm" (2007).
 */

const P = 14
export const HLL_PRECISION = P
export const HLL_REGISTER_COUNT = 1 << P // 16384
const TAIL_HIGH_BITS = 32 - P // 18
const TAIL_HIGH_MASK = (1 << TAIL_HIGH_BITS) - 1 // 0x3FFFF
const TAIL_TOTAL_BITS = 64 - P // 50
const MAX_RANK = TAIL_TOTAL_BITS + 1 // 51

/**
 * Hand-tuned alpha constant per the HLL paper.
 * For m ≥ 128 the formula below is accurate; our m is always 16384.
 */
const ALPHA_M = 0.7213 / (1 + 1.079 / HLL_REGISTER_COUNT)

export class HyperLogLog {
  readonly registers: Uint8Array

  constructor(registers?: Uint8Array) {
    if (registers) {
      if (registers.length !== HLL_REGISTER_COUNT) {
        throw new Error(
          `[statswhatshesaid] HLL registers must be ${HLL_REGISTER_COUNT} bytes, got ${registers.length}`,
        )
      }
      // Take ownership of a copy so external mutation can't corrupt us.
      this.registers = new Uint8Array(registers)
    } else {
      this.registers = new Uint8Array(HLL_REGISTER_COUNT)
    }
  }

  /**
   * Add a 64-bit hash (the first 8 bytes of a larger buffer are fine) to the
   * sketch. This is the only mutating call on the hot path. Accepts any
   * `Uint8Array` (including Node `Buffer`, which is a subclass).
   */
  addHashBuffer(buf: Uint8Array): void {
    if (buf.length < 8) {
      throw new Error(
        `[statswhatshesaid] HLL hash input must be at least 8 bytes, got ${buf.length}`,
      )
    }
    // Big-endian view of the first 8 bytes. Use DataView so we don't depend
    // on Node's Buffer methods (we want to run in Edge runtime too).
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const first = dv.getUint32(0, false)
    const second = dv.getUint32(4, false)

    // Top P=14 bits of the 64-bit hash → register index.
    const idx = first >>> TAIL_HIGH_BITS

    // Leading-zero rank of the remaining 50 bits, +1.
    const tailHigh = first & TAIL_HIGH_MASK // 18 bits
    let rank: number
    if (tailHigh !== 0) {
      // clz32 on an 18-bit value returns (14 + leadingZerosIn18BitView),
      // so subtracting 14 gives the 18-bit leading zero count, and +1
      // converts it to the 1-indexed rank.
      rank = Math.clz32(tailHigh) - 14 + 1
    } else if (second !== 0) {
      // All 18 high tail bits were zero; continue in the next 32 bits.
      rank = 18 + Math.clz32(second) + 1
    } else {
      // All 50 tail bits are zero.
      rank = MAX_RANK
    }

    if (rank > this.registers[idx]!) {
      this.registers[idx] = rank
    }
  }

  /**
   * Estimated number of distinct items inserted.
   * Applies the linear-counting correction for small cardinalities.
   */
  estimate(): number {
    const m = HLL_REGISTER_COUNT
    let sum = 0
    let zeros = 0
    for (let i = 0; i < m; i++) {
      const r = this.registers[i]!
      sum += 2 ** -r
      if (r === 0) zeros++
    }
    let estimate = (ALPHA_M * m * m) / sum
    // Small-range correction: linear counting is more accurate when the
    // raw estimate drops below ~2.5m and we still have empty registers.
    if (estimate <= 2.5 * m && zeros > 0) {
      estimate = m * Math.log(m / zeros)
    }
    return Math.round(estimate)
  }

  /** Deep copy the register array for serialization. */
  cloneRegisters(): Uint8Array {
    return new Uint8Array(this.registers)
  }

  static fromRegisters(registers: Uint8Array): HyperLogLog {
    return new HyperLogLog(registers)
  }
}
