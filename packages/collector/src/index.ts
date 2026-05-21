/**
 * Programmatic entry point for `statswhatshesaid-collector`. Most users
 * will only invoke the `swhsd-collect` CLI, but the same primitives are
 * exposed here so the collector can be embedded in scripts or tests.
 */

export { loadConfig, discoverConfig, ConfigError, defaultXdgDbPath, defaultXdgConfigPath } from './config.js'
export { CollectorDb } from './db.js'
export { pollOne, PollError } from './poll.js'
export { reconcileApp } from './reconcile.js'
export { runOnce } from './run.js'
export { main as runCli, VERSION, HELP } from './cli-main.js'
export type { IoStreams } from './cli-main.js'

export type {
  RawConfig,
  RawAppConfig,
  RawDefaults,
  ResolvedApp,
  ResolvedSingleApp,
  ResolvedReplicatedApp,
  ResolvedConfig,
  PollResponse,
  AppOutcome,
} from './types.js'
