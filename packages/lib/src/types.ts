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
  /**
   * Shared secret used to derive the daily HLL salt deterministically.
   *
   * When set, the daily salt becomes `HMAC-SHA-256(saltSecret, utcDate)`
   * instead of a random per-process value. Two replicas running with the
   * same `saltSecret` will derive identical daily salts — the mathematical
   * precondition for an external collector to merge HLL sketches across
   * replicas and report a correct union cardinality.
   *
   * When unset, salts remain random per-process (the previous behavior).
   * Falls back to the `STATS_SALT_SECRET` env var.
   *
   * Cross-day unlinkability is preserved either way — the salt still
   * rotates daily.
   */
  saltSecret?: string
}

export interface ResolvedConfig {
  token: string
  endpointPath: string
  historyDays: number
  maxHistoryDays: number
  filterBots: boolean
  trustProxy: number
  /** Resolved shared salt secret, or `null` if not configured. */
  saltSecret: string | null
}

export interface DailyCount {
  date: string
  uniqueVisitors: number
}

/**
 * `today` in the /stats response. Has the same `date` + `uniqueVisitors`
 * fields as a historical day. When the request asks for raw format AND
 * shared-salt mode is active, the response also includes the raw HLL
 * register array (base64) and a fingerprint of the salt — enough for the
 * external collector to merge sketches across replicas.
 */
export interface TodayCount extends DailyCount {
  sketch?: string
  saltFingerprint?: string
}

export interface StatsResponseBody {
  today: TodayCount
  history: DailyCount[]
  generatedAt: string
}
