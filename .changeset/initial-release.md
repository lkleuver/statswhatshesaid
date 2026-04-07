---
"statswhatshesaid": minor
---

Initial release of `statswhatshesaid` — a super minimal drop-in unique-visitors-per-day stats library for self-hosted Next.js.

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
