import { describe, expect, it } from 'vitest'
import {
  serializeSnapshot,
  deserializeSnapshot,
} from '../src/persistence.js'
import type { StoreSnapshot } from '../src/types.js'

function rawSnapshot(): StoreSnapshot {
  const salt = new Uint8Array(32).fill(7)
  const registers = new Uint8Array(16384)
  registers[0] = 5
  registers[100] = 9
  return {
    today: '2026-06-03',
    salt,
    registers,
    history: [{ date: '2026-06-02', uniqueVisitors: 42 }],
  }
}

describe('snapshot serialize/deserialize', () => {
  it('round-trips raw → serialized → raw', () => {
    const raw = rawSnapshot()
    const blob = serializeSnapshot(raw)
    expect(blob.version).toBe(1)
    expect(blob.today).toBe('2026-06-03')
    expect(typeof blob.salt).toBe('string')
    expect(typeof blob.registers).toBe('string')

    const back = deserializeSnapshot(blob)
    expect(back).not.toBeNull()
    expect(back!.today).toBe('2026-06-03')
    expect([...back!.salt]).toEqual([...raw.salt])
    expect([...back!.registers]).toEqual([...raw.registers])
    expect(back!.history).toEqual(raw.history)
  })

  it('returns null for an unknown version', () => {
    const blob = serializeSnapshot(rawSnapshot()) as Record<string, unknown>
    expect(deserializeSnapshot({ ...blob, version: 2 })).toBeNull()
  })

  it('returns null for a malformed today', () => {
    const blob = serializeSnapshot(rawSnapshot()) as Record<string, unknown>
    expect(deserializeSnapshot({ ...blob, today: 'not-a-date' })).toBeNull()
  })

  it('returns null when registers decode to the wrong length', () => {
    const blob = serializeSnapshot(rawSnapshot()) as Record<string, unknown>
    expect(deserializeSnapshot({ ...blob, registers: 'AAAA' })).toBeNull()
  })

  it('returns null when salt decodes to the wrong length', () => {
    const blob = serializeSnapshot(rawSnapshot()) as Record<string, unknown>
    expect(deserializeSnapshot({ ...blob, salt: 'AAAA' })).toBeNull()
  })

  it('returns null for malformed history entries', () => {
    const blob = serializeSnapshot(rawSnapshot()) as Record<string, unknown>
    expect(
      deserializeSnapshot({ ...blob, history: [{ date: 'x', uniqueVisitors: 1 }] }),
    ).toBeNull()
  })

  it('returns null for a negative visitor count', () => {
    const blob = serializeSnapshot(rawSnapshot()) as Record<string, unknown>
    expect(
      deserializeSnapshot({ ...blob, history: [{ date: '2026-06-02', uniqueVisitors: -1 }] }),
    ).toBeNull()
  })

  it('returns null for non-object input', () => {
    expect(deserializeSnapshot(null)).toBeNull()
    expect(deserializeSnapshot('nope')).toBeNull()
  })
})
