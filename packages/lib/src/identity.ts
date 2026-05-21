/**
 * Stateless identity helpers, runtime-agnostic.
 *
 * All crypto here uses the Web Crypto API (`globalThis.crypto.subtle` and
 * `globalThis.crypto.getRandomValues`) so the library can run in both the
 * Next.js Edge runtime and the Node runtime without any conditional code.
 *
 * Web Crypto's `subtle.digest` is async, which makes `computeVisitorHash`
 * async, which in turn makes the middleware hot path async. Next.js
 * supports async middleware natively.
 */

export function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * True iff `s` is a real UTC calendar date in `YYYY-MM-DD` form. Rejects
 * structurally-valid but calendrically-impossible dates like `2026-02-30`
 * by round-tripping through `Date.UTC`.
 */
export function isValidUtcDate(s: string): boolean {
  const m = DATE_RE.exec(s)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const d = new Date(Date.UTC(year, month - 1, day))
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  )
}

/** Required number of bytes in a daily salt. */
export const SALT_BYTES = 32

export function generateSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_BYTES)
  globalThis.crypto.getRandomValues(salt)
  return salt
}

/** Peer identifier used when no trusted IP is available. */
export const UNKNOWN_PEER = '0.0.0.0'

/**
 * Resolve the client IP from the X-Forwarded-For chain, walking from the
 * RIGHT (server side) of the chain inward, skipping `trustProxy - 1` trusted
 * proxy hops. Returns the first "untrusted" entry as the client IP.
 *
 * Semantics:
 *   - `trustProxy === 0` — never read forwarding headers. All requests
 *     collapse to a single constant peer.
 *   - `trustProxy === N` — pick the Nth entry from the RIGHT of the XFF
 *     chain (1-indexed). If the chain is shorter than N, fall back to the
 *     constant peer.
 *
 * Examples with `trustProxy = 1` (default, single trusted proxy in front):
 *   XFF: "1.1.1.1"            →  "1.1.1.1"      (genuine)
 *   XFF: "9.9.9.9, 1.1.1.1"   →  "1.1.1.1"      (attacker forged 9.9.9.9)
 *   XFF: (absent)              →  "0.0.0.0"      (can't identify)
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
 * Hash a visitor tuple with the day's salt. Returns the 32-byte SHA-256
 * digest as a `Uint8Array`. The HLL only consumes the first 8 bytes.
 *
 * Length-prefixing: each variable-length component (ip, ua) is preceded by
 * its length as a 4-byte big-endian integer. This makes the pre-image
 * unambiguous — no two distinct `(ip, ua)` pairs can produce the same byte
 * sequence fed into SHA-256. A naive `ip + ":" + ua` encoding would allow
 * pairs like `("1::2", "foo")` and `("1", ":2:foo")` to collide because of
 * the embedded colons in IPv6 addresses.
 */
export async function computeVisitorHash(
  ip: string,
  ua: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const ipBuf = enc.encode(ip)
  const uaBuf = enc.encode(ua)

  // 8-byte length header (two big-endian u32s) + ipBuf + uaBuf + salt.
  const total = new Uint8Array(8 + ipBuf.length + uaBuf.length + salt.length)
  const dv = new DataView(total.buffer)
  dv.setUint32(0, ipBuf.length, false)
  dv.setUint32(4, uaBuf.length, false)
  total.set(ipBuf, 8)
  total.set(uaBuf, 8 + ipBuf.length)
  total.set(salt, 8 + ipBuf.length + uaBuf.length)

  const digest = await globalThis.crypto.subtle.digest('SHA-256', total)
  return new Uint8Array(digest)
}

/**
 * Constant-time string comparison via SHA-256 prehash. Both inputs are
 * hashed to fixed 32-byte buffers and then XOR-compared in constant time,
 * so neither the length nor the content of either input leaks via timing.
 */
export async function constantTimeStringEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [ah, bh] = await Promise.all([
    globalThis.crypto.subtle.digest('SHA-256', enc.encode(a)),
    globalThis.crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  const av = new Uint8Array(ah)
  const bv = new Uint8Array(bh)
  let diff = 0
  for (let i = 0; i < av.length; i++) {
    diff |= av[i]! ^ bv[i]!
  }
  return diff === 0
}

/**
 * Conservative list of paths the middleware should NOT track. Lets the user
 * skip the `matcher` config entirely. Only matches well-known static paths,
 * never extension-based, to avoid false positives on routes like
 * `/api/data.json`.
 */
export function isStaticPath(pathname: string): boolean {
  if (pathname.startsWith('/_next/')) return true
  // Common well-known files at the root.
  switch (pathname) {
    case '/favicon.ico':
    case '/favicon.svg':
    case '/robots.txt':
    case '/sitemap.xml':
    case '/manifest.json':
    case '/site.webmanifest':
    case '/apple-touch-icon.png':
    case '/apple-touch-icon-precomposed.png':
      return true
    default:
      return false
  }
}
