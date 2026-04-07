import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import type { StatsRuntime } from './lifecycle.js'
import type { StatsResponseBody } from './types.js'

export function handleStatsEndpoint(req: NextRequest, runtime: StatsRuntime): NextResponse {
  const provided = extractAuthToken(req)
  if (!provided || !constantTimeEqual(provided, runtime.config.token)) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  // Make sure "today" in the response always reflects the current UTC day,
  // even if the rollover timer has drifted (e.g. the machine was asleep).
  runtime.store.rollOverIfNeeded()

  const body: StatsResponseBody = {
    today: {
      date: runtime.store.today,
      uniqueVisitors: runtime.store.estimateToday(),
    },
    history: runtime.store.getHistoryDesc(runtime.config.historyDays),
    generatedAt: new Date().toISOString(),
  }
  return NextResponse.json(body, {
    headers: { 'cache-control': 'no-store' },
  })
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

/**
 * Constant-time string comparison that does NOT leak the length of either
 * input. We prehash both sides so `timingSafeEqual` always runs over two
 * 32-byte buffers regardless of the original token length.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a, 'utf8').digest()
  const bh = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ah, bh)
}
