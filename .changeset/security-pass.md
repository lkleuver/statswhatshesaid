---
"statswhatshesaid": minor
---

Security hardening pass before the first public release.

**New `trustProxy` option** (default: `1`). Determines how many reverse-proxy hops to skip when resolving the client IP from `X-Forwarded-For`. The library now walks the XFF chain from the RIGHT (instead of blindly taking the leftmost entry), which defeats the standard client-side XFF spoofing attack when at least one trusted proxy sits in front of the process. Set to `0` to ignore forwarding headers entirely, or to `N > 1` for chained proxies (e.g. Cloudflare → nginx → app = `2`). Configurable via `STATS_TRUST_PROXY` env var. See the README Security section for recipes.

**`/stats` now accepts `Authorization: Bearer <token>`** in addition to the `?t=<token>` query string. The header is preferred in production because it does not leak into access logs, browser history, or Referer headers. If both are provided, the header wins.

**Weak-token warning.** The library emits a one-time `console.warn` at init time if the token is shorter than 32 characters, with guidance to run `openssl rand -hex 32`. The library does NOT reject short tokens — you may deliberately pick a memorable one for ad-hoc browser access.

**Snapshot file is now written with mode `0o600`** (owner read/write only). The snapshot contains the current day's visitor-hashing salt and should not be world-readable.

**User-Agent truncation.** Incoming `User-Agent` headers are truncated to 512 bytes before hashing and bot filtering, bounding per-request CPU cost regardless of the upstream header-size limit.

**Constant-time token comparison.** Token validation now prehashes both sides with SHA-256 before `timingSafeEqual`, so the comparison no longer branches on token length.

**Process signal handler leak fix.** `shutdown()` now calls `process.removeListener` for its own handlers, fixing a `MaxListenersExceededWarning` that appeared when many init/shutdown cycles ran in the same process (e.g. dev-mode HMR, test suites).

**README: new Security section** covering the threat model, `trustProxy` semantics with nginx/Caddy/Cloudflare recipes, token handling, flooding limitations, snapshot file contents, and privacy properties.
