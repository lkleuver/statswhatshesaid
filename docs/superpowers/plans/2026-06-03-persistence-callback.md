# Persistence Callback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `persistence: { load, save }` config to the `statswhatshesaid` library so a single-instance app survives deploys/restarts without losing today's live unique-visitor sketch.

**Architecture:** A new `PersistenceController` (in `packages/lib/src/persistence.ts`) hydrates the in-memory `VisitorStore` once on the first request and triggers debounced, fire-and-forget saves on the request path. The library serializes its state into an opaque base64+JSON `StatsSnapshot` (today's salt + 16 KB HLL registers + finalized history); the user provides two async callbacks that read/write that blob to their own store (Postgres). No timers, no signal handlers, zero new runtime dependencies.

**Tech Stack:** TypeScript, Vitest, `@swhsd/hll` (workspace), Next.js types. Test commands run from `packages/lib`.

---

## File structure

- **Create** `packages/lib/src/persistence.ts` — `StatsSnapshot`/`StatsPersistence` are re-exported from here; base64 byte helpers; `serializeSnapshot` / `deserializeSnapshot`; `PersistenceController`.
- **Create** `packages/lib/test/persistence.test.ts` — unit tests for serialize/deserialize/validate and the controller.
- **Modify** `packages/lib/src/types.ts` — add `StatsSnapshot`, `StatsPersistence`, `StoreSnapshot`; extend `StatsOptions` and `ResolvedConfig`.
- **Modify** `packages/lib/src/config.ts` — validate + resolve `persistence` and `persistSaveDebounceMs`.
- **Modify** `packages/lib/src/store.ts` — add `historyEntries()`, `snapshot()`, and `static fromSnapshot()`.
- **Modify** `packages/lib/src/lifecycle.ts` — attach a `PersistenceController` to the runtime.
- **Modify** `packages/lib/src/middleware.ts` — `ensureHydrated` then `maybeSave` on the track path.
- **Modify** `packages/lib/src/endpoint.ts` — `ensureHydrated` before reading the store.
- **Modify** `packages/lib/src/index.ts` — export the new public types.
- **Modify** `packages/lib/test/store.test.ts` — tests for the new store methods.
- **Modify** `packages/lib/test/integration.test.ts` — end-to-end "survive a deploy" test.
- **Modify** `packages/lib/README.md` — Persistence subsection.
- **Create** `.changeset/<name>.md` — minor version bump changeset.

Type contracts locked across tasks:

```ts
// Serialized blob the user stores (base64 + JSON).
interface StatsSnapshot {
  version: 1
  today: string                 // YYYY-MM-DD (UTC)
  salt: string                  // base64 of 32 bytes
  registers: string             // base64 of 16384 bytes
  history: DailyCount[]
}
// Raw in-memory form passed between store and persistence module.
interface StoreSnapshot {
  today: string
  salt: Uint8Array              // 32 bytes
  registers: Uint8Array         // 16384 bytes
  history: DailyCount[]
}
interface StatsPersistence {
  load: () => Promise<StatsSnapshot | null>
  save: (snapshot: StatsSnapshot) => Promise<void>
}
// store.ts
class VisitorStore {
  historyEntries(): DailyCount[]                                   // all history, excl. today, uncapped
  snapshot(): Promise<StoreSnapshot>
  static fromSnapshot(raw: StoreSnapshot, currentToday: string, saltSecret: string | null): VisitorStore
}
// persistence.ts
function serializeSnapshot(raw: StoreSnapshot): StatsSnapshot
function deserializeSnapshot(value: unknown): StoreSnapshot | null  // null = absent/invalid/unsupported
class PersistenceController {
  constructor(persistence: StatsPersistence, debounceMs: number)
  ensureHydrated(runtime: StatsRuntime): Promise<void>             // memoized
  maybeSave(runtime: StatsRuntime): void                           // debounced, fire-and-forget
}
```

---

## Task 1: Types + config plumbing

**Files:**
- Modify: `packages/lib/src/types.ts`
- Modify: `packages/lib/src/config.ts`
- Test: `packages/lib/test/config.test.ts` (create if absent)

- [ ] **Step 1: Write the failing config tests**

Create/append `packages/lib/test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'

const TOKEN = 'config-test-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxx'
const noop = async () => {}

describe('resolveConfig persistence', () => {
  it('defaults persistence to null and debounce to 30000', () => {
    const c = resolveConfig({ token: TOKEN })
    expect(c.persistence).toBeNull()
    expect(c.persistSaveDebounceMs).toBe(30000)
  })

  it('accepts a valid persistence object', () => {
    const persistence = { load: async () => null, save: noop }
    const c = resolveConfig({ token: TOKEN, persistence })
    expect(c.persistence).toBe(persistence)
  })

  it('throws when persistence is missing a function', () => {
    expect(() =>
      // @ts-expect-error intentionally invalid
      resolveConfig({ token: TOKEN, persistence: { load: async () => null } }),
    ).toThrow(/load.*save/)
  })

  it('honors a custom persistSaveDebounceMs', () => {
    const c = resolveConfig({ token: TOKEN, persistSaveDebounceMs: 5000 })
    expect(c.persistSaveDebounceMs).toBe(5000)
  })

  it('rejects a negative persistSaveDebounceMs', () => {
    expect(() =>
      resolveConfig({ token: TOKEN, persistSaveDebounceMs: -1 }),
    ).toThrow(/persistSaveDebounceMs/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace packages/lib -- config.test.ts`
Expected: FAIL — `persistence`/`persistSaveDebounceMs` not on `ResolvedConfig`, no validation.

- [ ] **Step 3: Add the types**

In `packages/lib/src/types.ts`, add `DailyCount`-based snapshot types (place after the existing `DailyCount` interface) and a re-usable import — add at the top of the file's type list:

```ts
export interface StatsSnapshot {
  version: 1
  today: string
  salt: string
  registers: string
  history: DailyCount[]
}

export interface StoreSnapshot {
  today: string
  salt: Uint8Array
  registers: Uint8Array
  history: DailyCount[]
}

export interface StatsPersistence {
  load: () => Promise<StatsSnapshot | null>
  save: (snapshot: StatsSnapshot) => Promise<void>
}
```

Add to `StatsOptions` (inside the interface):

```ts
  /**
   * Opt-in persistence. Survives restarts/deploys on a SINGLE long-running
   * instance by storing today's live sketch + history as an opaque blob.
   * Both callbacks are required. Object-only — no env var equivalent.
   */
  persistence?: StatsPersistence
  /** Min ms between debounced saves on the request path. Default 30000. */
  persistSaveDebounceMs?: number
```

Add to `ResolvedConfig`:

```ts
  persistence: StatsPersistence | null
  persistSaveDebounceMs: number
```

- [ ] **Step 4: Add config resolution + validation**

In `packages/lib/src/config.ts`, add a constant near the other defaults:

```ts
const DEFAULT_PERSIST_DEBOUNCE_MS = 30000
```

Add this resolution block inside `resolveConfig`, just before the `return {` statement:

```ts
  const persistence = validatePersistence(options.persistence)
  const persistSaveDebounceMs =
    options.persistSaveDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS
  requireNonNegativeInt(persistSaveDebounceMs, 'persistSaveDebounceMs')
```

Add `persistence` and `persistSaveDebounceMs` to the returned object literal.

Add this helper at the bottom of the file:

```ts
function validatePersistence(
  p: StatsOptions['persistence'],
): ResolvedConfig['persistence'] {
  if (p == null) return null
  if (
    typeof p !== 'object' ||
    typeof p.load !== 'function' ||
    typeof p.save !== 'function'
  ) {
    throw new Error(
      '[statswhatshesaid] persistence must be an object with `load` and `save` async functions.',
    )
  }
  return p
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test --workspace packages/lib -- config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck --workspace packages/lib`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/lib/src/types.ts packages/lib/src/config.ts packages/lib/test/config.test.ts
git commit -m "feat(lib): add persistence config types and validation"
```

---

## Task 2: VisitorStore snapshot + restore

**Files:**
- Modify: `packages/lib/src/store.ts`
- Test: `packages/lib/test/store.test.ts`

- [ ] **Step 1: Write the failing store tests**

Append to `packages/lib/test/store.test.ts` (it already imports `VisitorStore` and `vi`):

```ts
import { estimateRegisters } from '@swhsd/hll'
import type { StoreSnapshot } from '../src/types.js'

describe('VisitorStore snapshot/restore', () => {
  it('snapshot() captures today, 32-byte salt, 16 KB registers, and history', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-03T12:00:00Z'))
    try {
      const s = VisitorStore.fresh('2026-06-03')
      await s.track('1.1.1.1', 'ua-a')
      await s.track('2.2.2.2', 'ua-b')
      const snap = await s.snapshot()
      expect(snap.today).toBe('2026-06-03')
      expect(snap.salt.length).toBe(32)
      expect(snap.registers.length).toBe(16384)
      expect(estimateRegisters(snap.registers)).toBe(2)
      expect(snap.history).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('fromSnapshot() resumes the same day and dedupes returning visitors', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-03T12:00:00Z'))
    try {
      const s = VisitorStore.fresh('2026-06-03')
      await s.track('1.1.1.1', 'ua-a')
      await s.track('2.2.2.2', 'ua-b')
      const snap = await s.snapshot()

      const restored = VisitorStore.fromSnapshot(snap, '2026-06-03', null)
      expect(restored.estimateToday()).toBe(2)
      // Same visitor seen before the "restart" must NOT increment (proves the
      // salt was restored, not regenerated).
      await restored.track('1.1.1.1', 'ua-a')
      expect(restored.estimateToday()).toBe(2)
      // A genuinely new visitor does increment.
      await restored.track('3.3.3.3', 'ua-c')
      expect(restored.estimateToday()).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fromSnapshot() finalizes a past day into history and starts today fresh', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-02T12:00:00Z'))
    try {
      const s = VisitorStore.fresh('2026-06-02')
      await s.track('1.1.1.1', 'ua-a')
      await s.track('2.2.2.2', 'ua-b')
      const snap = await s.snapshot()

      const restored = VisitorStore.fromSnapshot(snap, '2026-06-03', null)
      expect(restored.today).toBe('2026-06-03')
      expect(restored.estimateToday()).toBe(0)
      expect(restored.getHistoryDesc(90)).toEqual([
        { date: '2026-06-02', uniqueVisitors: 2 },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('fromSnapshot() seeds prior history alongside a same-day resume', () => {
    const snap: StoreSnapshot = {
      today: '2026-06-03',
      salt: new Uint8Array(32),
      registers: new Uint8Array(16384),
      history: [{ date: '2026-06-01', uniqueVisitors: 11 }],
    }
    const restored = VisitorStore.fromSnapshot(snap, '2026-06-03', null)
    expect(restored.getHistoryDesc(90)).toEqual([
      { date: '2026-06-01', uniqueVisitors: 11 },
    ])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace packages/lib -- store.test.ts`
Expected: FAIL — `snapshot`, `fromSnapshot` not defined.

- [ ] **Step 3: Implement the store methods**

In `packages/lib/src/store.ts`, update the imports at the top:

```ts
import {
  computeSaltFingerprint,
  computeVisitorHash,
  deriveDailySalt,
  generateSalt,
  utcDateString,
} from './identity.js'
import { HyperLogLog, estimateRegisters } from '@swhsd/hll'
import type { DailyCount, StoreSnapshot } from './types.js'
```

Add these methods inside the `VisitorStore` class (e.g. after `getHistoryDesc`):

```ts
  /** All finalized history (excluding today), uncapped, insertion order. */
  historyEntries(): DailyCount[] {
    const rows: DailyCount[] = []
    for (const [date, count] of this._history) {
      if (date === this._today) continue
      rows.push({ date, uniqueVisitors: count })
    }
    return rows
  }

  /**
   * Raw serializable snapshot of the live state: today's date, today's salt
   * (derived if in shared-salt mode), a copy of today's HLL registers, and
   * all finalized history. Used by the persistence controller.
   */
  async snapshot(): Promise<StoreSnapshot> {
    this.rollOverIfNeeded()
    const salt = await this.getOrDeriveSalt()
    return {
      today: this._today,
      salt: new Uint8Array(salt),
      registers: this._hll.cloneRegisters(),
      history: this.historyEntries(),
    }
  }

  /**
   * Build a store from a previously-saved snapshot, relative to the current
   * UTC day:
   *  - snapshot is from today  → restore salt + registers + history (resume).
   *  - snapshot is from a past day → finalize that day into history, start
   *    today fresh.
   *  - snapshot is from a future day (clock skew) → start today fresh, seed
   *    history only.
   */
  static fromSnapshot(
    raw: StoreSnapshot,
    currentToday: string,
    saltSecret: string | null,
  ): VisitorStore {
    const history = new Map<string, number>()
    for (const { date, uniqueVisitors } of raw.history) {
      if (date !== currentToday) history.set(date, uniqueVisitors)
    }

    if (raw.today === currentToday) {
      return new VisitorStore({
        today: currentToday,
        salt: raw.salt,
        saltSecret,
        hll: new HyperLogLog(raw.registers),
        history,
      })
    }

    if (raw.today < currentToday) {
      history.set(raw.today, estimateRegisters(raw.registers))
    }

    return new VisitorStore({
      today: currentToday,
      salt: saltSecret ? null : generateSalt(),
      saltSecret,
      hll: new HyperLogLog(),
      history,
    })
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace packages/lib -- store.test.ts`
Expected: PASS (existing tests + 4 new).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/store.ts packages/lib/test/store.test.ts
git commit -m "feat(lib): add VisitorStore snapshot and fromSnapshot"
```

---

## Task 3: Snapshot serialize / deserialize / validate

**Files:**
- Create: `packages/lib/src/persistence.ts`
- Test: `packages/lib/test/persistence.test.ts`

- [ ] **Step 1: Write the failing serialization tests**

Create `packages/lib/test/persistence.test.ts`:

```ts
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

  it('returns null for non-object input', () => {
    expect(deserializeSnapshot(null)).toBeNull()
    expect(deserializeSnapshot('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace packages/lib -- persistence.test.ts`
Expected: FAIL — `packages/lib/src/persistence.ts` does not exist.

- [ ] **Step 3: Create the persistence module (serialization half)**

Create `packages/lib/src/persistence.ts`:

```ts
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
      !Number.isFinite(uniqueVisitors)
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace packages/lib -- persistence.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/persistence.ts packages/lib/test/persistence.test.ts
git commit -m "feat(lib): add snapshot serialize/deserialize with validation"
```

---

## Task 4: PersistenceController (hydrate + debounced save)

**Files:**
- Modify: `packages/lib/src/persistence.ts`
- Test: `packages/lib/test/persistence.test.ts`

> The controller depends on `StatsRuntime` (`{ config, store, persistence? }`). To avoid an import cycle (`lifecycle` imports the controller), the controller accepts a structural runtime type defined locally.

- [ ] **Step 1: Write the failing controller tests**

Append to `packages/lib/test/persistence.test.ts`:

```ts
import { vi } from 'vitest'
import { PersistenceController } from '../src/persistence.js'
import { VisitorStore } from '../src/store.js'
import { resolveConfig } from '../src/config.js'
import type { StatsSnapshot } from '../src/types.js'

const TOKEN = 'persist-ctrl-secret-xxxxxxxxxxxxxxxxxxxxxxxxxx'

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
    get: () => stored,
    set: (s: StatsSnapshot | null) => {
      stored = s
    },
    loadCalls,
    saveCalls,
  }
}

function runtimeWith(persistence: ReturnType<typeof fakePersistence>['api'], debounceMs = 30000) {
  const config = resolveConfig({ token: TOKEN, persistence, persistSaveDebounceMs: debounceMs })
  return { config, store: VisitorStore.fresh('2026-06-03', null) }
}

describe('PersistenceController', () => {
  it('hydrates from a stored snapshot exactly once for concurrent callers', async () => {
    const fake = fakePersistence()
    const seed = VisitorStore.fresh('2026-06-03', null)
    fake.set((await import('../src/persistence.js')).serializeSnapshot(await seedTracked(seed)))

    const runtime = runtimeWith(fake.api)
    const controller = new PersistenceController(fake.api, 30000)
    await Promise.all([
      controller.ensureHydrated(runtime),
      controller.ensureHydrated(runtime),
      controller.ensureHydrated(runtime),
    ])
    expect(fake.loadCalls.n).toBe(1)
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

      controller.maybeSave(runtime) // first call always eligible
      await vi.waitFor(() => expect(fake.saveCalls.n).toBe(1))

      controller.maybeSave(runtime) // within debounce window → skipped
      expect(fake.saveCalls.n).toBe(1)

      vi.setSystemTime(new Date('2026-06-03T12:01:00Z')) // +60s > debounce
      controller.maybeSave(runtime)
      await vi.waitFor(() => expect(fake.saveCalls.n).toBe(2))

      // Roll the store into a new day → forced save regardless of debounce.
      runtime.store.rollOverIfNeeded(new Date('2026-06-04T00:00:01Z'))
      controller.maybeSave(runtime)
      await vi.waitFor(() => expect(fake.saveCalls.n).toBe(3))
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
    const runtime = runtimeWith(failing)
    const controller = new PersistenceController(failing, 0)
    expect(() => controller.maybeSave(runtime)).not.toThrow()
    await vi.waitFor(() => {}) // let the rejected save settle
  })
})

// Helper: track two visitors into a store and return it (for seeding).
async function seedTracked(s: VisitorStore): Promise<VisitorStore> {
  await s.track('1.1.1.1', 'ua-a')
  await s.track('2.2.2.2', 'ua-b')
  return s
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace packages/lib -- persistence.test.ts`
Expected: FAIL — `PersistenceController` not exported.

- [ ] **Step 3: Implement the controller**

Append to `packages/lib/src/persistence.ts`:

```ts
import { utcDateString } from './identity.js'
import { VisitorStore } from './store.js'
import type { ResolvedConfig, StatsPersistence } from './types.js'

/**
 * Minimal structural view of the runtime the controller needs. Declared
 * locally (rather than imported from lifecycle.ts) to avoid an import cycle.
 */
interface RuntimeLike {
  config: ResolvedConfig
  store: VisitorStore
}

/**
 * Owns opt-in persistence side effects: a one-time hydrate on first use and
 * debounced, fire-and-forget saves on the request path. No timers, no signal
 * handlers — the debounce clock is checked lazily via `Date.now()`.
 */
export class PersistenceController {
  private readonly persistence: StatsPersistence
  private readonly debounceMs: number
  private hydration: Promise<void> | null = null
  private lastSaveAt = 0
  private lastSeenToday: string | null = null
  private saving = false

  constructor(persistence: StatsPersistence, debounceMs: number) {
    this.persistence = persistence
    this.debounceMs = debounceMs
  }

  /** Load + restore the store once. Memoized; safe under concurrent calls. */
  ensureHydrated(runtime: RuntimeLike): Promise<void> {
    if (!this.hydration) this.hydration = this.hydrate(runtime)
    return this.hydration
  }

  private async hydrate(runtime: RuntimeLike): Promise<void> {
    try {
      const stored = await this.persistence.load()
      if (!stored) return
      const raw = deserializeSnapshot(stored)
      if (!raw) return
      const today = utcDateString(new Date())
      runtime.store = VisitorStore.fromSnapshot(raw, today, runtime.config.saltSecret)
      runtime.store.trimHistory(runtime.config.maxHistoryDays)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[statswhatshesaid] persist load failed; starting fresh:', err)
    }
  }

  /**
   * Fire a save if the debounce window has elapsed, or immediately when the
   * store's day has changed since the last observed save. Never throws; never
   * overlaps with an in-flight save.
   */
  maybeSave(runtime: RuntimeLike): void {
    if (this.saving) return
    const today = runtime.store.today
    const rolled = this.lastSeenToday !== null && today !== this.lastSeenToday
    this.lastSeenToday = today

    const now = Date.now()
    if (!rolled && now - this.lastSaveAt < this.debounceMs) return

    this.lastSaveAt = now
    this.saving = true
    void this.runSave(runtime).finally(() => {
      this.saving = false
    })
  }

  private async runSave(runtime: RuntimeLike): Promise<void> {
    try {
      const raw = await runtime.store.snapshot()
      await this.persistence.save(serializeSnapshot(raw))
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[statswhatshesaid] persist save failed:', err)
    }
  }
}
```

> Note: `RuntimeLike` declares `store` as mutable so `hydrate` can swap in the restored store. `lifecycle.ts`'s `StatsRuntime` must also keep `store` mutable (Task 5).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace packages/lib -- persistence.test.ts`
Expected: PASS (serialization + 4 controller tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace packages/lib`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/lib/src/persistence.ts packages/lib/test/persistence.test.ts
git commit -m "feat(lib): add PersistenceController with hydrate and debounced save"
```

---

## Task 5: Wire into runtime, middleware, endpoint (+ integration)

**Files:**
- Modify: `packages/lib/src/lifecycle.ts`
- Modify: `packages/lib/src/middleware.ts`
- Modify: `packages/lib/src/endpoint.ts`
- Modify: `packages/lib/src/index.ts`
- Test: `packages/lib/test/integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Append to `packages/lib/test/integration.test.ts` (it already has `req`, `wipeSingleton`, `TOKEN`):

```ts
import type { StatsSnapshot, StatsPersistence } from '../src/types.js'

function memoryPersistence(): {
  api: StatsPersistence
  get: () => StatsSnapshot | null
} {
  let stored: StatsSnapshot | null = null
  return {
    api: {
      load: async () => stored,
      save: async (s) => {
        stored = s
      },
    },
    get: () => stored,
  }
}

describe('integration: persistence survives a deploy', () => {
  beforeEach(() => wipeSingleton())
  afterEach(() => wipeSingleton())

  it('restores today\'s count after a simulated restart', async () => {
    const store = memoryPersistence()

    // First process: three distinct visitors.
    const mw1 = createMiddleware({
      token: TOKEN,
      persistence: store.api,
      persistSaveDebounceMs: 0, // save on every request for the test
    })
    await mw1(req('/', { 'user-agent': 'FF', 'x-forwarded-for': '10.0.0.1' }))
    await mw1(req('/', { 'user-agent': 'FF', 'x-forwarded-for': '10.0.0.2' }))
    await mw1(req('/', { 'user-agent': 'Safari', 'x-forwarded-for': '10.0.0.3' }))

    // Let the fire-and-forget save settle, then confirm something was stored.
    await vi.waitFor(() => expect(store.get()).not.toBeNull())

    // Simulate a deploy: wipe the in-memory singleton, new middleware instance.
    wipeSingleton()
    const mw2 = createMiddleware({
      token: TOKEN,
      persistence: store.api,
      persistSaveDebounceMs: 0,
    })

    const res = await mw2(req(`/stats?t=${TOKEN}`))
    const body = (await res.json()) as { today: { uniqueVisitors: number } }
    expect(body.today.uniqueVisitors).toBe(3)
  })
})
```

> This test uses `vi` — confirm `vi` is imported at the top of `integration.test.ts` (it is, alongside `afterEach, beforeEach, describe, expect, it`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace packages/lib -- integration.test.ts`
Expected: FAIL — `persistence` is accepted but never hydrates/saves, so the count is 0 after restart.

- [ ] **Step 3: Attach the controller in lifecycle.ts**

In `packages/lib/src/lifecycle.ts`, update the imports and `StatsRuntime`:

```ts
import { utcDateString } from './identity.js'
import { PersistenceController } from './persistence.js'
import { VisitorStore } from './store.js'
import type { ResolvedConfig } from './types.js'

export interface StatsRuntime {
  config: ResolvedConfig
  store: VisitorStore
  persistence?: PersistenceController
}
```

Inside `getOrInitRuntime`, after `store.trimHistory(config.maxHistoryDays)` and before assigning `globalThis`, build the runtime with an optional controller:

```ts
  const runtime: StatsRuntime = { config, store }
  if (config.persistence) {
    runtime.persistence = new PersistenceController(
      config.persistence,
      config.persistSaveDebounceMs,
    )
  }
  globalThis.__statswhatshesaid__ = runtime
  return runtime
```

- [ ] **Step 4: Hydrate + save in the middleware track path**

In `packages/lib/src/middleware.ts`, update `trackRequestInternal` so it hydrates first and saves after a successful track:

```ts
async function trackRequestInternal(
  req: NextRequest,
  runtime: StatsRuntime,
): Promise<void> {
  try {
    if (runtime.persistence) await runtime.persistence.ensureHydrated(runtime)

    const rawUa = req.headers.get('user-agent') ?? ''
    const ua = rawUa.length > MAX_UA_LENGTH ? rawUa.slice(0, MAX_UA_LENGTH) : rawUa
    if (runtime.config.filterBots && isBot(ua)) return

    const ip = extractIp(req.headers, runtime.config.trustProxy)
    await runtime.store.track(ip, ua)
    runtime.persistence?.maybeSave(runtime)
  } catch (err) {
    // Never let a tracking failure take down the user's request.
    // eslint-disable-next-line no-console
    console.error('[statswhatshesaid] track failed:', err)
  }
}
```

- [ ] **Step 5: Hydrate before serving /stats**

In `packages/lib/src/endpoint.ts`, add a hydrate call right after the auth check passes and before `runtime.store.rollOverIfNeeded()`:

```ts
  if (runtime.persistence) await runtime.persistence.ensureHydrated(runtime)

  // Make sure "today" in the response always reflects the current UTC day,
  // even if no track() call has triggered a rollover yet.
  runtime.store.rollOverIfNeeded()
```

- [ ] **Step 6: Export the public types**

In `packages/lib/src/index.ts`, extend the type re-export line:

```ts
export type {
  StatsOptions,
  StatsResponseBody,
  DailyCount,
  StatsPersistence,
  StatsSnapshot,
} from './types.js'
```

- [ ] **Step 7: Run the integration test to verify it passes**

Run: `npm run test --workspace packages/lib -- integration.test.ts`
Expected: PASS (existing + new "survives a deploy").

- [ ] **Step 8: Run the whole suite + typecheck**

Run: `npm run typecheck --workspace packages/lib && npm run test --workspace packages/lib`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add packages/lib/src/lifecycle.ts packages/lib/src/middleware.ts packages/lib/src/endpoint.ts packages/lib/src/index.ts packages/lib/test/integration.test.ts
git commit -m "feat(lib): wire persistence into runtime, middleware, and endpoint"
```

---

## Task 6: Docs + changeset

**Files:**
- Modify: `packages/lib/README.md`
- Create: `.changeset/persistence-callback.md`

- [ ] **Step 1: Add a Persistence subsection to the README**

In `packages/lib/README.md`, immediately after the existing **Storage** section (before **Configuration**), insert:

````markdown
## Persistence (optional)

By default there's no storage — counts reset on every deploy. If you run a
**single long-running instance** (`next start` on a VPS / Fly / Railway /
Docker) you can opt in to persistence so today's live count and history
survive restarts. Provide two async callbacks; the library hands you an opaque
JSON snapshot to store and read back. Your database driver stays in your app —
the library remains zero-dependency.

```ts
// middleware.ts
import { createMiddleware } from 'statswhatshesaid'
import { pool } from './db' // your existing pg Pool

export default createMiddleware({
  persistence: {
    load: async () => {
      const { rows } = await pool.query(
        'select snapshot from stats_snapshot where id = 1',
      )
      return rows[0]?.snapshot ?? null
    },
    save: async (snapshot) => {
      await pool.query(
        `insert into stats_snapshot (id, snapshot) values (1, $1)
         on conflict (id) do update set snapshot = $1`,
        [snapshot],
      )
    },
  },
})
```

One-time table:

```sql
create table stats_snapshot (id int primary key, snapshot jsonb not null);
```

**How it works.** On the first request the library calls `load()` once and
restores the in-memory sketch — resuming today if the snapshot is from today,
or finalizing it into history if a day has passed. After each tracked request
it calls `save()` at most once per `persistSaveDebounceMs` (default 30 000),
plus immediately when the UTC day rolls over. Saves are fire-and-forget and
never block or fail a request; a failing `load()` at boot just starts fresh.

**Single instance only.** The snapshot is a single read-modify-write row. With
multiple replicas they'd clobber each other — for multi-replica consolidation
use shared-salt mode plus the [collector](../collector) instead.

**Privacy note.** The snapshot includes today's HLL salt (already in process
memory) so the sketch can resume correctly. It rotates daily and never links
across days, but anyone who can read this row *and* your request logs could in
principle rederive today's `(ip, ua)` hashes — the same trust surface as
database access generally.

| Option | Default |
| --- | --- |
| `persistence` | unset (no persistence) |
| `persistSaveDebounceMs` | `30000` |
````

- [ ] **Step 2: Add the changeset**

Create `.changeset/persistence-callback.md`:

```markdown
---
"statswhatshesaid": minor
---

Add an optional `persistence: { load, save }` config for single-instance
durability. When provided, the library hydrates the in-memory sketch on first
request and saves an opaque JSON snapshot (today's salt + HLL registers +
history) with a debounced, fire-and-forget write — so counts survive deploys
and restarts. Zero new runtime dependencies; your database driver stays in your
app. Also adds `persistSaveDebounceMs` (default 30000).
```

- [ ] **Step 3: Verify the full package build**

Run: `npm run verify --workspace packages/lib`
Expected: typecheck + tests + build all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/lib/README.md .changeset/persistence-callback.md
git commit -m "docs(lib): document optional persistence callback + changeset"
```

---

## Self-review notes

- **Spec coverage:** snapshot shape (T1/T3), salt persistence (T2/T3), hydrate same-day/past-day/future (T2), validation of untrusted input (T3), debounced + rollover-forced save (T4), hydrate-once + failure isolation (T4), config surface + `persistSaveDebounceMs` (T1), middleware/endpoint wiring (T5), README + privacy note + single-instance caveat (T6), changeset (T6). All spec sections map to a task.
- **No timers / no signal handlers:** debounce uses `Date.now()` checked on the request path only — preserved.
- **Type consistency:** `StatsSnapshot`/`StoreSnapshot`/`StatsPersistence` defined in T1 and used unchanged through T2–T6; `snapshot()`/`fromSnapshot()`/`historyEntries()`/`ensureHydrated()`/`maybeSave()` names are stable across tasks.
- **Edge runtime:** all new code uses Web APIs (`btoa`/`atob`, `Date`, `crypto` via existing identity helpers); the user's DB driver is the only Node-specific piece and lives in their app.
