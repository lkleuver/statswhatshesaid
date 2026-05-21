import {
  decodeRegistersBase64,
  estimateRegisters,
  mergeManyRegisters,
} from '@swhsd/hll'

import { pollOne, PollError } from './poll.js'
import type { PollResponse, ResolvedReplicatedApp } from './types.js'

/**
 * One replica's raw HLL response, captured for both merge logic and
 * `replica_snapshots` postmortem storage.
 */
export interface ReplicaSnapshot {
  url: string
  date: string
  uniqueVisitors: number
  saltFingerprint: string
  sketch: Uint8Array
  generatedAt: string
  history: PollResponse['history']
}

/**
 * Result of a successful merge cycle for one app. The merged synthetic
 * response can flow through the same `reconcileApp` code path as
 * single-endpoint apps; the per-replica detail is recorded separately.
 */
export interface MergeOutcome {
  merged: PollResponse
  replicas: ReplicaSnapshot[]
}

export class MergeError extends Error {
  override readonly name = 'MergeError'
  /** Per-replica details captured up to the point of failure. */
  readonly replicas: ReplicaSnapshot[]
  constructor(message: string, replicas: ReplicaSnapshot[]) {
    super(message)
    this.replicas = replicas
  }
}

/**
 * Poll every replica concurrently, verify they're using the same daily
 * salt, and merge their HLL sketches into a single union-cardinality
 * estimate.
 *
 * Failure cases (all → `MergeError` so the caller can record per-replica
 * detail in `replica_snapshots`):
 *   - any replica returns a non-2xx response or fails to connect
 *   - any replica responds without `sketch` / `saltFingerprint`
 *     (most likely because `STATS_SALT_SECRET` isn't configured)
 *   - replicas disagree on `today.date`
 *   - replicas disagree on `saltFingerprint`
 */
export async function pollAndMerge(
  app: ResolvedReplicatedApp,
): Promise<MergeOutcome> {
  const settled = await Promise.allSettled(
    app.replicas.map((url) =>
      pollOne({
        url,
        token: app.token,
        timeoutMs: app.timeoutMs,
        userAgent: app.userAgent,
        raw: true,
      }).then((response) => ({ url, response })),
    ),
  )

  const replicas: ReplicaSnapshot[] = []
  const failures: string[] = []

  for (const result of settled) {
    if (result.status === 'rejected') {
      const reason =
        result.reason instanceof PollError
          ? result.reason.message
          : `${result.reason}`
      failures.push(reason)
      continue
    }
    const { url, response } = result.value
    if (!response.today.sketch || !response.today.saltFingerprint) {
      failures.push(
        `replica ${url} did not return a raw sketch — set STATS_SALT_SECRET on every replica to enable merging`,
      )
      continue
    }
    try {
      const sketch = decodeRegistersBase64(response.today.sketch)
      replicas.push({
        url,
        date: response.today.date,
        uniqueVisitors: response.today.uniqueVisitors,
        saltFingerprint: response.today.saltFingerprint,
        sketch,
        generatedAt: response.generatedAt,
        history: response.history,
      })
    } catch (err) {
      failures.push(`replica ${url} returned an unparseable sketch: ${(err as Error).message}`)
    }
  }

  if (failures.length > 0) {
    throw new MergeError(
      `${failures.length} replica(s) failed: ${failures.join('; ')}`,
      replicas,
    )
  }
  if (replicas.length === 0) {
    throw new MergeError('no replicas returned a sketch', replicas)
  }

  // All replicas must agree on the date AND the salt fingerprint. A date
  // mismatch means we caught one replica mid-rollover (rare but possible);
  // a fingerprint mismatch means one replica is misconfigured (different
  // STATS_SALT_SECRET, or salt mode disabled on one node) — either way the
  // merge is meaningless.
  const referenceDate = replicas[0]!.date
  const referenceFingerprint = replicas[0]!.saltFingerprint
  for (const r of replicas.slice(1)) {
    if (r.date !== referenceDate) {
      throw new MergeError(
        `replicas disagree on date: ${referenceDate} vs ${r.date} (replica=${r.url})`,
        replicas,
      )
    }
    if (r.saltFingerprint !== referenceFingerprint) {
      throw new MergeError(
        `replicas disagree on saltFingerprint: ${referenceFingerprint} vs ${r.saltFingerprint} (replica=${r.url}). ` +
          'Ensure STATS_SALT_SECRET is identical on every replica.',
        replicas,
      )
    }
  }

  const merged = mergeManyRegisters(replicas.map((r) => r.sketch))
  const mergedToday = estimateRegisters(merged)

  // History is intentionally NOT inherited from replicas. Each replica's
  // historical numbers reflect only the subset of traffic routed to it on
  // each past day — they're not the true union and they're not mergeable
  // after the fact (the library only retains the estimate, not the raw
  // sketch, for past days). Long-term history in merge mode comes from the
  // collector's own running snapshots of `today`, which accumulate
  // correctly in SQLite over time.
  const mergedResponse: PollResponse = {
    today: {
      date: referenceDate,
      uniqueVisitors: mergedToday,
      saltFingerprint: referenceFingerprint,
    },
    history: [],
    generatedAt: new Date().toISOString(),
  }

  return { merged: mergedResponse, replicas }
}
