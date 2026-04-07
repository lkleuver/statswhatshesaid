---
"statswhatshesaid": minor
---

**One-line drop-in.** statswhatshesaid is now truly one line:

```ts
// middleware.ts
export { default } from 'statswhatshesaid'
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
  import { createMiddleware } from 'statswhatshesaid'
  export default createMiddleware({ filterBots: false })
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
