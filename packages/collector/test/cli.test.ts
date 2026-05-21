import { createServer, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HELP, VERSION, main as runCli } from '../src/cli-main.js'
import type { PollResponse } from '../src/types.js'

/**
 * Minimal capture sink that mimics the WritableStream surface `main` uses.
 * Aggregates everything written into a single string for assertions.
 */
class CaptureStream extends Writable {
  chunks: Buffer[] = []
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk))
    cb()
  }
  get text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

function makeIo() {
  const stdout = new CaptureStream()
  const stderr = new CaptureStream()
  return { io: { stdout, stderr }, stdout, stderr }
}

interface FakeApp {
  server: Server
  url: string
  setStatus: (status: number) => void
}

async function startFakeApp(initial: PollResponse): Promise<FakeApp> {
  let status = 200
  const server = createServer((_req, res: ServerResponse) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(initial))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('addr')
  return {
    server,
    url: `http://127.0.0.1:${addr.port}/stats`,
    setStatus: (next) => {
      status = next
    },
  }
}

function stop(app: FakeApp): Promise<void> {
  return new Promise((resolve) => app.server.close(() => resolve()))
}

describe('runCli — meta commands', () => {
  it('--help prints usage and exits 0', async () => {
    const { io, stdout } = makeIo()
    const code = await runCli(['--help'], io)
    expect(code).toBe(0)
    expect(stdout.text).toContain('swhsd-collect')
    expect(stdout.text).toContain('Usage:')
    expect(stdout.text).toContain('--config')
  })

  it('-h is treated the same as --help', async () => {
    const { io, stdout } = makeIo()
    const code = await runCli(['-h'], io)
    expect(code).toBe(0)
    expect(stdout.text).toContain(HELP)
  })

  it('--version prints the version and exits 0', async () => {
    const { io, stdout } = makeIo()
    const code = await runCli(['--version'], io)
    expect(code).toBe(0)
    expect(stdout.text.trim()).toBe(VERSION)
  })

  it('-V is treated the same as --version', async () => {
    const { io, stdout } = makeIo()
    const code = await runCli(['-V'], io)
    expect(code).toBe(0)
    expect(stdout.text.trim()).toBe(VERSION)
  })

  it('rejects unknown flags and shows help on exit 1', async () => {
    const { io, stderr } = makeIo()
    const code = await runCli(['--no-such-flag'], io)
    expect(code).toBe(1)
    expect(stderr.text).toMatch(/swhsd-collect/)
  })
})

describe('runCli init', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'swhsd-cli-init-'))
  })

  it('writes the starter config and exits 0', async () => {
    const { io, stdout } = makeIo()
    const target = join(workDir, 'swhsd.json')
    const code = await runCli(['init', target], io)
    expect(code).toBe(0)
    expect(existsSync(target)).toBe(true)
    expect(stdout.text).toContain(`Wrote starter config to ${target}`)

    const contents = JSON.parse(readFileSync(target, 'utf8')) as {
      apps: Record<string, unknown>
      $schema: string
    }
    expect(contents.apps).toHaveProperty('example')
    expect(contents.$schema).toContain('config.schema.json')
  })

  it('refuses to overwrite an existing file', async () => {
    const target = join(workDir, 'swhsd.json')
    writeFileSync(target, '{"existing": true}', 'utf8')
    const { io, stderr } = makeIo()
    const code = await runCli(['init', target], io)
    expect(code).toBe(1)
    expect(stderr.text).toMatch(/cannot write starter config/)
    // Original contents must remain untouched.
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ existing: true })
  })
})

describe('runCli run — exit codes', () => {
  let workDir: string
  let app: FakeApp
  let configPath: string
  let dbPath: string

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'swhsd-cli-run-'))
    configPath = join(workDir, 'swhsd.json')
    dbPath = join(workDir, 'collector.db')
    app = await startFakeApp({
      today: { date: '2026-05-21', uniqueVisitors: 17 },
      history: [{ date: '2026-05-20', uniqueVisitors: 50 }],
      generatedAt: '2026-05-21T12:00:00Z',
    })
    writeFileSync(
      configPath,
      JSON.stringify({
        db: dbPath,
        apps: {
          fake: { url: app.url, token: 'a'.repeat(32) },
        },
      }),
      'utf8',
    )
  })

  afterEach(async () => {
    await stop(app)
  })

  it('exits 0 with OK summary when everything works', async () => {
    const { io, stdout } = makeIo()
    const code = await runCli(['--config', configPath], io)
    expect(code).toBe(0)
    expect(stdout.text).toMatch(/OK app=fake today=17 historyRows=1/)
    expect(existsSync(dbPath)).toBe(true)
  })

  it('exits 3 when the only app fails', async () => {
    app.setStatus(401)
    const { io, stderr } = makeIo()
    const code = await runCli(['--config', configPath], io)
    expect(code).toBe(3)
    expect(stderr.text).toMatch(/FAIL app=fake/)
  })

  it('exits 1 when the config file is missing', async () => {
    const { io, stderr } = makeIo()
    const code = await runCli(['--config', join(workDir, 'missing.json')], io)
    expect(code).toBe(1)
    expect(stderr.text).toMatch(/missing.json/)
  })

  it('exits 1 when the config is malformed JSON', async () => {
    writeFileSync(configPath, '{ not json', 'utf8')
    const { io, stderr } = makeIo()
    const code = await runCli(['--config', configPath], io)
    expect(code).toBe(1)
    expect(stderr.text).toMatch(/valid JSON|not valid/i)
  })

  it('exits 2 (partial failure) when some apps fail and others succeed', async () => {
    const goodApp = await startFakeApp({
      today: { date: '2026-05-21', uniqueVisitors: 5 },
      history: [],
      generatedAt: '2026-05-21T12:00:00Z',
    })
    app.setStatus(500)
    writeFileSync(
      configPath,
      JSON.stringify({
        db: dbPath,
        apps: {
          broken: { url: app.url, token: 'a'.repeat(32) },
          good: { url: goodApp.url, token: 'a'.repeat(32) },
        },
      }),
      'utf8',
    )
    const { io, stdout, stderr } = makeIo()
    const code = await runCli(['--config', configPath], io)
    expect(code).toBe(2)
    expect(stdout.text).toMatch(/OK app=good/)
    expect(stderr.text).toMatch(/FAIL app=broken/)
    await stop(goodApp)
  })

  it('--dry-run does not write to the DB', async () => {
    const { io, stdout } = makeIo()
    const code = await runCli(['--config', configPath, '--dry-run'], io)
    expect(code).toBe(0)
    expect(stdout.text).toMatch(/OK app=fake/)
    expect(existsSync(dbPath)).toBe(false)
  })

  it('--verbose prints the discovered config + db path to stderr', async () => {
    const { io, stderr } = makeIo()
    await runCli(['--config', configPath, '--verbose'], io)
    expect(stderr.text).toContain(`config=${configPath}`)
    expect(stderr.text).toContain(`db=${dbPath}`)
    expect(stderr.text).toContain('apps=fake')
  })
})

describe('runCli — repeated runs against the same DB (resume)', () => {
  let workDir: string
  let app: FakeApp
  let configPath: string
  let dbPath: string

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'swhsd-cli-resume-'))
    configPath = join(workDir, 'swhsd.json')
    dbPath = join(workDir, 'c.db')
    app = await startFakeApp({
      today: { date: '2026-05-21', uniqueVisitors: 10 },
      history: [
        { date: '2026-05-20', uniqueVisitors: 100 },
        { date: '2026-05-19', uniqueVisitors: 95 },
      ],
      generatedAt: '2026-05-21T12:00:00Z',
    })
    writeFileSync(
      configPath,
      JSON.stringify({
        db: dbPath,
        apps: { fake: { url: app.url, token: 'a'.repeat(32) } },
      }),
      'utf8',
    )
  })

  afterEach(async () => {
    await stop(app)
  })

  it('running twice keeps history rows constant (idempotent) and accumulates today snapshots', async () => {
    // We lazy-import better-sqlite3 to inspect the DB after the second run.
    const Database = (await import('better-sqlite3')).default

    const r1 = await runCli(['--config', configPath], makeIo().io)
    expect(r1).toBe(0)

    const db1 = new Database(dbPath, { readonly: true })
    const after1 = db1
      .prepare(`SELECT is_today, COUNT(*) AS c FROM snapshots GROUP BY is_today`)
      .all() as Array<{ is_today: number; c: number }>
    db1.close()
    expect(after1).toEqual([
      { is_today: 0, c: 2 },
      { is_today: 1, c: 1 },
    ])

    const r2 = await runCli(['--config', configPath], makeIo().io)
    expect(r2).toBe(0)

    const db2 = new Database(dbPath, { readonly: true })
    const after2 = db2
      .prepare(`SELECT is_today, COUNT(*) AS c FROM snapshots GROUP BY is_today`)
      .all() as Array<{ is_today: number; c: number }>
    db2.close()
    // History rows are idempotent: still 2. Today rows grew by 1 — second
    // snapshot of today is genuinely a new datapoint.
    expect(after2).toEqual([
      { is_today: 0, c: 2 },
      { is_today: 1, c: 2 },
    ])
  })
})

describe('runCli serve', () => {
  it('--help mentions the serve subcommand', async () => {
    const { io, stdout } = makeIo()
    const code = await runCli(['--help'], io)
    expect(code).toBe(0)
    expect(stdout.text).toMatch(/serve/)
  })

  it('serve --help prints serve-specific options', async () => {
    const { io, stdout } = makeIo()
    const code = await runCli(['serve', '--help'], io)
    expect(code).toBe(0)
    expect(stdout.text).toMatch(/--port/)
    expect(stdout.text).toMatch(/--host/)
  })

  it('serve rejects an invalid --port value with exit code 1', async () => {
    const { io, stderr } = makeIo()
    const code = await runCli(['serve', '--port', 'abc'], io)
    expect(code).toBe(1)
    expect(stderr.text).toMatch(/port/i)
  })

  it('serve boots, prints the listening URL, and shuts down on SIGINT', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'swhsd-cli-serve-'))
    const dbPath = join(workDir, 'c.db')
    const { CollectorDb } = await import('../src/db.js')
    CollectorDb.open(dbPath).close()
    const configPath = join(workDir, 'swhsd.json')
    writeFileSync(
      configPath,
      JSON.stringify({ db: dbPath, apps: {} }),
      'utf8',
    )

    const { io, stderr } = makeIo()
    const promise = runCli(
      ['serve', '--config', configPath, '--host', '127.0.0.1', '--port', '0'],
      io,
    )

    for (let i = 0; i < 50 && !stderr.text.includes('Listening'); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(stderr.text).toMatch(/Listening on http:\/\/127\.0\.0\.1:\d+/)

    process.kill(process.pid, 'SIGINT')
    const code = await promise
    expect(code).toBe(0)
  })
})
