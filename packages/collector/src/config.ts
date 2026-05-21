import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import type {
  RawAppConfig,
  RawConfig,
  ResolvedApp,
  ResolvedConfig,
} from './types.js'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_USER_AGENT = 'swhsd-collect/0.1'
const DEFAULT_DB_FILENAME = 'collector.db'
const MIN_TOKEN_LENGTH_WARNING = 16

/**
 * Locate the config file. First match wins:
 *   1. Explicit `--config <path>` argument
 *   2. $SWHSD_CONFIG env var
 *   3. ./swhsd.json relative to the cwd
 *   4. $XDG_CONFIG_HOME/statswhatshesaid/config.json (default ~/.config/...)
 */
export function discoverConfigPath(explicit: string | undefined): string {
  if (explicit) return resolve(explicit)
  const fromEnv = process.env.SWHSD_CONFIG
  if (fromEnv) return resolve(fromEnv)
  const cwdCandidate = resolve(process.cwd(), 'swhsd.json')
  return cwdCandidate.includes(' ')
    ? cwdCandidate
    : cwdCandidate || defaultXdgConfigPath()
}

/**
 * Same lookup as `discoverConfigPath` but also tells you whether the path
 * came from an explicit user choice or a default. Lets the CLI emit a more
 * helpful error message when the default isn't there.
 */
export interface DiscoveredConfig {
  path: string
  source: 'explicit' | 'env' | 'cwd' | 'xdg'
}

export function discoverConfig(explicit: string | undefined): DiscoveredConfig {
  if (explicit) return { path: resolve(explicit), source: 'explicit' }
  const fromEnv = process.env.SWHSD_CONFIG
  if (fromEnv) return { path: resolve(fromEnv), source: 'env' }
  return { path: resolve(process.cwd(), 'swhsd.json'), source: 'cwd' }
}

export function defaultXdgConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'statswhatshesaid', 'config.json')
}

export function defaultXdgDbPath(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(base, 'statswhatshesaid', DEFAULT_DB_FILENAME)
}

/** Expand a leading `~` to the user's home directory. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

export async function loadConfig(path: string): Promise<ResolvedConfig> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    throw new ConfigError(
      `Cannot read config file at ${path}: ${(err as Error).message}`,
    )
  }
  let parsed: RawConfig
  try {
    parsed = JSON.parse(raw) as RawConfig
  } catch (err) {
    throw new ConfigError(
      `Config file at ${path} is not valid JSON: ${(err as Error).message}`,
    )
  }
  return normalizeConfig(parsed, path)
}

export function normalizeConfig(raw: RawConfig, configPath: string): ResolvedConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError(`Config at ${configPath} must be a JSON object.`)
  }
  if (!raw.apps || typeof raw.apps !== 'object') {
    throw new ConfigError(
      `Config at ${configPath} must declare an "apps" object with at least one entry.`,
    )
  }

  const dbPath = raw.db ? toAbsolutePath(expandTilde(raw.db), configPath) : defaultXdgDbPath()

  const defaultTimeout = raw.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const defaultUserAgent = raw.defaults?.userAgent ?? DEFAULT_USER_AGENT

  const appNames = Object.keys(raw.apps)
  if (appNames.length === 0) {
    throw new ConfigError(`Config at ${configPath} declares no apps.`)
  }

  const apps: ResolvedApp[] = appNames.map((name) =>
    normalizeApp(name, raw.apps[name]!, defaultTimeout, defaultUserAgent, configPath),
  )

  return { dbPath, apps }
}

function normalizeApp(
  name: string,
  raw: RawAppConfig,
  defaultTimeout: number,
  defaultUserAgent: string,
  configPath: string,
): ResolvedApp {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError(`App "${name}" in ${configPath} must be an object.`)
  }
  if (!raw.token || typeof raw.token !== 'string' || raw.token.length === 0) {
    throw new ConfigError(`App "${name}" in ${configPath} is missing a token.`)
  }
  if (raw.token.length < MIN_TOKEN_LENGTH_WARNING) {
    // eslint-disable-next-line no-console
    console.warn(
      `[swhsd-collect] Warning: token for app "${name}" is only ${raw.token.length} characters. ` +
        'Use a long random secret (e.g. `openssl rand -hex 32`) to avoid brute force.',
    )
  }

  const hasUrl = typeof raw.url === 'string' && raw.url.length > 0
  const hasReplicas = Array.isArray(raw.replicas) && raw.replicas.length > 0

  if (hasUrl && hasReplicas) {
    throw new ConfigError(
      `App "${name}" in ${configPath} declares both "url" and "replicas". Use one or the other.`,
    )
  }
  if (!hasUrl && !hasReplicas) {
    throw new ConfigError(
      `App "${name}" in ${configPath} must declare either "url" or "replicas".`,
    )
  }

  const timeoutMs = raw.timeoutMs ?? defaultTimeout
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError(
      `App "${name}" in ${configPath} has an invalid timeoutMs: ${raw.timeoutMs}.`,
    )
  }

  if (hasReplicas) {
    if (!raw.merge) {
      throw new ConfigError(
        `App "${name}" in ${configPath} declares "replicas" but is missing "merge": true. ` +
          'Set "merge": true to make the multi-replica intent explicit.',
      )
    }
    return {
      kind: 'replicated',
      name,
      replicas: raw.replicas!.map(validateUrl(name, configPath)),
      token: raw.token,
      timeoutMs,
      userAgent: defaultUserAgent,
    }
  }

  return {
    kind: 'single',
    name,
    url: validateUrl(name, configPath)(raw.url!),
    token: raw.token,
    timeoutMs,
    userAgent: defaultUserAgent,
  }
}

function validateUrl(appName: string, configPath: string): (s: string) => string {
  return (s: string) => {
    try {
      const u = new URL(s)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error(`unsupported protocol: ${u.protocol}`)
      }
      return s
    } catch (err) {
      throw new ConfigError(
        `App "${appName}" in ${configPath} has an invalid URL ${JSON.stringify(s)}: ${(err as Error).message}`,
      )
    }
  }
}

/** Resolve a config-relative path against the config file's directory. */
function toAbsolutePath(p: string, configPath: string): string {
  if (isAbsolute(p)) return p
  // Resolve relative paths against the directory containing the config file,
  // not the cwd, so the config is portable across machines and shell sessions.
  const dir = configPath.substring(0, configPath.lastIndexOf('/'))
  return resolve(dir || process.cwd(), p)
}

/**
 * Dedicated error type so the CLI can map config problems to exit code 1
 * without having to inspect error messages.
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}
