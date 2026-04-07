import type { ResolvedConfig, StatsOptions } from './types.js'

const DEFAULT_SNAPSHOT_PATH = './.statswhatshesaid.json'
const DEFAULT_FLUSH_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
const DEFAULT_ENDPOINT_PATH = '/stats'
const DEFAULT_HISTORY_DAYS = 90
const DEFAULT_MAX_HISTORY_DAYS = 365

export function resolveConfig(options: StatsOptions = {}): ResolvedConfig {
  const env = typeof process !== 'undefined' ? process.env : ({} as NodeJS.ProcessEnv)

  const token = options.token ?? env.STATS_TOKEN
  if (!token) {
    throw new Error(
      '[@statswhatshesaid/next] Missing required token. Set the STATS_TOKEN env var or pass `token` to stats.middleware({ token }).',
    )
  }

  const snapshotPath =
    options.snapshotPath ?? env.STATS_SNAPSHOT_PATH ?? DEFAULT_SNAPSHOT_PATH

  const flushIntervalMs =
    options.flushIntervalMs ??
    parseIntOr(env.STATS_FLUSH_INTERVAL_MS, DEFAULT_FLUSH_INTERVAL_MS)

  const endpointPath = normalizePath(
    options.endpointPath ?? env.STATS_ENDPOINT_PATH ?? DEFAULT_ENDPOINT_PATH,
  )

  const historyDays = options.historyDays ?? DEFAULT_HISTORY_DAYS
  const maxHistoryDays = options.maxHistoryDays ?? DEFAULT_MAX_HISTORY_DAYS
  const filterBots = options.filterBots ?? true
  const persist = options.persist ?? null

  return {
    token,
    snapshotPath,
    persist,
    flushIntervalMs,
    endpointPath,
    historyDays,
    maxHistoryDays,
    filterBots,
  }
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function normalizePath(p: string): string {
  if (!p.startsWith('/')) return `/${p}`
  return p
}
