import { createHash, randomBytes } from 'node:crypto'

/**
 * Stateless identity helpers. Salt lifetime is owned by the runtime in
 * `lifecycle.ts` so it can be persisted in the snapshot file and swapped
 * atomically at the UTC-midnight rollover.
 */

export function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function generateSalt(): Buffer {
  return randomBytes(32)
}

/** Peer identifier used when no trusted IP is available. */
export const UNKNOWN_PEER = '0.0.0.0'

/**
 * Resolve the client IP from the X-Forwarded-For chain, walking from the
 * RIGHT (server side) of the chain inward, skipping `trustProxy - 1` trusted
 * proxy hops. Returns the first "untrusted" entry as the client IP.
 *
 * This is the only safe way to consume XFF: the leftmost entry in the chain
 * is whatever the client sent originally, which is attacker-controlled
 * unless every proxy in front explicitly strips incoming XFF headers.
 *
 * Semantics:
 *   - `trustProxy === 0` — never read forwarding headers. All requests
 *     collapse to a single constant peer. Safest but breaks visitor
 *     counting when the process is behind any kind of proxy.
 *   - `trustProxy === N` — pick the Nth entry from the RIGHT of the XFF
 *     chain (1-indexed). If the chain is shorter than N, fall back to the
 *     constant peer (we can't safely identify the client).
 *
 * Examples with `trustProxy = 1` (default, single trusted proxy in front):
 *   XFF: "1.1.1.1"            →  "1.1.1.1"      (genuine)
 *   XFF: "9.9.9.9, 1.1.1.1"   →  "1.1.1.1"      (attacker forged 9.9.9.9)
 *   XFF: (absent)              →  "0.0.0.0"      (can't identify)
 *
 * With `trustProxy = 2` (e.g. Cloudflare → nginx → app):
 *   XFF: "1.1.1.1, 2.2.2.2"            →  "1.1.1.1"
 *   XFF: "9.9.9.9, 1.1.1.1, 2.2.2.2"   →  "1.1.1.1"
 */
export function extractIp(headers: Headers, trustProxy: number): string {
  if (trustProxy < 1) return UNKNOWN_PEER

  const xff = headers.get('x-forwarded-for')
  if (!xff) return UNKNOWN_PEER

  const entries = xff
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (entries.length < trustProxy) return UNKNOWN_PEER

  // Nth-from-right, 1-indexed. trustProxy=1 → entries[length-1], etc.
  return entries[entries.length - trustProxy]!
}

/**
 * Hash a visitor tuple with the day's salt. Returns the full 32-byte SHA-256
 * digest; callers that only need 64 bits (the HLL) can slice.
 */
export function computeVisitorHash(ip: string, ua: string, salt: Buffer): Buffer {
  return createHash('sha256')
    .update(ip)
    .update(':')
    .update(ua)
    .update(':')
    .update(salt)
    .digest()
}

/**
 * Schedule a one-shot timer for the next UTC midnight (+1s buffer), which on
 * fire chains itself via setInterval every 24h. Returns a cancel function.
 * Callers are responsible for deciding what to do on the rollover — this
 * module doesn't own any state.
 */
export function scheduleMidnightTimer(
  onMidnight: () => void,
  now: Date = new Date(),
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let interval: ReturnType<typeof setInterval> | null = null

  const msUntilNext = msUntilUtcMidnight(now) + 1000

  timer = setTimeout(() => {
    try {
      onMidnight()
    } catch {
      /* never propagate out of a timer callback */
    }
    interval = setInterval(
      () => {
        try {
          onMidnight()
        } catch {
          /* swallow */
        }
      },
      24 * 60 * 60 * 1000,
    )
    interval.unref?.()
  }, msUntilNext)
  timer.unref?.()

  return () => {
    if (timer) clearTimeout(timer)
    if (interval) clearInterval(interval)
    timer = null
    interval = null
  }
}

function msUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  )
  return next - now.getTime()
}
