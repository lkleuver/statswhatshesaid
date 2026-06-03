import { describe, expect, it, vi } from 'vitest'
import {
  serializeSnapshot,
  deserializeSnapshot,
  PersistenceController,
} from '../src/persistence.js'
import { VisitorStore } from '../src/store.js'
import { resolveConfig } from '../src/config.js'
import { utcDateString } from '../src/identity.js'
import type { StoreSnapshot, StatsSnapshot } from '../src/types.js'

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

const CTRL_TOKEN = 'persist-ctrl-secret-xxxxxxxxxxxxxxxxxxxxxxxxxx'

// Drain the microtask queue so fire-and-forget saves settle. Works under
// vi.useFakeTimers() because microtasks are not faked.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function fakePersistence() {
  let stored: StatsSnapshot | null = null
  const loadCalls = { n: 0 }
  const saveCalls = { n: 0 }
  return {
    api: {
      load: async () => {
        loadCalls.n++
        return stored
      },
      save: async (s: StatsSnapshot) => {
        saveCalls.n++
        stored = s
      },
    },
    set: (s: StatsSnapshot | null) => {
      stored = s
    },
    loadCalls,
    saveCalls,
  }
}

function runtimeWith(persistence: ReturnType<typeof fakePersistence>['api'], debounceMs = 30000) {
  const config = resolveConfig({
    token: CTRL_TOKEN,
    persistence,
    persistSaveDebounceMs: debounceMs,
  })
  return { config, store: VisitorStore.fresh('2026-06-03', null) }
}

describe('PersistenceController', () => {
  it('hydrates from a stored snapshot exactly once for concurrent callers', async () => {
    const fake = fakePersistence()
    const today = utcDateString(new Date())
    const seed = VisitorStore.fresh(today, null)
    await seed.track('1.1.1.1', 'ua-a')
    await seed.track('2.2.2.2', 'ua-b')
    fake.set(serializeSnapshot(await seed.snapshot()))

    const runtime = runtimeWith(fake.api)
    const controller = new PersistenceController(fake.api, 30000)
    await Promise.all([
      controller.ensureHydrated(runtime),
      controller.ensureHydrated(runtime),
      controller.ensureHydrated(runtime),
    ])
    expect(fake.loadCalls.n).toBe(1)
    expect(runtime.store.estimateToday()).toBe(2)
  })

  it('proceeds fresh and does not retry when load rejects', async () => {
    const failing = {
      load: vi.fn(async () => {
        throw new Error('db down')
      }),
      save: async () => {},
    }
    const runtime = runtimeWith(failing)
    const controller = new PersistenceController(failing, 30000)
    await controller.ensureHydrated(runtime)
    await controller.ensureHydrated(runtime)
    expect(failing.load).toHaveBeenCalledTimes(1)
    expect(runtime.store.estimateToday()).toBe(0)
  })

  it('debounces saves and forces one when the day rolls over', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-03T12:00:00Z'))
    try {
      const fake = fakePersistence()
      const runtime = runtimeWith(fake.api, 30000)
      const controller = new PersistenceController(fake.api, 30000)

      controller.maybeSave(runtime) // first call always eligible (lastSaveAt=0)
      await flushMicrotasks()
      expect(fake.saveCalls.n).toBe(1)

      controller.maybeSave(runtime) // within the debounce window → skipped
      await flushMicrotasks()
      expect(fake.saveCalls.n).toBe(1)

      vi.setSystemTime(new Date('2026-06-03T12:01:00Z')) // +60s > 30s debounce
      controller.maybeSave(runtime)
      await flushMicrotasks()
      expect(fake.saveCalls.n).toBe(2)

      // Roll the store into a new day, then save: forced regardless of debounce.
      vi.setSystemTime(new Date('2026-06-04T00:00:01Z'))
      runtime.store.rollOverIfNeeded(new Date())
      controller.maybeSave(runtime)
      await flushMicrotasks()
      expect(fake.saveCalls.n).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('swallows save errors without throwing', async () => {
    const failing = {
      load: async () => null,
      save: async () => {
        throw new Error('write failed')
      },
    }
    const runtime = runtimeWith(failing, 0)
    const controller = new PersistenceController(failing, 0)
    expect(() => controller.maybeSave(runtime)).not.toThrow()
    await flushMicrotasks()
  })
})
