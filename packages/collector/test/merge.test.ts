import { createHash } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HyperLogLog,
  encodeRegistersBase64,
  estimateRegisters,
  mergeManyRegisters,
} from '@swhsd/hll'

import { CollectorDb } from '../src/db.js'
import { runOnce } from '../src/run.js'
import { MergeError, pollAndMerge } from '../src/merge.js'
import type { PollResponse, ResolvedConfig } from '../src/types.js'

/**
 * Spin up a fake replica that returns a deterministic `/stats?format=raw`
 * response. Each replica gets its own port and its own pre-baked HLL
 * sketch + shared salt fingerprint.
 */
interface FakeReplica {
  server: Server
  url: string
}

function buildSketchFromItems(items: readonly string[]): Uint8Array {
  const hll = new HyperLogLog()
  for (const item of items) {
    hll.addHashBuffer(createHash('sha256').update(item).digest())
  }
  return hll.cloneRegisters()
}

async function startReplica(args: {
  date: string
  saltFingerprint: string
  items: readonly string[]
  uniqueVisitorsOverride?: number
}): Promise<FakeReplica> {
  const sketch = buildSketchFromItems(args.items)
  const response: PollResponse = {
    today: {
      date: args.date,
      uniqueVisitors: args.uniqueVisitorsOverride ?? estimateRegisters(sketch),
      sketch: encodeRegistersBase64(sketch),
      saltFingerprint: args.saltFingerprint,
    },
    history: [],
    generatedAt: '2026-04-07T12:00:00Z',
  }
  const server = createServer((_req, res: ServerResponse) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(response))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('addr')
  return { server, url: `http://127.0.0.1:${addr.port}/stats` }
}

function stop(rep: FakeReplica): Promise<void> {
  return new Promise((resolve) => rep.server.close(() => resolve()))
}

describe('pollAndMerge', () => {
  let replicas: FakeReplica[]

  afterEach(async () => {
    await Promise.all(replicas.map(stop))
    replicas = []
  })

  it('merges sketches register-wise to recover the union cardinality', async () => {
    const fp = 'aaaaaaaaaaaaaaaa'
    // Split 3,000 disjoint visitors evenly across three replicas.
    const all: string[] = []
    for (let i = 0; i < 3000; i++) all.push(`visitor-${i}`)
    const a = all.slice(0, 1000)
    const b = all.slice(1000, 2000)
    const c = all.slice(2000)

    replicas = await Promise.all([
      startReplica({ date: '2026-04-07', saltFingerprint: fp, items: a }),
      startReplica({ date: '2026-04-07', saltFingerprint: fp, items: b }),
      startReplica({ date: '2026-04-07', saltFingerprint: fp, items: c }),
    ])

    const { merged, replicas: snaps } = await pollAndMerge({
      kind: 'replicated',
      name: 'api',
      replicas: replicas.map((r) => r.url),
      token: 'a'.repeat(32),
      timeoutMs: 5000,
      userAgent: 'swhsd-test',
    })

    expect(snaps).toHaveLength(3)
    expect(snaps.every((s) => s.saltFingerprint === fp)).toBe(true)

    // Ground truth: merged register array via the same primitive used by
    // the collector. The HTTP round trip + base64 encode/decode should be
    // lossless, so the merge result must match exactly.
    const groundTruth = mergeManyRegisters([
      buildSketchFromItems(a),
      buildSketchFromItems(b),
      buildSketchFromItems(c),
    ])
    expect(merged.today.uniqueVisitors).toBe(estimateRegisters(groundTruth))

    // History is intentionally empty in merge mode.
    expect(merged.history).toEqual([])
  })

  it('throws MergeError when fingerprints disagree (misconfigured replica)', async () => {
    replicas = await Promise.all([
      startReplica({ date: '2026-04-07', saltFingerprint: 'aaaaaaaaaaaaaaaa', items: ['x', 'y'] }),
      startReplica({ date: '2026-04-07', saltFingerprint: 'bbbbbbbbbbbbbbbb', items: ['y', 'z'] }),
    ])

    await expect(
      pollAndMerge({
        kind: 'replicated',
        name: 'api',
        replicas: replicas.map((r) => r.url),
        token: 'a'.repeat(32),
        timeoutMs: 5000,
        userAgent: 'swhsd-test',
      }),
    ).rejects.toBeInstanceOf(MergeError)
  })

  it('throws MergeError when one replica is mid-rollover (date mismatch)', async () => {
    replicas = await Promise.all([
      startReplica({ date: '2026-04-07', saltFingerprint: 'aaaaaaaaaaaaaaaa', items: ['x'] }),
      startReplica({ date: '2026-04-08', saltFingerprint: 'aaaaaaaaaaaaaaaa', items: ['y'] }),
    ])

    await expect(
      pollAndMerge({
        kind: 'replicated',
        name: 'api',
        replicas: replicas.map((r) => r.url),
        token: 'a'.repeat(32),
        timeoutMs: 5000,
        userAgent: 'swhsd-test',
      }),
    ).rejects.toBeInstanceOf(MergeError)
  })

  it('throws MergeError when a replica responds without a raw sketch', async () => {
    replicas = await Promise.all([
      startReplica({ date: '2026-04-07', saltFingerprint: 'aaaaaaaaaaaaaaaa', items: ['x'] }),
    ])
    // Pretend the second replica is on the library version without raw
    // support: it returns the JSON minus sketch/saltFingerprint.
    const plainServer = createServer((_req, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        today: { date: '2026-04-07', uniqueVisitors: 5 },
        history: [],
        generatedAt: '2026-04-07T12:00:00Z',
      }))
    })
    await new Promise<void>((resolve) => plainServer.listen(0, '127.0.0.1', resolve))
    const addr = plainServer.address()
    if (!addr || typeof addr === 'string') throw new Error('addr')
    const plainReplica: FakeReplica = {
      server: plainServer,
      url: `http://127.0.0.1:${addr.port}/stats`,
    }
    replicas.push(plainReplica)

    await expect(
      pollAndMerge({
        kind: 'replicated',
        name: 'api',
        replicas: replicas.map((r) => r.url),
        token: 'a'.repeat(32),
        timeoutMs: 5000,
        userAgent: 'swhsd-test',
      }),
    ).rejects.toBeInstanceOf(MergeError)
  })
})

describe('runOnce with replicated apps', () => {
  let replicas: FakeReplica[]
  let dbHandle: { db: CollectorDb; path: string }

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'swhsd-merge-'))
    dbHandle = { db: CollectorDb.open(join(dir, 'c.db')), path: join(dir, 'c.db') }
  })

  afterEach(async () => {
    dbHandle.db.close()
    await Promise.all((replicas ?? []).map(stop))
  })

  it('writes a merged today row and per-replica details on success', async () => {
    const fp = 'cafebabecafebabe'
    replicas = await Promise.all([
      startReplica({ date: '2026-04-07', saltFingerprint: fp, items: ['a', 'b', 'c'] }),
      startReplica({ date: '2026-04-07', saltFingerprint: fp, items: ['c', 'd', 'e'] }),
    ])

    const cfg: ResolvedConfig = {
      dbPath: dbHandle.path,
      apps: [
        {
          kind: 'replicated',
          name: 'api',
          replicas: replicas.map((r) => r.url),
          token: 'a'.repeat(32),
          timeoutMs: 5000,
          userAgent: 'swhsd-test',
        },
      ],
    }

    const result = await runOnce({ config: cfg, db: dbHandle.db })
    expect(result.outcomes[0]?.status).toBe('ok')

    const snapshot = dbHandle.db.db
      .prepare(`SELECT app, source, is_today FROM snapshots`)
      .all()
    expect(snapshot).toEqual([{ app: 'api', source: 'merged', is_today: 1 }])

    const replicaRows = dbHandle.db.db
      .prepare(`SELECT app, salt_fingerprint FROM replica_snapshots`)
      .all() as Array<{ app: string; salt_fingerprint: string }>
    expect(replicaRows).toHaveLength(2)
    expect(replicaRows.every((r) => r.salt_fingerprint === fp)).toBe(true)
  })

  it('records replica_snapshots even when the merge cycle fails', async () => {
    replicas = await Promise.all([
      startReplica({ date: '2026-04-07', saltFingerprint: 'aaaaaaaaaaaaaaaa', items: ['x'] }),
      startReplica({ date: '2026-04-07', saltFingerprint: 'bbbbbbbbbbbbbbbb', items: ['y'] }),
    ])

    const cfg: ResolvedConfig = {
      dbPath: dbHandle.path,
      apps: [
        {
          kind: 'replicated',
          name: 'api',
          replicas: replicas.map((r) => r.url),
          token: 'a'.repeat(32),
          timeoutMs: 5000,
          userAgent: 'swhsd-test',
        },
      ],
    }

    const result = await runOnce({ config: cfg, db: dbHandle.db })
    expect(result.outcomes[0]?.status).toBe('failed')

    // No row should land in snapshots — the merge was invalid.
    const snap = dbHandle.db.db.prepare(`SELECT COUNT(*) AS c FROM snapshots`).get() as {
      c: number
    }
    expect(snap.c).toBe(0)

    // But per-replica detail must be recorded for forensics.
    const replicaRows = dbHandle.db.db
      .prepare(`SELECT salt_fingerprint FROM replica_snapshots ORDER BY salt_fingerprint`)
      .all() as Array<{ salt_fingerprint: string }>
    expect(replicaRows).toHaveLength(2)
    expect(replicaRows.map((r) => r.salt_fingerprint)).toEqual([
      'aaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbb',
    ])
  })
})
