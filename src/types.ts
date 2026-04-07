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
  /**
   * How many reverse-proxy hops to trust at the right end of the
   * `X-Forwarded-For` chain. Default: `1` (one reverse proxy in front of
   * this process, e.g. nginx / Traefik / Caddy / Cloud provider LB).
   *
   * - `0` — ignore all forwarding headers. Every request hashes to the
   *   same constant peer, collapsing unique visitor counts. Use this only
   *   if the process is directly exposed to untrusted clients AND you'd
   *   rather under-count than be spoofable.
   * - `1` — take the rightmost entry of `X-Forwarded-For` (the IP the last
   *   trusted proxy observed as its peer). Safe when exactly one trusted
   *   proxy is in front of this process.
   * - `N > 1` — take the Nth entry from the right. Use when multiple
   *   trusted proxies chain (e.g. Cloudflare → nginx → app = 2).
   *
   * See the Security section of the README for configuration examples.
   */
  trustProxy?: number
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
  trustProxy: number
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
