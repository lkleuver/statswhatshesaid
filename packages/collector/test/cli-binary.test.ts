import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * End-to-end test of the built `dist/cli.js` binary. This catches things
 * the in-process `main()` tests can't: shebang preservation, ESM resolution
 * inside the bundled output, native module loading (better-sqlite3), and
 * actual `process.exit` semantics.
 *
 * Skips itself with a clear message if `dist/cli.js` hasn't been built yet,
 * so the test suite still runs cleanly on a fresh checkout.
 */
const DIST_CLI = resolve(__dirname, '../dist/cli.js')

interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

function runBinary(args: string[]): Promise<SpawnResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [DIST_CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (b) => stdout.push(b))
    child.stderr.on('data', (b) => stderr.push(b))
    child.on('error', reject)
    child.on('close', (code) => {
      resolveResult({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

const buildExists = existsSync(DIST_CLI)
const describeIfBuilt = buildExists ? describe : describe.skip

if (!buildExists) {
  // eslint-disable-next-line no-console
  console.warn(
    `[cli-binary.test] Skipping — ${DIST_CLI} not built yet. Run \`npm run build\` first.`,
  )
}

describeIfBuilt('built dist/cli.js binary', () => {
  it('runs with --help and prints usage', async () => {
    const result = await runBinary(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('swhsd-collect')
    expect(result.stdout).toContain('--config')
  }, 15000)

  it('runs with --version and prints a version string', async () => {
    const result = await runBinary(['--version'])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-.+)?$/)
  }, 15000)

  it('exits 1 with a helpful message when no config is found', async () => {
    // Run from a fresh temp dir to ensure ./swhsd.json doesn't exist.
    const dir = mkdtempSync(join(tmpdir(), 'swhsd-cli-bin-'))
    const result = await new Promise<SpawnResult>((resolveResult, reject) => {
      const child = spawn(process.execPath, [DIST_CLI], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: dir,
        env: { ...process.env, SWHSD_CONFIG: '' },
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', (b) => stdout.push(b))
      child.stderr.on('data', (b) => stderr.push(b))
      child.on('error', reject)
      child.on('close', (code) =>
        resolveResult({
          code: code ?? -1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }),
      )
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/swhsd\.json|cannot read config/i)
  }, 15000)

  it('exits 0 against a real fake server (full smoke test)', async () => {
    const { createServer } = await import('node:http')
    const dir = mkdtempSync(join(tmpdir(), 'swhsd-cli-bin-smoke-'))

    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          today: { date: '2026-05-21', uniqueVisitors: 33 },
          history: [{ date: '2026-05-20', uniqueVisitors: 21 }],
          generatedAt: '2026-05-21T12:00:00Z',
        }),
      )
    })
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('addr')
    const url = `http://127.0.0.1:${addr.port}/stats`

    const configPath = join(dir, 'swhsd.json')
    const dbPath = join(dir, 'c.db')
    writeFileSync(
      configPath,
      JSON.stringify({
        db: dbPath,
        apps: { fake: { url, token: 'a'.repeat(32) } },
      }),
      'utf8',
    )

    try {
      const result = await runBinary(['--config', configPath])
      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(/OK app=fake today=33/)
      expect(existsSync(dbPath)).toBe(true)
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  }, 15000)
})
