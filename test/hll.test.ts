import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { HLL_REGISTER_COUNT, HyperLogLog } from '../src/hll.js'

function hashOf(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

describe('HyperLogLog', () => {
  it('starts empty with the expected register count', () => {
    const hll = new HyperLogLog()
    expect(hll.registers.length).toBe(HLL_REGISTER_COUNT)
    expect(HLL_REGISTER_COUNT).toBe(16384)
    expect(hll.estimate()).toBe(0)
  })

  it('counts a handful of items correctly via linear counting', () => {
    const hll = new HyperLogLog()
    hll.addHashBuffer(hashOf('alice'))
    hll.addHashBuffer(hashOf('bob'))
    hll.addHashBuffer(hashOf('carol'))
    // Small-range correction should land exactly on 3.
    expect(hll.estimate()).toBe(3)
  })

  it('is idempotent for duplicate inserts', () => {
    const hll = new HyperLogLog()
    for (let i = 0; i < 100; i++) hll.addHashBuffer(hashOf('same-visitor'))
    expect(hll.estimate()).toBe(1)
  })

  it('estimates 10,000 unique items within ~2% error', () => {
    const hll = new HyperLogLog()
    const n = 10_000
    for (let i = 0; i < n; i++) hll.addHashBuffer(hashOf(`visitor-${i}`))
    const estimate = hll.estimate()
    const error = Math.abs(estimate - n) / n
    expect(error).toBeLessThan(0.02)
  })

  it('estimates 100,000 unique items within ~2% error', () => {
    const hll = new HyperLogLog()
    const n = 100_000
    for (let i = 0; i < n; i++) hll.addHashBuffer(hashOf(`user-${i}`))
    const estimate = hll.estimate()
    const error = Math.abs(estimate - n) / n
    expect(error).toBeLessThan(0.02)
  })

  it('roundtrips through its register array', () => {
    const a = new HyperLogLog()
    for (let i = 0; i < 1000; i++) a.addHashBuffer(hashOf(`x-${i}`))
    const b = new HyperLogLog(a.cloneRegisters())
    expect(b.estimate()).toBe(a.estimate())
  })

  it('rejects a wrong-sized register array', () => {
    expect(() => new HyperLogLog(new Uint8Array(10))).toThrow()
  })
})
