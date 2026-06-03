# statswhatshesaid — optional persistence callback

**Date:** 2026-06-03
**Status:** Approved design, ready for implementation plan
**Package:** `packages/lib` (`statswhatshesaid`)

## Problem

The library is in-memory only by design: counts live in a `VisitorStore`
singleton and reset on every deploy/restart. For an app that ships new
versions frequently and mid-day, that means today's accumulated unique-visitor
count is repeatedly thrown away. We want an **optional, opt-in** way to survive
restarts without abandoning the library's "drop in, no fuss, zero runtime
dependencies" ethos.

## Goals

- Survive process restarts/deploys, including **mid-day** ones (today's live
  sketch resumes, not just finalized history).
- Stay **zero runtime dependency** — the user's database driver lives in their
  app, never in the library.
- Keep the library's existing design properties: **no background timers, no
  signal handlers**; everything happens lazily on the request path.
- Integration should be ~12 lines of user code against any store (Postgres is
  the motivating case).

## Non-goals (YAGNI)

- Multi-replica / concurrent-writer safety — that remains the external
  collector's job (shared-salt mode). Persistence here targets a **single
  long-running instance** (`next start` on a VPS / Fly / Railway / Docker).
- Built-in Postgres (or any specific) adapter — the callback is
  storage-agnostic.
- Queryable first-class history rows — history rides inside the snapshot blob
  (which is JSON, so still SQL-queryable as `jsonb` if desired).

## Chosen approach

`persistence: { load, save }` config callbacks with an **opaque snapshot
blob**. The library owns the entire format (serialize, validate, hydrate,
merge/finalize, debounced save). The user provides two async functions that
read/write a single row.

Rejected alternatives:
- **Structured callbacks** exposing raw `Uint8Array`/history map → more user
  wiring, leaks HLL internals. Over-engineered for "don't lose my numbers".
- **Extend the collector to write Postgres** → requires a separate always-on
  process + shared-salt setup; wrong weight class for a single instance, and
  not what was asked for.

## Key design decision: persist the salt

The daily HLL salt **must** be persisted alongside the registers. In default
mode the salt is random per-process, so a restarted process has a *different*
salt; merging old registers into a new-salt sketch would mis-count returning
visitors. The snapshot therefore carries today's salt; on restore we put the
exact salt back and the sketch resumes correctly.

Cross-day unlinkability is preserved: each new day generates a fresh salt that
overwrites the snapshot, so only *today's* salt is ever persisted.

## Architecture

**New module `packages/lib/src/persistence.ts`** holding:
- `StatsSnapshot` type and `StatsPersistence` interface.
- Snapshot serialize / deserialize / **validate** helpers.
- `PersistenceController` — owns hydrate-once + debounced-save state
  (`hydrated`, `hydration` promise, `lastSaveAt`, in-flight save guard).

`VisitorStore` stays the pure state-owner, gaining:
- `snapshot()` — extract `{ today, salt (raw), registers (raw), history }`
  (deriving the salt if in shared-salt mode).
- `VisitorStore.restore(snapshot, saltSecret)` — build a store from a snapshot
  (or a `hydrateFrom` method — implementation detail for the plan).

The controller is attached to the runtime in `lifecycle.ts`; the store and hot
path stay otherwise unchanged.

### Snapshot shape (the opaque blob the user stores)

```jsonc
{
  "version": 1,
  "today": "2026-06-03",
  "salt": "<base64 of today's 16-byte salt>",
  "registers": "<base64 of the 16 KB HLL register array>",
  "history": [{ "date": "2026-06-02", "uniqueVisitors": 388 }, ...]
}
```

### Data flow

- **Boot** — `getOrInitRuntime` builds an empty store synchronously
  (unchanged), plus a `PersistenceController` when `persistence` is configured.
- **First request** — `trackRequestInternal` and `handleStatsEndpoint`
  `await controller.ensureHydrated(runtime)` *before* touching the store.
  Hydration is memoized; concurrent first requests await the same single
  `load()`.
- **Every request** — after `track`, `controller.maybeSave(runtime)`: if
  `Date.now() - lastSaveAt >= debounceMs` (default 30 000), fire `save()`
  fire-and-forget, guarded by an in-flight flag, errors caught.
- **Day rollover** — when `rollOverIfNeeded` returns true, force an immediate
  save so the freshly finalized day can't be lost.

## Public API & config

```ts
export interface StatsSnapshot {
  version: 1
  today: string        // YYYY-MM-DD (UTC)
  salt: string         // base64
  registers: string    // base64 of 16 KB
  history: { date: string; uniqueVisitors: number }[]
}

export interface StatsPersistence {
  load: () => Promise<StatsSnapshot | null>   // null = nothing stored yet
  save: (snapshot: StatsSnapshot) => Promise<void>
}
```

`StatsOptions` gains:
- `persistence?: StatsPersistence` — object-only (no env var). Requires
  `createMiddleware({ persistence })`, not the bare `export { default }`
  one-liner.
- `persistSaveDebounceMs?: number` — default `30000`.

`resolveConfig` validates at the boundary: if `persistence` is present, both
`load` and `save` must be functions (a half-configured persistence throws a
clear error). `ResolvedConfig` gains `persistence: StatsPersistence | null` and
`persistSaveDebounceMs: number`.

### User integration (the whole thing)

```ts
// middleware.ts
import { createMiddleware } from 'statswhatshesaid'
import { pool } from './db'

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

One-time: `create table stats_snapshot (id int primary key, snapshot jsonb not null)`.

## Hydration semantics (`ensureHydrated`, once)

1. `load()` → `null`: keep fresh empty store (first-ever boot).
2. `load()` → snapshot: **validate as untrusted external data** — `version === 1`,
   `today` matches `YYYY-MM-DD`, base64 decodes to exactly 16 KB, history
   entries well-formed. Any failure → warn, treat as `null`, proceed fresh
   (never crash).
3. Valid snapshot, branch on date vs. current UTC day:
   - `snapshot.today === today` → restore salt + registers + history; today
     resumes exactly, returning visitors dedup correctly via the restored salt.
   - `snapshot.today < today` → finalize the snapshot day into history as
     `estimateRegisters(registers)`, seed the rest, start today fresh.
   - `snapshot.today > today` (clock skew) → ignore registers, seed history
     only.
4. `trimHistory(maxHistoryDays)` after seeding.

## Error handling (consistent with "never take down the request")

- `load()` rejects → log once, proceed fresh, mark hydrated so we **don't
  retry-storm** Postgres. Trade-off: brief boot outage means today starts
  fresh; logged.
- `save()` rejects → caught, logged, swallowed. `lastSaveAt` still advances so
  a failing DB isn't hammered; next debounce window retries.
- In-flight guard: a save firing while one is running is skipped — no
  overlapping writes, no unbounded queue.

## Privacy note (for the README)

The snapshot stores today's salt in the user's Postgres — a value already in
process memory; persisting it to one's own DB is a minor, deliberate exposure
required for correct resume. It rotates daily and never links across days.
Whoever can read this row plus the request logs could in principle rederive
today's `(ip, ua)` hashes — the same threat surface as DB access generally.

## Testing

New `packages/lib/test/persistence.test.ts` + additions to
`integration.test.ts`, all using a fake `Map`-backed `StatsPersistence` (no
real Postgres):

- Snapshot serialize/deserialize round-trip.
- Resume same-day: track → snapshot → new runtime from same backing store →
  today's estimate survives **and** re-tracking a seen `(ip, ua)` does not
  increment (proves salt restored).
- Finalize past-day: yesterday's snapshot → new runtime today → yesterday in
  history, today at 0.
- Validation: corrupt base64 / wrong length / unknown version / malformed
  `today` → fresh store, warning, no throw.
- Debounce: save fires after interval, not before; forced save on rollover.
- Hydrate-once: two concurrent first requests ⇒ `load` called exactly once.
- Failure isolation: `load` rejects ⇒ app serves, store fresh, hydrated set;
  `save` rejects ⇒ swallowed; in-flight guard prevents overlap.

Target ≥80% coverage on the new module. README gains a **Persistence**
subsection under "Storage" with the Postgres example and the single-instance
caveat (multi-replica users → the collector).
