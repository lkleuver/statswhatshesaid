import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { encodeRegistersBase64 } from '@swhsd/hll'

import { constantTimeStringEqual } from './identity.js'
import type { StatsRuntime } from './lifecycle.js'
import type { StatsResponseBody, TodayCount } from './types.js'

export async function handleStatsEndpoint(
  req: NextRequest,
  runtime: StatsRuntime,
): Promise<NextResponse> {
  const provided = extractAuthToken(req)
  if (!provided || !(await constantTimeStringEqual(provided, runtime.config.token))) {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  if (runtime.persistence) await runtime.persistence.ensureHydrated(runtime)

  // Reads don't trigger a save (persistence is driven from the track path);
  // a new-day rollover seen only via /stats is recovered from the previous
  // snapshot on the next hydrate.
  // Make sure "today" in the response always reflects the current UTC day,
  // even if no track() call has triggered a rollover yet.
  runtime.store.rollOverIfNeeded()

  const today: TodayCount = {
    date: runtime.store.today,
    uniqueVisitors: runtime.store.estimateToday(),
  }

  // Raw format export — only meaningful when shared-salt mode is on, since
  // sketches built from random per-process salts can't be merged across
  // replicas. If the caller asked for raw without shared-salt mode, we
  // respond as if they hadn't asked. (The collector treats absence of
  // `sketch` as "this server doesn't support merging".)
  if (isRawFormatRequested(req) && runtime.store.isSharedSaltMode()) {
    const sketch = await runtime.store.exposeTodaySketch()
    today.sketch = encodeRegistersBase64(sketch.registers)
    today.saltFingerprint = sketch.saltFingerprint
  }

  const body: StatsResponseBody = {
    today,
    history: runtime.store.getHistoryDesc(runtime.config.historyDays),
    generatedAt: new Date().toISOString(),
  }
  return NextResponse.json(body, {
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * The collector requests the raw sketch with `?format=raw`. Query-string
 * only — middleware sometimes strips or rewrites the Accept header, and we
 * want a single authoritative source.
 */
function isRawFormatRequested(req: NextRequest): boolean {
  return req.nextUrl.searchParams.get('format') === 'raw'
}

/**
 * Accept the token via either:
 *   - `Authorization: Bearer <token>` header (preferred for production —
 *     does not leak to server access logs or browser history)
 *   - `?t=<token>` query string (convenient for ad-hoc browser checks)
 *
 * The Authorization header wins if both are present.
 */
function extractAuthToken(req: NextRequest): string | null {
  const auth = req.headers.get('authorization')
  if (auth) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(auth)
    if (match) return match[1]!
  }
  return req.nextUrl.searchParams.get('t')
}
