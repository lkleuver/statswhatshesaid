import { utcDateString } from './identity.js'
import { VisitorStore } from './store.js'
import type { ResolvedConfig } from './types.js'

export interface StatsRuntime {
  config: ResolvedConfig
  store: VisitorStore
}

declare global {
  // eslint-disable-next-line no-var
  var __statswhatshesaid__: StatsRuntime | undefined
}

/**
 * Returns the singleton runtime, lazily creating it on first call. Stored on
 * `globalThis` so Next dev-mode HMR doesn't open multiple stores or
 * accumulate state across module reloads.
 *
 * In-memory only — no file handles, no timers, no process signal handlers.
 * The store survives for the lifetime of the worker / Edge isolate.
 * Restarting the process resets all counts.
 */
export function getOrInitRuntime(config: ResolvedConfig): StatsRuntime {
  if (globalThis.__statswhatshesaid__) return globalThis.__statswhatshesaid__

  const today = utcDateString(new Date())
  const store = VisitorStore.fresh(today)
  store.trimHistory(config.maxHistoryDays)

  const runtime: StatsRuntime = { config, store }
  globalThis.__statswhatshesaid__ = runtime
  return runtime
}
