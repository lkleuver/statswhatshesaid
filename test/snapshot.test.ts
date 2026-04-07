import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileSnapshotAdapter, type SnapshotV1 } from '../src/snapshot.js'
import { HLL_REGISTER_COUNT } from '../src/hll.js'

function fakeSnap(overrides: Partial<SnapshotV1> = {}): SnapshotV1 {
  return {
    version: 1,
    today: '2026-04-07',
    salt: Buffer.alloc(32, 1).toString('base64'),
    hllRegisters: Buffer.alloc(HLL_REGISTER_COUNT, 0).toString('base64'),
    history: { '2026-04-06': 42 },
    ...overrides,
  }
}

describe('FileSnapshotAdapter', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'statswhatshesaid-'))
    path = join(dir, 'stats.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when no file exists', () => {
    const a = new FileSnapshotAdapter(path)
    expect(a.load()).toBeNull()
  })

  it('saves and loads a roundtrip', () => {
    const a = new FileSnapshotAdapter(path)
    const snap = fakeSnap()
    a.save(snap)

    const loaded = a.load()
    expect(loaded).not.toBeNull()
    expect(loaded!.today).toBe('2026-04-07')
    expect(loaded!.history['2026-04-06']).toBe(42)
    expect(loaded!.salt).toBe(snap.salt)
    expect(loaded!.hllRegisters.length).toBe(snap.hllRegisters.length)
  })

  it('rejects a corrupt JSON file as null (not a crash)', () => {
    writeFileSync(path, '{not valid json', 'utf8')
    const a = new FileSnapshotAdapter(path)
    expect(a.load()).toBeNull()
  })

  it('rejects a wrong-version snapshot', () => {
    writeFileSync(path, JSON.stringify({ ...fakeSnap(), version: 99 }), 'utf8')
    const a = new FileSnapshotAdapter(path)
    expect(a.load()).toBeNull()
  })

  it('rejects a snapshot with wrong-sized HLL registers', () => {
    const bad = { ...fakeSnap(), hllRegisters: 'AA==' }
    writeFileSync(path, JSON.stringify(bad), 'utf8')
    const a = new FileSnapshotAdapter(path)
    expect(a.load()).toBeNull()
  })

  it('writes atomically via a .tmp rename', () => {
    const a = new FileSnapshotAdapter(path)
    a.save(fakeSnap())
    // The .tmp sidecar should be gone after a successful save.
    const raw = readFileSync(path, 'utf8')
    expect(raw.length).toBeGreaterThan(0)
    expect(() => readFileSync(`${path}.tmp`, 'utf8')).toThrow()
  })

  it('creates the parent directory if missing', () => {
    const nested = join(dir, 'a', 'b', 'stats.json')
    const a = new FileSnapshotAdapter(nested)
    a.save(fakeSnap())
    expect(readFileSync(nested, 'utf8').length).toBeGreaterThan(0)
  })
})
