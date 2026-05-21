import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { isBot } from './bots.js'
import { resolveConfig } from './config.js'
import { extractIp, isStaticPath } from './identity.js'
import { handleStatsEndpoint } from './endpoint.js'
import { getOrInitRuntime, type StatsRuntime } from './lifecycle.js'
import type { StatsOptions } from './types.js'

export type StatsMiddleware = (req: NextRequest) => Promise<NextResponse>

/**
 * Build a Next.js middleware that tracks unique visitors.
 *
 * Returns an `async` function compatible with Next.js's middleware contract.
 * Lazy config resolution: the closure does not call `resolveConfig` until
 * the first request, so module-load (and `next build`) won't fail just
 * because `STATS_TOKEN` isn't set yet.
 */
export function createMiddleware(options: StatsOptions = {}): StatsMiddleware {
  let resolved: ReturnType<typeof resolveConfig> | null = null

  return async function statsMiddleware(req: NextRequest): Promise<NextResponse> {
    if (!resolved) resolved = resolveConfig(options)
    const runtime = getOrInitRuntime(resolved)

    // Stats endpoint short-circuit — don't track a visit to the dashboard.
    if (req.nextUrl.pathname === resolved.endpointPath) {
      return handleStatsEndpoint(req, runtime)
    }

    // Self-filter common static paths so users don't need their own
    // `matcher` config in middleware.ts.
    if (isStaticPath(req.nextUrl.pathname)) {
      return NextResponse.next()
    }

    await trackRequestInternal(req, runtime)
    return NextResponse.next()
  }
}

/**
 * Standalone tracker for users who want to call from a route handler or
 * `instrumentation.ts` instead of from middleware.
 */
export async function trackRequest(
  req: NextRequest,
  options: StatsOptions = {},
): Promise<void> {
  const config = resolveConfig(options)
  const runtime = getOrInitRuntime(config)
  await trackRequestInternal(req, runtime)
}

/**
 * Max number of User-Agent bytes we feed into the visitor hash. Node's HTTP
 * parser already caps header size at ~16 KB, but we truncate defensively so
 * an oversized UA can't cause per-request CPU blow-up.
 */
const MAX_UA_LENGTH = 512

async function trackRequestInternal(
  req: NextRequest,
  runtime: StatsRuntime,
): Promise<void> {
  try {
    const rawUa = req.headers.get('user-agent') ?? ''
    // Truncate BEFORE the bot filter so a 10 KB UA with "bot" on the far right
    // is still filtered — the regex only needs to see the prefix.
    const ua = rawUa.length > MAX_UA_LENGTH ? rawUa.slice(0, MAX_UA_LENGTH) : rawUa
    if (runtime.config.filterBots && isBot(ua)) return

    const ip = extractIp(req.headers, runtime.config.trustProxy)
    await runtime.store.track(ip, ua)
  } catch (err) {
    // Never let a tracking failure take down the user's request.
    // eslint-disable-next-line no-console
    console.error('[statswhatshesaid] track failed:', err)
  }
}
