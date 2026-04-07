import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { HLL_REGISTER_COUNT } from './hll.js'

/**
 * Versioned on-disk representation of the entire store.
 *
 * Size budget (base64-encoded):
 *   - salt: 32 B → ~44 chars
 *   - hllRegisters: 16 KB → ~22 KB of base64
 *   - history: ~20 B per day
 *
 * Entire file stays ≤ ~30 KB even after years of operation.
 */
export interface SnapshotV1 {
  version: 1
  /** UTC date (YYYY-MM-DD) that the HLL registers currently belong to. */
  today: string
  /** Base64-encoded 32-byte daily salt. Rotated at UTC midnight. */
  salt: string
  /** Base64-encoded 16384-byte HLL register array. */
  hllRegisters: string
  /** Finalized historical daily counts, keyed by UTC date. */
  history: Record<string, number>
}

/**
 * Pluggable persistence. Synchronous on purpose: the default file adapter
 * is sync (so it can run in the SIGTERM shutdown path), and the data is
 * small enough that any reasonable backend can be wrapped synchronously.
 *
 * If you need to hand this off to an async store (Redis, KV, S3), wrap your
 * client in a thin adapter that blocks during load at startup and best-effort
 * fires-and-forgets during save. For most self-hosted use cases the default
 * file adapter is what you want.
 */
export interface PersistAdapter {
  load(): SnapshotV1 | null
  save(snap: SnapshotV1): void
}

/** Atomic-rename JSON file adapter. Zero dependencies. */
export class FileSnapshotAdapter implements PersistAdapter {
  private readonly path: string

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
  }

  load(): SnapshotV1 | null {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // Corrupt file — treat as no snapshot. Caller will create a fresh one
      // and overwrite on the next flush.
      return null
    }

    if (!isValidSnapshot(parsed)) return null
    return parsed
  }

  save(snap: SnapshotV1): void {
    const tmp = `${this.path}.tmp`
    // mode 0o600 so the snapshot (which contains the current day's salt
    // — a secret that would make hashes linkable back to their source
    // tuples) is not world-readable. The file is rename-replaced on
    // every flush, so the mode needs to be set on each write.
    writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 })
    renameSync(tmp, this.path)
  }
}

function isValidSnapshot(x: unknown): x is SnapshotV1 {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  if (o.version !== 1) return false
  if (typeof o.today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.today)) return false
  if (typeof o.salt !== 'string') return false
  if (typeof o.hllRegisters !== 'string') return false
  if (typeof o.history !== 'object' || o.history === null) return false

  // Sanity-check the register array length (base64 → 16384 bytes → 21848 chars).
  const expectedBase64 = Math.ceil(HLL_REGISTER_COUNT / 3) * 4
  if (o.hllRegisters.length !== expectedBase64) return false

  return true
}
