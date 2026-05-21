import { createMiddleware, trackRequest } from './middleware.js'

/**
 * Pre-instantiated default middleware. Lets users drop the library in with
 * a single line in their `middleware.ts`:
 *
 * ```ts
 * export { default } from 'statswhatshesaid'
 * ```
 *
 * The default middleware reads its configuration from environment variables
 * (`STATS_TOKEN` is required, the rest have sensible defaults). Config
 * resolution is deferred to the first request, so `next build` works fine
 * without `STATS_TOKEN` set — the error only fires at runtime.
 *
 * For customized configuration, import `createMiddleware` and call it with
 * your options:
 *
 * ```ts
 * import { createMiddleware } from 'statswhatshesaid'
 * export default createMiddleware({ filterBots: false })
 * ```
 */
const defaultMiddleware = createMiddleware()

export default defaultMiddleware
export { createMiddleware, trackRequest }
export type { StatsOptions, StatsResponseBody, DailyCount } from './types.js'
export type { StatsMiddleware } from './middleware.js'
