import { scheduleMidnightTimer, utcDateString } from './identity.js'
import { FileSnapshotAdapter, type PersistAdapter } from './snapshot.js'
import { VisitorStore } from './store.js'
import type { ResolvedConfig } from './types.js'

export interface StatsRuntime {
  config: ResolvedConfig
  store: VisitorStore
  persist: PersistAdapter
  /** Force a flush of the in-memory state to the snapshot. */
  flush: () => void
  /** Tear everything down. Idempotent. */
  shutdown: () => void
}

declare global {
  // eslint-disable-next-line no-var
  var __statswhatshesaid__: StatsRuntime | undefined
}

/**
 * Returns the singleton runtime, lazily creating it on first call. Stored on
 * `globalThis` so Next dev-mode HMR doesn't open multiple file handles or
 * duplicate timers.
 */
export function getOrInitRuntime(config: ResolvedConfig): StatsRuntime {
  if (globalThis.__statswhatshesaid__) return globalThis.__statswhatshesaid__

  assertNodeRuntime()

  const persist: PersistAdapter =
    config.persist ?? new FileSnapshotAdapter(config.snapshotPath)

  const today = utcDateString(new Date())
  const loaded = safeLoad(persist)
  const store = loaded
    ? VisitorStore.fromSnapshot(loaded, today)
    : VisitorStore.fresh(today)
  store.trimHistory(config.maxHistoryDays)

  let shuttingDown = false
  let flushTimer: ReturnType<typeof setInterval> | null = null
  let cancelMidnight: (() => void) | null = null

  const flush = (): void => {
    if (!store.dirty) return
    try {
      persist.save(store.toSnapshot())
      store.markClean()
    } catch (err) {
      // Never let a flush error take down the process.
      // eslint-disable-next-line no-console
      console.error('[@statswhatshesaid/next] flush failed:', err)
    }
  }

  const tick = (): void => {
    try {
      if (store.rollOverIfNeeded()) {
        store.trimHistory(config.maxHistoryDays)
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[@statswhatshesaid/next] rollover failed:', err)
    }
    flush()
  }

  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    if (flushTimer) clearInterval(flushTimer)
    if (cancelMidnight) cancelMidnight()
    try {
      flush()
    } catch {
      /* swallow */
    }
    if (globalThis.__statswhatshesaid__ === runtime) {
      globalThis.__statswhatshesaid__ = undefined
    }
  }

  flushTimer = setInterval(tick, config.flushIntervalMs)
  flushTimer.unref?.()
  cancelMidnight = scheduleMidnightTimer(tick)

  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  process.once('beforeExit', shutdown)

  const runtime: StatsRuntime = { config, store, persist, flush, shutdown }
  globalThis.__statswhatshesaid__ = runtime

  // Persist the initial state (which may have been mutated by a restored
  // rollover) so the file exists before the first flush interval fires.
  flush()

  return runtime
}

function safeLoad(persist: PersistAdapter) {
  try {
    return persist.load()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[@statswhatshesaid/next] snapshot load failed:', err)
    return null
  }
}

function assertNodeRuntime(): void {
  if (typeof process === 'undefined' || !process.versions || !process.versions.node) {
    throw new Error(
      "[@statswhatshesaid/next] This library requires the Node.js runtime. " +
        "Set `export const config = { runtime: 'nodejs' }` in your middleware.ts " +
        '(requires Next.js 15.2 or newer).',
    )
  }
}
