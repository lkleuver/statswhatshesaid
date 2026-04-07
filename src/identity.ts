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

export function extractIp(headers: Headers, fallbackIp?: string): string {
  const xff = headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]
    if (first && first.trim()) return first.trim()
  }
  const real = headers.get('x-real-ip')
  if (real && real.trim()) return real.trim()
  return fallbackIp ?? '0.0.0.0'
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
