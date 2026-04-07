import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { isBot } from './bots.js'
import { resolveConfig } from './config.js'
import { extractIp } from './identity.js'
import { handleStatsEndpoint } from './endpoint.js'
import { getOrInitRuntime, type StatsRuntime } from './lifecycle.js'
import type { StatsOptions } from './types.js'

export type StatsMiddleware = (req: NextRequest) => NextResponse | Promise<NextResponse>

export function createMiddleware(options: StatsOptions = {}): StatsMiddleware {
  // Resolution is deferred to first request so a missing STATS_TOKEN doesn't
  // break `next build`. We memoize the resolved config in a closure.
  let resolved: ReturnType<typeof resolveConfig> | null = null

  return function statsMiddleware(req: NextRequest): NextResponse {
    if (!resolved) resolved = resolveConfig(options)
    const runtime = getOrInitRuntime(resolved)

    // Stats endpoint short-circuit — don't track a visit to the dashboard.
    if (req.nextUrl.pathname === resolved.endpointPath) {
      return handleStatsEndpoint(req, runtime)
    }

    trackRequestInternal(req, runtime)
    return NextResponse.next()
  }
}

/**
 * Standalone tracker for users who can't put the library in middleware.
 * Call from `instrumentation.ts` or a route handler.
 */
export function trackRequest(req: NextRequest, options: StatsOptions = {}): void {
  const config = resolveConfig(options)
  const runtime = getOrInitRuntime(config)
  trackRequestInternal(req, runtime)
}

function trackRequestInternal(req: NextRequest, runtime: StatsRuntime): void {
  const ua = req.headers.get('user-agent') ?? ''
  if (runtime.config.filterBots && isBot(ua)) return

  const ip = extractIp(req.headers, (req as { ip?: string }).ip)
  runtime.store.track(ip, ua)
}
