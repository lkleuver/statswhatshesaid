import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import type { StatsRuntime } from './lifecycle.js'
import type { StatsResponseBody } from './types.js'

export function handleStatsEndpoint(req: NextRequest, runtime: StatsRuntime): NextResponse {
  const provided = req.nextUrl.searchParams.get('t')
  if (!provided || !timingSafeEqualStr(provided, runtime.config.token)) {
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

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
