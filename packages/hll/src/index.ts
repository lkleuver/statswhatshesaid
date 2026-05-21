/**
 * `@swhsd/hll` — internal HyperLogLog primitives shared between the library
 * and the collector. Private workspace package; not published.
 *
 * The class API (`HyperLogLog`) is used by the library on the hot path.
 * The functional helpers (`mergeRegisters`, `estimateRegisters`,
 * `encodeRegistersBase64`, `decodeRegistersBase64`) are used by the
 * collector when fetching raw sketches from replicas and merging them.
 *
 * Both APIs operate on the same 16384-byte register array layout, so they
 * are fully interoperable.
 */

export {
  HyperLogLog,
  HLL_PRECISION,
  HLL_REGISTER_COUNT,
} from './hyperloglog.js'

export {
  mergeRegisters,
  mergeManyRegisters,
  estimateRegisters,
  encodeRegistersBase64,
  decodeRegistersBase64,
} from './merge.js'
