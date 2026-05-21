import type { CollectorDb } from './db.js'
import { MergeError, pollAndMerge, type ReplicaSnapshot } from './merge.js'
import { pollOne, PollError } from './poll.js'
import { reconcileApp } from './reconcile.js'
import type {
  AppOutcome,
  ResolvedApp,
  ResolvedConfig,
  ResolvedReplicatedApp,
} from './types.js'

export interface RunOptions {
  config: ResolvedConfig
  db: CollectorDb
  dryRun?: boolean
  keepRaw?: boolean
  /**
   * Hook called once per app with its outcome. The CLI uses this to print
   * one line per app to stderr; tests use it to assert on intermediate
   * results without parsing stdout.
   */
  onOutcome?: (outcome: AppOutcome) => void
}

export interface RunResult {
  outcomes: AppOutcome[]
}

/**
 * Run one poll cycle across every configured app. Per-app failures are
 * collected, not thrown — the cycle continues so that one unreachable app
 * doesn't prevent the others from being recorded.
 */
export async function runOnce(opts: RunOptions): Promise<RunResult> {
  const polledAt = new Date().toISOString()
  const outcomes: AppOutcome[] = []

  for (const app of opts.config.apps) {
    const outcome = await runForApp(app, polledAt, opts)
    outcomes.push(outcome)
    opts.onOutcome?.(outcome)
  }
  return { outcomes }
}

async function runForApp(
  app: ResolvedApp,
  polledAt: string,
  opts: RunOptions,
): Promise<AppOutcome> {
  if (app.kind === 'replicated') {
    return runForReplicatedApp(app, polledAt, opts)
  }

  try {
    const response = await pollOne({
      url: app.url,
      token: app.token,
      timeoutMs: app.timeoutMs,
      userAgent: app.userAgent,
      // Step 3 doesn't need the raw sketch for single-endpoint apps, but
      // requesting it costs nothing extra and lets us record fingerprint
      // history if the library is in shared-salt mode.
      raw: false,
    })
    if (opts.dryRun) {
      return {
        app: app.name,
        status: 'ok',
        today: response.today.uniqueVisitors,
        historyRows: response.history.length,
      }
    }
    const result = reconcileApp(opts.db, {
      app: app.name,
      source: 'single',
      polledAt,
      response,
      keepRaw: opts.keepRaw,
    })
    return {
      app: app.name,
      status: 'ok',
      today: response.today.uniqueVisitors,
      historyRows: result.historyRowsInserted,
    }
  } catch (err) {
    return {
      app: app.name,
      status: 'failed',
      reason:
        err instanceof PollError
          ? err.message
          : `${(err as Error).name}: ${(err as Error).message}`,
    }
  }
}

async function runForReplicatedApp(
  app: ResolvedReplicatedApp,
  polledAt: string,
  opts: RunOptions,
): Promise<AppOutcome> {
  try {
    const { merged, replicas } = await pollAndMerge(app)
    if (opts.dryRun) {
      return {
        app: app.name,
        status: 'ok',
        today: merged.today.uniqueVisitors,
        historyRows: 0,
      }
    }
    opts.db.transaction(() => {
      reconcileApp(opts.db, {
        app: app.name,
        source: 'merged',
        polledAt,
        response: merged,
        keepRaw: opts.keepRaw,
      })
      writeReplicaSnapshots(opts.db, app.name, polledAt, replicas)
    })
    return {
      app: app.name,
      status: 'ok',
      today: merged.today.uniqueVisitors,
      historyRows: 0,
    }
  } catch (err) {
    // On any merge failure we still want a forensic record of what each
    // replica returned so the operator can debug skew.
    if (err instanceof MergeError) {
      if (!opts.dryRun) {
        opts.db.transaction(() =>
          writeReplicaSnapshots(opts.db, app.name, polledAt, err.replicas),
        )
      }
      return { app: app.name, status: 'failed', reason: err.message }
    }
    return {
      app: app.name,
      status: 'failed',
      reason: `${(err as Error).name}: ${(err as Error).message}`,
    }
  }
}

function writeReplicaSnapshots(
  db: CollectorDb,
  app: string,
  polledAt: string,
  replicas: readonly ReplicaSnapshot[],
): void {
  for (const r of replicas) {
    db.insertReplicaSnapshot.run(
      app,
      r.url,
      r.date,
      r.uniqueVisitors,
      r.saltFingerprint,
      polledAt,
    )
  }
}
