import type { PersistAdapter } from './snapshot.js'

export interface StatsOptions {
  /** Secret token required to read /stats. Falls back to STATS_TOKEN env var. */
  token?: string
  /**
   * Path to the JSON snapshot file. Falls back to STATS_SNAPSHOT_PATH or
   * `./.statswhatshesaid.json`. Ignored if a custom `persist` adapter is
   * provided.
   */
  snapshotPath?: string
  /** Bring-your-own persistence backend (Redis, KV, S3, ...). */
  persist?: PersistAdapter
  /** How often (ms) to flush state to the snapshot. Default 1h. */
  flushIntervalMs?: number
  /** URL path that returns the JSON stats response. Default '/stats'. */
  endpointPath?: string
  /** Number of historical days to return from /stats. Default 90. */
  historyDays?: number
  /** Maximum historical days to keep in memory/snapshot. Default 365. */
  maxHistoryDays?: number
  /** Drop common bot User-Agents instead of counting them. Default true. */
  filterBots?: boolean
}

export interface ResolvedConfig {
  token: string
  snapshotPath: string
  persist: PersistAdapter | null
  flushIntervalMs: number
  endpointPath: string
  historyDays: number
  maxHistoryDays: number
  filterBots: boolean
}

export interface DailyCount {
  date: string
  uniqueVisitors: number
}

export interface StatsResponseBody {
  today: DailyCount
  history: DailyCount[]
  generatedAt: string
}
