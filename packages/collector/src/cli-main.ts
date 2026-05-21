import { readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import {
  ConfigError,
  defaultXdgConfigPath,
  defaultXdgDbPath,
  discoverConfig,
  expandTilde,
  loadConfig,
} from './config.js'
import { CollectorDb } from './db.js'
import { runOnce } from './run.js'
import type { AppOutcome } from './types.js'

/**
 * Bumped on each release. Surfaced via `--version`.
 */
export const VERSION = '0.1.0'

/**
 * Streams the CLI writes to. `cli.ts` injects `process.stdout` / `process.stderr`;
 * tests inject capture buffers so they can assert on output without spawning
 * a subprocess.
 */
export interface IoStreams {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

export const HELP = `
swhsd-collect — poll statswhatshesaid endpoints and persist results to SQLite.

Usage:
  swhsd-collect [options]                Run one poll cycle (default).
  swhsd-collect init [path]              Write a starter config file.
  swhsd-collect serve [options]          Serve a local dashboard from the DB.

Run options:
  --config <path>   Path to the config file (default: ./swhsd.json or XDG)
  --dry-run         Poll all apps and print results; do NOT write to the DB
  --keep-raw        Also store the full response JSON in snapshots.raw
  --verbose         Log per-request details to stderr

Serve options:
  --config <path>   Path to the config file (used only to discover the DB path)
  --port <n>        Listen port (default: 7878)
  --host <addr>     Bind address (default: 127.0.0.1)

Common:
  --help, -h        Show this help text
  --version, -V     Print the collector version

Exit codes:
  0  success (poll cycle clean, or serve shut down cleanly)
  1  config / flag error
  2  partial poll failure (one or more apps could not be polled)
  3  total failure (DB error, bind error, all apps failed)
`.trim()

interface ParsedArgs {
  command: 'run' | 'init' | 'serve' | 'help' | 'version'
  configPath?: string
  initPath?: string
  dryRun: boolean
  keepRaw: boolean
  verbose: boolean
  host?: string
  port?: number
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const sub = argv[0]
  if (sub === 'help' || argv.includes('--help') || argv.includes('-h')) {
    return { command: 'help', dryRun: false, keepRaw: false, verbose: false }
  }
  if (argv.includes('--version') || argv.includes('-V')) {
    return { command: 'version', dryRun: false, keepRaw: false, verbose: false }
  }

  if (sub === 'init') {
    return {
      command: 'init',
      initPath: argv[1] ?? './swhsd.json',
      dryRun: false,
      keepRaw: false,
      verbose: false,
    }
  }

  if (sub === 'serve') {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        config: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    let port = 7878
    if (values.port != null) {
      const parsed = Number(values.port)
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`invalid --port value: ${values.port}`)
      }
      port = parsed
    }
    return {
      command: 'serve',
      configPath: values.config,
      host: values.host ?? '127.0.0.1',
      port,
      dryRun: false,
      keepRaw: false,
      verbose: false,
    }
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'keep-raw': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  })

  return {
    command: 'run',
    configPath: values.config,
    dryRun: Boolean(values['dry-run']),
    keepRaw: Boolean(values['keep-raw']),
    verbose: Boolean(values.verbose),
  }
}

const STARTER_CONFIG = `{
  "$schema": "https://github.com/lkleuver/statswhatshesaid/raw/main/packages/collector/config.schema.json",
  "db": "~/.local/share/statswhatshesaid/collector.db",
  "defaults": {
    "timeoutMs": 10000,
    "userAgent": "swhsd-collect/0.1"
  },
  "apps": {
    "example": {
      "url": "https://your-app.example.com/stats",
      "token": "REPLACE_ME_with_openssl_rand_hex_32"
    }
  }
}
`

/**
 * Pure CLI entry point. Accepts argv and an IO sink and returns an exit
 * code. Never calls `process.exit` — that's the wrapper script's job.
 *
 * Tests call this directly with capture buffers and assert on the resulting
 * exit code, captured output, and side effects (DB file, written config).
 */
export async function main(argv: string[], io: IoStreams): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseCliArgs(argv)
  } catch (err) {
    io.stderr.write(`swhsd-collect: ${(err as Error).message}\n${HELP}\n`)
    return 1
  }

  if (parsed.command === 'help') {
    io.stdout.write(HELP + '\n')
    return 0
  }
  if (parsed.command === 'version') {
    io.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (parsed.command === 'init') {
    const target = resolve(parsed.initPath ?? './swhsd.json')
    try {
      await writeFile(target, STARTER_CONFIG, { flag: 'wx' })
    } catch (err) {
      io.stderr.write(
        `swhsd-collect: cannot write starter config to ${target}: ${(err as Error).message}\n`,
      )
      return 1
    }
    io.stdout.write(`Wrote starter config to ${target}\n`)
    io.stdout.write('Edit it to point at your app(s), then run: swhsd-collect\n')
    return 0
  }

  if (parsed.command === 'serve') {
    return runServeCommand(parsed, io)
  }

  return runCommand(parsed, io)
}

async function runCommand(parsed: ParsedArgs, io: IoStreams): Promise<number> {
  const discovered = discoverConfig(parsed.configPath)
  let config: Awaited<ReturnType<typeof loadConfig>>
  try {
    config = await loadConfig(discovered.path)
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr.write(`${err.message}\n`)
      if (discovered.source === 'cwd') {
        io.stderr.write(
          `Hint: run \`swhsd-collect init\` to create a starter config, or look for one at\n` +
            `      ${defaultXdgConfigPath()}\n`,
        )
      }
      return 1
    }
    throw err
  }

  if (parsed.verbose) {
    io.stderr.write(
      `[swhsd-collect] config=${discovered.path}\n` +
        `[swhsd-collect] db=${config.dbPath}\n` +
        `[swhsd-collect] apps=${config.apps.map((a) => a.name).join(', ')}\n`,
    )
  }

  let db: CollectorDb | null = null
  if (!parsed.dryRun) {
    try {
      db = CollectorDb.open(config.dbPath)
    } catch (err) {
      io.stderr.write(
        `Failed to open database at ${config.dbPath}: ${(err as Error).message}\n`,
      )
      return 3
    }
  }

  try {
    const result = await runOnce({
      config,
      // In dry-run mode the run loop never touches the db — the cast is safe.
      db: db as CollectorDb,
      dryRun: parsed.dryRun,
      keepRaw: parsed.keepRaw,
      onOutcome: (outcome) => printOutcome(outcome, parsed.verbose, io),
    })
    return overallExitCode(result.outcomes)
  } finally {
    db?.close()
  }
}

function printOutcome(outcome: AppOutcome, verbose: boolean, io: IoStreams): void {
  if (outcome.status === 'ok') {
    io.stdout.write(
      `OK app=${outcome.app} today=${outcome.today} historyRows=${outcome.historyRows}\n`,
    )
  } else if (outcome.status === 'skipped') {
    io.stdout.write(`SKIP app=${outcome.app} reason=${truncate(outcome.reason, verbose)}\n`)
  } else {
    io.stderr.write(`FAIL app=${outcome.app} reason=${truncate(outcome.reason, verbose)}\n`)
  }
}

function truncate(s: string, verbose: boolean): string {
  if (verbose) return s
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

function overallExitCode(outcomes: AppOutcome[]): number {
  const anyOk = outcomes.some((o) => o.status === 'ok')
  const anyFailed = outcomes.some((o) => o.status === 'failed')
  if (anyFailed && !anyOk) return 3
  if (anyFailed) return 2
  return 0
}

/**
 * Read only the `db` field from the config file, resolving it to an absolute
 * path. We intentionally skip full config validation here — `serve` only needs
 * the DB path and should work even on configs that have no apps defined yet.
 */
async function resolveDbPath(configPath: string): Promise<string> {
  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch (err) {
    throw new ConfigError(
      `Cannot read config file at ${configPath}: ${(err as Error).message}`,
    )
  }
  let parsed: { db?: string }
  try {
    parsed = JSON.parse(raw) as { db?: string }
  } catch (err) {
    throw new ConfigError(
      `Config file at ${configPath} is not valid JSON: ${(err as Error).message}`,
    )
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ConfigError(`Config at ${configPath} must be a JSON object.`)
  }
  if (!parsed.db) return defaultXdgDbPath()
  const expanded = expandTilde(parsed.db)
  // Relative paths resolve against the config file's directory, matching
  // `loadConfig`'s behaviour — keeps `swhsd.json` portable across machines.
  if (isAbsolute(expanded)) return expanded
  return resolve(dirname(configPath), expanded)
}

async function runServeCommand(parsed: ParsedArgs, io: IoStreams): Promise<number> {
  const discovered = discoverConfig(parsed.configPath)
  let dbPath: string
  try {
    dbPath = await resolveDbPath(discovered.path)
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr.write(`${err.message}\n`)
      return 1
    }
    throw err
  }

  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const { runServe } = await import('./serve-cmd.js')
    return await runServe(
      {
        dbPath,
        host: parsed.host ?? '127.0.0.1',
        port: parsed.port ?? 7878,
        signal: controller.signal,
      },
      io,
    )
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}
