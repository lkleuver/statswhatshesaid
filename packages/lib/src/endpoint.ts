import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { constantTimeStringEqual } from './identity.js'
import type { StatsRuntime } from './lifecycle.js'
import type { StatsResponseBody } from './types.js'

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

  // Make sure "today" in the response always reflects the current UTC day,
  // even if no track() call has triggered a rollover yet.
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
