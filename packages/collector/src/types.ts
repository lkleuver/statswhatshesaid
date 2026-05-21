/**
 * The raw `swhsd.json` shape as it appears on disk. Mirror of the JSON
 * Schema in `config.schema.json` — the schema is the source of truth for
 * editor validation, this is the source of truth for compile-time checks.
 */
export interface RawConfig {
  db?: string
  defaults?: RawDefaults
  apps: Record<string, RawAppConfig>
}

export interface RawDefaults {
  timeoutMs?: number
  userAgent?: string
}

export interface RawAppConfig {
  url?: string
  replicas?: string[]
  token: string
  timeoutMs?: number
  merge?: boolean
}

/**
 * A resolved app entry — defaults applied, fields normalized. The two app
 * topologies (single endpoint, multiple replicas) are exposed as a tagged
 * union so downstream code can branch exhaustively.
 */
export type ResolvedApp = ResolvedSingleApp | ResolvedReplicatedApp

export interface ResolvedSingleApp {
  kind: 'single'
  name: string
  url: string
  token: string
  timeoutMs: number
  userAgent: string
}

export interface ResolvedReplicatedApp {
  kind: 'replicated'
  name: string
  replicas: string[]
  token: string
  timeoutMs: number
  userAgent: string
}

export interface ResolvedConfig {
  dbPath: string
  apps: ResolvedApp[]
}

/**
 * The library's /stats response shape, as parsed off the wire. Mirrors
 * `StatsResponseBody` in the library, with the optional raw-format fields
 * spelled out so the collector can read them when present.
 */
export interface PollResponse {
  today: {
    date: string
    uniqueVisitors: number
    sketch?: string
    saltFingerprint?: string
  }
  history: Array<{
    date: string
    uniqueVisitors: number
  }>
  generatedAt: string
}

/**
 * Outcome of polling and persisting a single app during one cycle. Used by
 * the CLI to emit one summary line per app and pick an overall exit code.
 */
export type AppOutcome =
  | { app: string; status: 'ok'; today: number; historyRows: number }
  | { app: string; status: 'skipped'; reason: string }
  | { app: string; status: 'failed'; reason: string }
