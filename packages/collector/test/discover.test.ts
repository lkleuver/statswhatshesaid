import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  defaultDbPath,
  defaultXdgConfigPath,
  discoverConfig,
} from '../src/config.js'

describe('discoverConfig — precedence', () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    // Each test runs in a clean temp dir so the cwd fallback resolves
    // deterministically against `swhsd.json` in there (or doesn't, if absent).
    const dir = mkdtempSync(join(tmpdir(), 'swhsd-discover-cwd-'))
    process.chdir(dir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    vi.unstubAllEnvs()
  })

  it('explicit --config wins over $SWHSD_CONFIG and cwd', () => {
    vi.stubEnv('SWHSD_CONFIG', '/from/env.json')
    writeFileSync('./swhsd.json', '{}', 'utf8')
    const d = discoverConfig('./explicit.json')
    expect(d.source).toBe('explicit')
    expect(d.path).toBe(resolve('./explicit.json'))
  })

  it('$SWHSD_CONFIG wins over the cwd fallback when no flag is set', () => {
    vi.stubEnv('SWHSD_CONFIG', '/from/env.json')
    writeFileSync('./swhsd.json', '{}', 'utf8')
    const d = discoverConfig(undefined)
    expect(d.source).toBe('env')
    expect(d.path).toBe(resolve('/from/env.json'))
  })

  it('falls back to ./swhsd.json in the cwd when no flag and no env var', () => {
    vi.stubEnv('SWHSD_CONFIG', '')
    const d = discoverConfig(undefined)
    expect(d.source).toBe('cwd')
    expect(d.path).toBe(resolve('swhsd.json'))
  })

  it('resolves relative --config paths against the cwd', () => {
    const d = discoverConfig('./sub/config.json')
    expect(d.path).toBe(resolve('./sub/config.json'))
  })
})

describe('defaultXdgConfigPath', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('uses $XDG_CONFIG_HOME when set', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '/custom/cfg')
    expect(defaultXdgConfigPath()).toBe('/custom/cfg/statswhatshesaid/config.json')
  })

  it('falls back to ~/.config when $XDG_CONFIG_HOME is unset', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '')
    const p = defaultXdgConfigPath()
    expect(p).toMatch(/\/\.config\/statswhatshesaid\/config\.json$/)
  })
})

describe('defaultDbPath', () => {
  it('returns collector.db next to the config file', () => {
    expect(defaultDbPath('/etc/swhsd/config.json')).toBe('/etc/swhsd/collector.db')
  })

  it('handles a config in the current directory', () => {
    expect(defaultDbPath('swhsd.json')).toBe('collector.db')
  })

  it('preserves nested config directories', () => {
    expect(defaultDbPath('/home/user/.config/statswhatshesaid/config.json'))
      .toBe('/home/user/.config/statswhatshesaid/collector.db')
  })
})
