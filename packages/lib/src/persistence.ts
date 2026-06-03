import {
  encodeRegistersBase64,
  decodeRegistersBase64,
} from '@swhsd/hll'

import { isValidUtcDate, SALT_BYTES } from './identity.js'
import type { DailyCount, StatsSnapshot, StoreSnapshot } from './types.js'

export type { StatsSnapshot, StatsPersistence } from './types.js'

const SNAPSHOT_VERSION = 1 as const

/** Base64-encode an arbitrary byte array (Web APIs only — Edge-safe). */
function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

/** Inverse of `encodeBytesBase64`. Throws unless the result is `expectedLen`. */
function decodeBytesBase64(s: string, expectedLen: number): Uint8Array {
  const binary = atob(s)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  if (out.length !== expectedLen) {
    throw new Error(
      `[statswhatshesaid] expected ${expectedLen} bytes, got ${out.length}`,
    )
  }
  return out
}

export function serializeSnapshot(raw: StoreSnapshot): StatsSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    today: raw.today,
    salt: encodeBytesBase64(raw.salt),
    registers: encodeRegistersBase64(raw.registers),
    history: raw.history,
  }
}

/**
 * Parse + validate an untrusted stored value into a `StoreSnapshot`. Returns
 * `null` (and warns once) for anything absent, malformed, corrupt, or of an
 * unsupported version — the caller then starts fresh rather than crashing.
 */
export function deserializeSnapshot(value: unknown): StoreSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>

  if (v.version !== SNAPSHOT_VERSION) return warnNull('unsupported version')
  if (typeof v.today !== 'string' || !isValidUtcDate(v.today)) {
    return warnNull('invalid today')
  }
  if (typeof v.salt !== 'string' || typeof v.registers !== 'string') {
    return warnNull('missing salt/registers')
  }
  if (!Array.isArray(v.history)) return warnNull('invalid history')

  let salt: Uint8Array
  let registers: Uint8Array
  // Both decoders throw on corrupt or wrong-length input.
  try {
    salt = decodeBytesBase64(v.salt, SALT_BYTES)
    registers = decodeRegistersBase64(v.registers)
  } catch {
    return warnNull('corrupt salt/registers')
  }

  const history: DailyCount[] = []
  for (const h of v.history) {
    if (!h || typeof h !== 'object') return warnNull('invalid history entry')
    const date = (h as Record<string, unknown>).date
    const uniqueVisitors = (h as Record<string, unknown>).uniqueVisitors
    if (
      typeof date !== 'string' ||
      !isValidUtcDate(date) ||
      typeof uniqueVisitors !== 'number' ||
      !Number.isInteger(uniqueVisitors) ||
      uniqueVisitors < 0
    ) {
      return warnNull('invalid history entry')
    }
    history.push({ date, uniqueVisitors })
  }

  return { today: v.today, salt, registers, history }
}

function warnNull(reason: string): null {
  // eslint-disable-next-line no-console
  console.warn(
    `[statswhatshesaid] ignoring persisted snapshot (${reason}); starting fresh.`,
  )
  return null
}
