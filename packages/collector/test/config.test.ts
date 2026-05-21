import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  let workDir: string
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'swhsd-collector-config-'))
  })
  afterEach(() => {
    // Leave temp dirs to OS cleanup — tiny size.
  })

  function writeConfig(contents: string): string {
    const p = join(workDir, 'swhsd.json')
    writeFileSync(p, contents, 'utf8')
    return p
  }

  it('throws ConfigError when the file does not exist', async () => {
    await expect(loadConfig(join(workDir, 'missing.json'))).rejects.toBeInstanceOf(ConfigError)
  })

  it('throws ConfigError for invalid JSON', async () => {
    const p = writeConfig('{ this is not json }')
    await expect(loadConfig(p)).rejects.toBeInstanceOf(ConfigError)
  })

  it('throws when apps is missing', async () => {
    const p = writeConfig('{}')
    await expect(loadConfig(p)).rejects.toThrow(/apps/)
  })

  it('parses a minimal single-app config', async () => {
    const p = writeConfig(JSON.stringify({
      apps: {
        blog: { url: 'https://blog.example.com/stats', token: 'a'.repeat(32) },
      },
    }))
    const cfg = await loadConfig(p)
    expect(cfg.apps).toHaveLength(1)
    const app = cfg.apps[0]!
    expect(app.kind).toBe('single')
    expect(app.name).toBe('blog')
    if (app.kind === 'single') {
      expect(app.url).toBe('https://blog.example.com/stats')
      expect(app.token).toBe('a'.repeat(32))
      expect(app.timeoutMs).toBe(10000)
      expect(app.userAgent).toBe('statswhatshesaid-collector/0.1')
    }
  })

  it('overrides defaults per app', async () => {
    const p = writeConfig(JSON.stringify({
      defaults: { timeoutMs: 5000, userAgent: 'custom/1.0' },
      apps: {
        slow: {
          url: 'https://x.example.com/stats',
          token: 'a'.repeat(32),
          timeoutMs: 30000,
        },
      },
    }))
    const cfg = await loadConfig(p)
    const app = cfg.apps[0]!
    if (app.kind === 'single') {
      expect(app.timeoutMs).toBe(30000)
      expect(app.userAgent).toBe('custom/1.0')
    }
  })

  it('parses a multi-replica app with merge: true', async () => {
    const p = writeConfig(JSON.stringify({
      apps: {
        api: {
          replicas: ['https://r1/stats', 'https://r2/stats'],
          token: 'a'.repeat(32),
          merge: true,
        },
      },
    }))
    const cfg = await loadConfig(p)
    const app = cfg.apps[0]!
    expect(app.kind).toBe('replicated')
    if (app.kind === 'replicated') {
      expect(app.replicas).toEqual(['https://r1/stats', 'https://r2/stats'])
    }
  })

  it('rejects replicas without merge: true', async () => {
    const p = writeConfig(JSON.stringify({
      apps: {
        api: {
          replicas: ['https://r1/stats', 'https://r2/stats'],
          token: 'a'.repeat(32),
        },
      },
    }))
    await expect(loadConfig(p)).rejects.toThrow(/merge/)
  })

  it('rejects mutually exclusive url + replicas', async () => {
    const p = writeConfig(JSON.stringify({
      apps: {
        bad: {
          url: 'https://x/stats',
          replicas: ['https://r1/stats'],
          token: 'a'.repeat(32),
          merge: true,
        },
      },
    }))
    await expect(loadConfig(p)).rejects.toThrow(/url.*replicas|replicas.*url/i)
  })

  it('rejects apps with neither url nor replicas', async () => {
    const p = writeConfig(JSON.stringify({
      apps: { bad: { token: 'a'.repeat(32) } },
    }))
    await expect(loadConfig(p)).rejects.toThrow(/url.*replicas/i)
  })

  it('rejects an invalid URL', async () => {
    const p = writeConfig(JSON.stringify({
      apps: {
        bad: { url: 'ftp://nope', token: 'a'.repeat(32) },
      },
    }))
    await expect(loadConfig(p)).rejects.toThrow(/invalid URL|protocol/)
  })

  it('accepts a config-relative db path', async () => {
    const p = writeConfig(JSON.stringify({
      db: './my.db',
      apps: {
        blog: { url: 'https://x/stats', token: 'a'.repeat(32) },
      },
    }))
    const cfg = await loadConfig(p)
    expect(cfg.dbPath).toBe(join(workDir, 'my.db'))
  })
})
