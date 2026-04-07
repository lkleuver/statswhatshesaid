import { createMiddleware, trackRequest, type StatsMiddleware } from './middleware.js'
import type { StatsOptions } from './types.js'

const stats = {
  middleware: (options?: StatsOptions): StatsMiddleware => createMiddleware(options),
  track: trackRequest,
}

export default stats
export type { StatsOptions, StatsResponseBody, DailyCount } from './types.js'
export type { StatsMiddleware } from './middleware.js'
export type { PersistAdapter, SnapshotV1 } from './snapshot.js'
export { FileSnapshotAdapter } from './snapshot.js'
