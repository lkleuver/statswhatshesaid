import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  HLL_REGISTER_COUNT,
  HyperLogLog,
  decodeRegistersBase64,
  encodeRegistersBase64,
  estimateRegisters,
  mergeManyRegisters,
  mergeRegisters,
} from '../src/index.js'

function hashOf(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

function sketchOf(items: readonly string[]): Uint8Array {
  const hll = new HyperLogLog()
  for (const item of items) hll.addHashBuffer(hashOf(item))
  return hll.cloneRegisters()
}

describe('mergeRegisters', () => {
  it('produces an empty sketch when both inputs are empty', () => {
    const a = new Uint8Array(HLL_REGISTER_COUNT)
    const b = new Uint8Array(HLL_REGISTER_COUNT)
    const merged = mergeRegisters(a, b)
    expect(merged).toEqual(new Uint8Array(HLL_REGISTER_COUNT))
    expect(estimateRegisters(merged)).toBe(0)
  })

  it('is element-wise max', () => {
    const a = new Uint8Array(HLL_REGISTER_COUNT)
    const b = new Uint8Array(HLL_REGISTER_COUNT)
    a[0] = 5
    b[0] = 3
    a[1] = 2
    b[1] = 7
    const merged = mergeRegisters(a, b)
    expect(merged[0]).toBe(5)
    expect(merged[1]).toBe(7)
  })

  it('rejects mismatched register lengths', () => {
    expect(() => mergeRegisters(new Uint8Array(10), new Uint8Array(HLL_REGISTER_COUNT))).toThrow()
    expect(() => mergeRegisters(new Uint8Array(HLL_REGISTER_COUNT), new Uint8Array(10))).toThrow()
  })

  it('is mathematically equivalent to feeding all items into a single sketch', () => {
    // Split 5000 disjoint items between two replicas, merge their sketches,
    // and confirm the merged estimate matches a single-sketch ground truth.
    const all: string[] = []
    for (let i = 0; i < 5000; i++) all.push(`visitor-${i}`)
    const halfA = all.slice(0, 2500)
    const halfB = all.slice(2500)

    const sketchA = sketchOf(halfA)
    const sketchB = sketchOf(halfB)
    const merged = mergeRegisters(sketchA, sketchB)
    const single = sketchOf(all)

    // The two sketches must be byte-identical when fed the same hashes
    // through the merge math vs through a single sketch directly.
    expect(merged).toEqual(single)
    expect(estimateRegisters(merged)).toBe(estimateRegisters(single))
  })
})

describe('mergeManyRegisters', () => {
  it('throws on empty input', () => {
    expect(() => mergeManyRegisters([])).toThrow()
  })

  it('returns a copy when given a single sketch', () => {
    const a = sketchOf(['x', 'y', 'z'])
    const merged = mergeManyRegisters([a])
    expect(merged).toEqual(a)
    // Different backing buffer — caller can't accidentally mutate the input.
    expect(merged).not.toBe(a)
  })

  it('matches pairwise merge for N inputs', () => {
    const sketchA = sketchOf(['a1', 'a2', 'a3'])
    const sketchB = sketchOf(['b1', 'b2', 'b3'])
    const sketchC = sketchOf(['c1', 'c2', 'c3'])
    const viaMany = mergeManyRegisters([sketchA, sketchB, sketchC])
    const viaPairwise = mergeRegisters(mergeRegisters(sketchA, sketchB), sketchC)
    expect(viaMany).toEqual(viaPairwise)
  })
})

describe('base64 round-trip', () => {
  it('encodes and decodes back to the original bytes', () => {
    const original = sketchOf(['alpha', 'beta', 'gamma', 'delta'])
    const encoded = encodeRegistersBase64(original)
    const decoded = decodeRegistersBase64(encoded)
    expect(decoded).toEqual(original)
  })

  it('rejects decoded payloads of the wrong length', () => {
    // 4 bytes of base64 = 3 bytes decoded — not a valid sketch.
    expect(() => decodeRegistersBase64('AAAA')).toThrow()
  })
})
