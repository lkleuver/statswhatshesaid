import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CollectorDb } from '../src/db.js'
import { runServe } from '../src/serve-cmd.js'

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

describe('runServe', () => {
  let dbPath: string

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'swhsd-serve-cmd-'))
    dbPath = join(dir, 'c.db')
  })

  it('returns 0 after the abort signal fires; logs the listening URL', async () => {
    CollectorDb.open(dbPath).close()
    const { io, stderr } = makeIo()
    const controller = new AbortController()

    const pending = runServe(
      { dbPath, host: '127.0.0.1', port: 0, signal: controller.signal },
      io,
    )

    for (let i = 0; i < 50 && !stderr.text.includes('Listening'); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(stderr.text).toMatch(/Listening on http:\/\/127\.0\.0\.1:\d+/)

    controller.abort()
    const code = await pending
    expect(code).toBe(0)
  })

  it('returns 3 when the DB file does not exist', async () => {
    const { io, stderr } = makeIo()
    const code = await runServe(
      { dbPath: join(dbPath, 'missing.db'), host: '127.0.0.1', port: 0 },
      io,
    )
    expect(code).toBe(3)
    expect(stderr.text).toMatch(/missing\.db|unable to open/i)
  })
})
