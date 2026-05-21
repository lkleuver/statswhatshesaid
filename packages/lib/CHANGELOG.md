# statswhatshesaid

## 0.2.0

### Minor Changes

- c5437a3: **One-line drop-in.** statswhatshesaid is now truly one line:

  ```ts
  // middleware.ts
  export { default } from "statswhatshesaid";
  ```

  No `runtime: 'nodejs'` config, no `matcher`, no `experimental` flags, no Next.js 15.2+ requirement. It just works.

  ## Breaking changes

  This is a major architectural change disguised as a `minor` bump because we're still in `0.x`. The headline change: **all persistence is gone**. Counts and history live in process memory only and reset on every restart. This is intentional — see "Why" below.

  - **Removed** `node:fs` entirely. No more snapshot file. No more `.statswhatshesaid.json`. No more atomic-rename writes.
  - **Removed** `node:crypto`. All hashing now uses Web Crypto (`crypto.subtle.digest`, `crypto.getRandomValues`).
  - **Removed** the `runtime: 'nodejs'` middleware-config requirement. The library runs in **both** Edge and Node runtimes since it only uses Web APIs.
  - **Removed** the `PersistAdapter` interface, `FileSnapshotAdapter`, `SnapshotV1` type, and the `persist`, `snapshotPath`, `flushIntervalMs` options.
  - **Removed** `process.on('SIGTERM' | 'SIGINT' | 'beforeExit')` handlers. There's nothing to flush.
  - **Removed** the periodic flush timer.
  - **Removed** the Node-runtime guard (`assertNodeRuntime`). The library no longer cares which runtime you use.
  - **Lowered** the Next.js peer dependency from `>=15.2.0` to `>=13.0.0`.
  - **Default export** of the main package is now a pre-instantiated middleware function (was previously the `stats` object). To customize options, import `createMiddleware`:
    ```ts
    import { createMiddleware } from "statswhatshesaid";
    export default createMiddleware({ filterBots: false });
    ```
  - **`createMiddleware` now returns an `async` function** since `crypto.subtle.digest` is async. Next.js middleware natively supports async.
  - **`trackRequest` is now async** for the same reason.

  ## New features

  - **Self-filters common static paths** before tracking (`/_next/static/*`, `/_next/image/*`, `/favicon.ico`, `/robots.txt`, `/sitemap.xml`, `/manifest.json`, etc.) so users don't need a custom `matcher` to skip static assets.
  - **One-line integration**: `export { default } from 'statswhatshesaid'` is the entire `middleware.ts`.

  ## Why (the short version)

  The previous version's promise of "drop in" was undermined by the four lines of `export const config = { matcher, runtime: 'nodejs' }` boilerplate users had to write, plus the Next.js 15.2+ requirement and the directory of snapshot/WAL/SHM-equivalent file artifacts. The user explicitly wanted a true drop-in for monitoring freshly launched apps and accepted the trade-off of in-memory-only state.

  Edge runtime is now a first-class target. You can deploy this on Vercel Edge Middleware, on a Docker scratch image, on Cloudflare Pages — anywhere modern JS runs.

  ## Bundle size

  ESM bundle: 18.7 KB → **12.2 KB** (smaller because `snapshot.ts`, `FileSnapshotAdapter`, the persist abstraction, and the lifecycle plumbing are all gone).

  ## Tests

  89 unit and integration tests, all passing. The 5-test snapshot suite was deleted along with the file adapter. Persistence-restart and corruption-recovery tests were dropped (no persistence to test). New tests cover the static-path filter, the Web Crypto hash path, and the async constant-time compare.

  End-to-end smoke tested via the `examples/basic` Next.js app: 2 distinct visitors counted, dedup correct, bot filtered, favicon skipped, both query and `Authorization` token paths working, wrong token rejected.

## 0.1.0

### Minor Changes

- 7880aa7: Initial release of `statswhatshesaid` — a super minimal drop-in unique-visitors-per-day stats library for self-hosted Next.js.

  **Features:**

  - One-line integration via Next.js middleware (`export default stats.middleware()`).
  - Single `/stats?t=<token>` endpoint returning JSON (today's estimate + history).
  - Cookieless visitor identification: `SHA-256(ip + ua + dailySalt)`, salt rotates at UTC midnight.
  - HyperLogLog (p=14) cardinality estimation — fixed 16 KB per day, ~0.8% standard error.
  - Single JSON snapshot file (~22 KB) with atomic `.tmp` + rename writes. Default `./.statswhatshesaid.json`.
  - Pluggable `PersistAdapter` for bring-your-own backends (Redis, KV, S3).
  - Edge-runtime guard with a clear, actionable error message.
  - **Zero runtime dependencies.** No native modules, no Docker volume gymnastics. Works on Alpine, slim, distroless.
  - Requires Next.js ≥ 15.2 for the `nodejs` middleware runtime.

- 3b295d6: Second-pass hardening found via a targeted re-audit. These fixes all sit inside the existing v0.1.0 window (still unreleased), so they roll into the first published release.

  **Length-prefixed visitor hash construction.** `computeVisitorHash` now prepends a big-endian length header for each variable-length component (ip, ua) before feeding them into SHA-256. The previous `ip + ":" + ua + ":" + salt` encoding was input-ambiguous: with IPv6 addresses containing colons, two distinct `(ip, ua)` pairs could produce the same pre-image and therefore the same hash. Length-prefixing makes the pre-image unambiguous.

  **Snapshot load is now crash-proof.** `VisitorStore.fromSnapshot` wraps both the same-day and cross-day branches in try/catch and degrades gracefully:

  - Decoded salt length is validated (must be exactly 32 bytes) before use.
  - Decoded HLL register length is validated (must be exactly `HLL_REGISTER_COUNT` bytes) before use. `Buffer.from(x, 'base64')` silently ignores malformed characters, so the base64 string-length check in `isValidSnapshot` alone was insufficient.
  - On any decode/validation failure, the store starts fresh for the current day rather than throwing out of init. Up to a few minutes of same-day dedupe state is lost; the process stays up.

  **Strict history validation.** `sanitizeHistory` drops any entry that isn't a real `YYYY-MM-DD` calendar date (validated via `Date.UTC` round-trip, rejecting `2026-02-30` and `2025-02-29`) mapped to a non-negative integer count. Entries for `currentDate` itself are dropped (today's count is owned by the live HLL). Protects against snapshot files poisoned by whoever has write access.

  **Snapshot validator rejects arrays.** `isValidSnapshot` now explicitly rejects arrays for the `history` field. Previously `typeof [] === 'object'` let arrays through, which would then be iterated with numeric-string keys.

  **Config sanity checks.** `resolveConfig` now validates:

  - `flushIntervalMs` must be a positive integer ≥ 1000 ms (prevents `setInterval(tick, 0)` hot loops from a bad config).
  - `historyDays` and `maxHistoryDays` must be non-negative integers.
  - `endpointPath` must match `^/[A-Za-z0-9\-._~/]*$` — no whitespace, CR/LF, or shell metacharacters.

  All throw loud, clear errors at config resolution time.

  **New `isValidUtcDate` helper.** Shared between snapshot validation and history sanitization. Rejects calendrically-impossible dates like `2026-02-30` via `Date.UTC` round-trip, not just via regex.

  **Tests.** 23 new hardening tests across four describe blocks covering the hash input-ambiguity fix, date validation, config validation, and graceful snapshot-load degradation. Total test count: 76 → 99, all green.

- 64b583f: Security hardening pass before the first public release.

  **New `trustProxy` option** (default: `1`). Determines how many reverse-proxy hops to skip when resolving the client IP from `X-Forwarded-For`. The library now walks the XFF chain from the RIGHT (instead of blindly taking the leftmost entry), which defeats the standard client-side XFF spoofing attack when at least one trusted proxy sits in front of the process. Set to `0` to ignore forwarding headers entirely, or to `N > 1` for chained proxies (e.g. Cloudflare → nginx → app = `2`). Configurable via `STATS_TRUST_PROXY` env var. See the README Security section for recipes.

  **`/stats` now accepts `Authorization: Bearer <token>`** in addition to the `?t=<token>` query string. The header is preferred in production because it does not leak into access logs, browser history, or Referer headers. If both are provided, the header wins.

  **Weak-token warning.** The library emits a one-time `console.warn` at init time if the token is shorter than 32 characters, with guidance to run `openssl rand -hex 32`. The library does NOT reject short tokens — you may deliberately pick a memorable one for ad-hoc browser access.

  **Snapshot file is now written with mode `0o600`** (owner read/write only). The snapshot contains the current day's visitor-hashing salt and should not be world-readable.

  **User-Agent truncation.** Incoming `User-Agent` headers are truncated to 512 bytes before hashing and bot filtering, bounding per-request CPU cost regardless of the upstream header-size limit.

  **Constant-time token comparison.** Token validation now prehashes both sides with SHA-256 before `timingSafeEqual`, so the comparison no longer branches on token length.

  **Process signal handler leak fix.** `shutdown()` now calls `process.removeListener` for its own handlers, fixing a `MaxListenersExceededWarning` that appeared when many init/shutdown cycles ran in the same process (e.g. dev-mode HMR, test suites).

  **README: new Security section** covering the threat model, `trustProxy` semantics with nginx/Caddy/Cloudflare recipes, token handling, flooding limitations, snapshot file contents, and privacy properties.
