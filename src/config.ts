import type { ResolvedConfig, StatsOptions } from './types.js'

const DEFAULT_ENDPOINT_PATH = '/stats'
const DEFAULT_HISTORY_DAYS = 90
const DEFAULT_MAX_HISTORY_DAYS = 365
const DEFAULT_TRUST_PROXY = 1
const MIN_RECOMMENDED_TOKEN_LENGTH = 32
// Match a conservative subset of path-safe characters. No CR/LF, spaces,
// or shell metacharacters — this is compared against `req.nextUrl.pathname`
// which is already URL-decoded, so we don't need to allow percent-escapes.
const ENDPOINT_PATH_RE = /^\/[A-Za-z0-9\-._~/]*$/
let weakTokenWarned = false

export function resolveConfig(options: StatsOptions = {}): ResolvedConfig {
  const env =
    typeof process !== 'undefined' && process.env
      ? process.env
      : ({} as Record<string, string | undefined>)

  const token = options.token ?? env.STATS_TOKEN
  if (!token) {
    throw new Error(
      '[statswhatshesaid] Missing required token. Set the STATS_TOKEN env var or pass `token` to createMiddleware({ token }).',
    )
  }
  // Warn (not throw) if the token is short enough to brute-force.
  // Advisory only — the user may have picked a memorable token on
  // purpose so they can check stats from anywhere without a keychain.
  if (!weakTokenWarned && token.length < MIN_RECOMMENDED_TOKEN_LENGTH) {
    weakTokenWarned = true
    // eslint-disable-next-line no-console
    console.warn(
      `[statswhatshesaid] Warning: the stats token is shorter than ${MIN_RECOMMENDED_TOKEN_LENGTH} characters (${token.length}). ` +
        "Short tokens are vulnerable to brute-force attacks against the /stats endpoint. " +
        "Consider generating a strong token with: `openssl rand -hex 32`. " +
        "You can also rate-limit /stats at your reverse proxy or CDN.",
    )
  }

  const rawEndpointPath =
    options.endpointPath ?? env.STATS_ENDPOINT_PATH ?? DEFAULT_ENDPOINT_PATH
  const endpointPath = normalizePath(rawEndpointPath)
  if (!ENDPOINT_PATH_RE.test(endpointPath)) {
    throw new Error(
      `[statswhatshesaid] Invalid endpointPath: ${JSON.stringify(rawEndpointPath)}. Must match /^\\/[A-Za-z0-9\\-._~/]*$/.`,
    )
  }

  const historyDays = options.historyDays ?? DEFAULT_HISTORY_DAYS
  requireNonNegativeInt(historyDays, 'historyDays')
  const maxHistoryDays = options.maxHistoryDays ?? DEFAULT_MAX_HISTORY_DAYS
  requireNonNegativeInt(maxHistoryDays, 'maxHistoryDays')
  const filterBots = options.filterBots ?? true

  const rawTrustProxy =
    options.trustProxy ?? parseIntOr(env.STATS_TRUST_PROXY, DEFAULT_TRUST_PROXY, true)
  if (!Number.isInteger(rawTrustProxy) || rawTrustProxy < 0) {
    throw new Error(
      `[statswhatshesaid] Invalid trustProxy value: ${rawTrustProxy}. Must be a non-negative integer (0, 1, 2, ...).`,
    )
  }

  return {
    token,
    endpointPath,
    historyDays,
    maxHistoryDays,
    filterBots,
    trustProxy: rawTrustProxy,
  }
}

function requireNonNegativeInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `[statswhatshesaid] ${name} must be a non-negative integer; got ${value}.`,
    )
  }
}

function parseIntOr(
  value: string | undefined,
  fallback: number,
  allowZero = false,
): number {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  if (allowZero ? n < 0 : n <= 0) return fallback
  return n
}

function normalizePath(p: string): string {
  if (!p.startsWith('/')) return `/${p}`
  return p
}
