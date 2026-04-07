export interface StatsOptions {
  /** Secret token required to read /stats. Falls back to STATS_TOKEN env var. */
  token?: string
  /** URL path that returns the JSON stats response. Default '/stats'. */
  endpointPath?: string
  /** Number of historical days to return from /stats. Default 90. */
  historyDays?: number
  /** Maximum historical days to keep in memory. Default 365. */
  maxHistoryDays?: number
  /** Drop common bot User-Agents instead of counting them. Default true. */
  filterBots?: boolean
  /**
   * How many reverse-proxy hops to trust at the right end of the
   * `X-Forwarded-For` chain. Default: `1` (one reverse proxy in front of
   * this process, e.g. nginx / Traefik / Caddy / Cloud provider LB).
   *
   * - `0` — ignore all forwarding headers. Every request hashes to the
   *   same constant peer, collapsing unique visitor counts.
   * - `1` — take the rightmost entry of `X-Forwarded-For`.
   * - `N > 1` — take the Nth entry from the right (e.g. Cloudflare → nginx → app = `2`).
   *
   * See the Security section of the README for configuration examples.
   */
  trustProxy?: number
}

export interface ResolvedConfig {
  token: string
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
