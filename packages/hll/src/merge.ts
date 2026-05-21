/**
 * Functional helpers operating directly on the 16384-byte register array.
 *
 * These are extracted from the `HyperLogLog` class so the collector can
 * fetch raw register arrays over the wire (base64-encoded), merge them
 * register-wise (element-wise max), and compute a single cardinality
 * estimate — without ever constructing a stateful `HyperLogLog` instance.
 */

import { HLL_REGISTER_COUNT } from './hyperloglog.js'

const ALPHA_M = 0.7213 / (1 + 1.079 / HLL_REGISTER_COUNT)

function assertRegisterLength(arr: Uint8Array, label: string): void {
  if (arr.length !== HLL_REGISTER_COUNT) {
    throw new Error(
      `[swhsd/hll] ${label} must be ${HLL_REGISTER_COUNT} bytes, got ${arr.length}`,
    )
  }
}

/**
 * Merge two HLL register arrays by element-wise maximum. Returns a fresh
 * array; inputs are not modified.
 *
 * This is mathematically equivalent to feeding every hash that produced
 * either input into a single sketch, **provided both sketches were built
 * with the same daily salt**. The collector must verify that precondition
 * (via `saltFingerprint` from the wire response) before calling this.
 */
export function mergeRegisters(a: Uint8Array, b: Uint8Array): Uint8Array {
  assertRegisterLength(a, 'left register array')
  assertRegisterLength(b, 'right register array')
  const out = new Uint8Array(HLL_REGISTER_COUNT)
  for (let i = 0; i < HLL_REGISTER_COUNT; i++) {
    const av = a[i]!
    const bv = b[i]!
    out[i] = av > bv ? av : bv
  }
  return out
}

/**
 * Merge N register arrays via repeated pairwise merge. Returns a fresh
 * array. Throws if `sketches` is empty.
 */
export function mergeManyRegisters(sketches: readonly Uint8Array[]): Uint8Array {
  if (sketches.length === 0) {
    throw new Error('[swhsd/hll] mergeManyRegisters requires at least one input')
  }
  const first = sketches[0]!
  assertRegisterLength(first, 'register array')
  let acc: Uint8Array = new Uint8Array(HLL_REGISTER_COUNT)
  acc.set(first)
  for (let i = 1; i < sketches.length; i++) {
    acc = mergeRegisters(acc, sketches[i]!)
  }
  return acc
}

/**
 * Estimate cardinality directly from a register array. Same formula and
 * small-range correction as `HyperLogLog.estimate()`.
 */
export function estimateRegisters(registers: Uint8Array): number {
  assertRegisterLength(registers, 'register array')
  const m = HLL_REGISTER_COUNT
  let sum = 0
  let zeros = 0
  for (let i = 0; i < m; i++) {
    const r = registers[i]!
    sum += 2 ** -r
    if (r === 0) zeros++
  }
  let estimate = (ALPHA_M * m * m) / sum
  if (estimate <= 2.5 * m && zeros > 0) {
    estimate = m * Math.log(m / zeros)
  }
  return Math.round(estimate)
}

/**
 * Base64 encoder using Web APIs only — works in both Node and Edge runtimes.
 * Produces a fixed ~21,848-character string for our 16,384-byte register
 * array.
 */
export function encodeRegistersBase64(registers: Uint8Array): string {
  assertRegisterLength(registers, 'register array')
  // btoa expects a binary string; build it in 8 KB chunks to avoid blowing
  // the argument list when spreading the typed array.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < registers.length; i += CHUNK) {
    const slice = registers.subarray(i, i + CHUNK)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

/**
 * Inverse of `encodeRegistersBase64`. Throws if the decoded length is not
 * exactly `HLL_REGISTER_COUNT`.
 */
export function decodeRegistersBase64(s: string): Uint8Array {
  const binary = atob(s)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  assertRegisterLength(out, 'decoded register array')
  return out
}
