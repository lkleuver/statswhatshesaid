# statswhatshesaid

A super minimal **one-line** drop-in stats library for Next.js. One metric, one line of integration, **zero runtime dependencies**, in-memory only, runs in **both** the Edge and Node runtimes.

- Tracks **unique visitors per day** — that's it.
- No tracking pixel, no client JS, no cookies.
- **Zero dependencies.** No native modules, no filesystem, no SQLite, no Docker volume gymnastics.
- **Works anywhere.** Edge runtime, Node runtime, Vercel, self-hosted, Docker, scratch images. The library uses only Web APIs (`crypto.subtle`, `crypto.getRandomValues`, `globalThis.fetch`).
- Read your stats by visiting `myapp.com/stats?t=<your-secret>` — JSON response.

> **Designed for freshly launched apps.** Counts and history live in process memory. They survive across requests within a single worker but reset on every deploy / restart — unless you opt into the [persistence callback](#persistence-optional). That's the trade-off for "drop in and forget." Once your traffic warrants real analytics, graduate to Plausible / Umami / PostHog.

## Install

```bash
npm install statswhatshesaid
```

## Use it

**One line.** That's it.

```ts
// middleware.ts
export { default } from 'statswhatshesaid'
```

Set your secret:

```bash
STATS_TOKEN=pick-a-long-random-string
```

Then visit:

```
https://myapp.com/stats?t=pick-a-long-random-string
```

You'll get JSON back:

```json
{
  "today": { "date": "2026-04-07", "uniqueVisitors": 412 },
  "history": [
    { "date": "2026-04-06", "uniqueVisitors": 388 },
    { "date": "2026-04-05", "uniqueVisitors": 401 }
  ],
  "generatedAt": "2026-04-07T14:23:10.000Z"
}
```

That's the whole library. No `runtime: 'nodejs'` config, no `matcher`, no `experimental`, no `next.config` flags. Just one re-export line.

## Customizing options

If you need to change defaults — bot filter, endpoint path, history retention, trustProxy hops — import `createMiddleware` instead:

```ts
// middleware.ts
import { createMiddleware } from 'statswhatshesaid'

export default createMiddleware({
  endpointPath: '/_internal/stats',
  filterBots: false,
  trustProxy: 2,
})
```

You can also set a custom `matcher` if you want the middleware to run on a narrower path set than "everything":

```ts
import { createMiddleware } from 'statswhatshesaid'

export default createMiddleware()

export const config = {
  matcher: ['/((?!api).*)'],
}
```

## How a "unique visitor" is counted

Cookieless, Plausible-style:

```
visitorHash = SHA-256( length-prefixed( ip ) + length-prefixed( userAgent ) + dailySalt )
```

- `dailySalt` is generated in process memory at startup and rotated lazily at every UTC midnight.
- The hash is fed into a [**HyperLogLog** sketch](https://en.wikipedia.org/wiki/HyperLogLog) with 16384 one-byte registers (16 KB fixed per day, forever).
- At UTC midnight the day's estimate is moved to an in-memory historical map and the sketch is reset with a fresh salt.
- Cross-day unlinkability: because the salt is regenerated, hashes from different days can't be correlated back to the same visitor.
- The hash inputs are length-prefixed so two distinct `(ip, ua)` pairs can never collide via separator ambiguity.
- Common bot User-Agents are filtered out by default.
- Common static asset paths (`/_next/static/*`, `/_next/image/*`, `/favicon.ico`, `/robots.txt`, `/sitemap.xml`, `/manifest.json`, etc.) are filtered out before tracking, so you don't need a custom `matcher`.

### About accuracy

HyperLogLog **estimates** cardinality — it doesn't count exactly. The expected standard error at `p=14` is **~0.8%**. If you had 1,000 true unique visitors, `/stats` will say somewhere in the range of ~992–1008. For a "how are we doing?" dashboard this is fine; it's what Plausible, Redis `PFCOUNT`, and BigQuery's `APPROX_COUNT_DISTINCT` use under the hood.

If you need exact counts down to the last human, don't use this library — graduate to a real analytics suite.

## Storage

**None by default.** Counts and history live in module-level memory inside whichever Next.js worker is running your middleware.

- ✅ State **survives across requests** within a single worker / Edge isolate (which is what makes the counter actually count).
- ❌ State is **lost on every deploy**, process restart, or worker recycle — unless you opt into [Persistence](#persistence-optional) below.
- ❌ State is **per-instance**: if you're running multiple replicas behind a load balancer, each replica has its own counter and they don't sync. Run a single instance, or use a real analytics tool.

This is intentional. The library exists to give freshly launched apps an "is anybody home?" signal in 30 seconds with zero infrastructure. If frequent deploys are costing you today's numbers on a single instance, the opt-in [persistence callback](#persistence-optional) plugs that gap; replication across replicas is a different problem class — graduate when you need it.

## Persistence (optional)

By default there's no storage — counts reset on every deploy. If you run a
**single long-running instance** (`next start` on a VPS / Fly / Railway /
Docker) you can opt in to persistence so today's live count and history
survive restarts. Provide two async callbacks; the library hands you an opaque
JSON snapshot to store and read back. Your database driver stays in your app —
the library remains zero-dependency.

```ts
// middleware.ts
import { createMiddleware } from 'statswhatshesaid'
import { pool } from './db' // your existing pg Pool

export default createMiddleware({
  persistence: {
    load: async () => {
      const { rows } = await pool.query(
        'select snapshot from stats_snapshot where id = 1',
      )
      return rows[0]?.snapshot ?? null
    },
    save: async (snapshot) => {
      await pool.query(
        `insert into stats_snapshot (id, snapshot) values (1, $1)
         on conflict (id) do update set snapshot = $1`,
        [snapshot],
      )
    },
  },
})
```

One-time table:

```sql
create table stats_snapshot (id int primary key, snapshot jsonb not null);
```

**How it works.** On the first request the library calls `load()` once and
restores the in-memory sketch — resuming today if the snapshot is from today,
or finalizing it into history if a day has passed. After each tracked request
it calls `save()` at most once per `persistSaveDebounceMs` (default 30000),
plus immediately when the UTC day rolls over. Saves are fire-and-forget and
never block or fail a request; a failing `load()` at boot just starts fresh.

**Single instance only.** The snapshot is a single read-modify-write row. With
multiple replicas they'd clobber each other — for multi-replica consolidation
use shared-salt mode plus the [collector](../collector) instead.

**Privacy note.** The snapshot includes today's HLL salt (already in process
memory) so the sketch can resume correctly. It rotates daily and never links
across days, but anyone who can read this row *and* your request logs could in
principle rederive today's `(ip, ua)` hashes — the same trust surface as
database access generally.

| Option | Default |
| --- | --- |
| `persistence` | unset (no persistence) |
| `persistSaveDebounceMs` | `30000` |

## Configuration

Configure via env vars (preferred for `STATS_TOKEN`) or by passing options to `createMiddleware({...})`. Options override env.

| Option | Env var | Default |
| --- | --- | --- |
| `token` | `STATS_TOKEN` | **required** |
| `endpointPath` | `STATS_ENDPOINT_PATH` | `/stats` |
| `historyDays` | — | `90` (returned from `/stats`) |
| `maxHistoryDays` | — | `365` (kept in memory) |
| `filterBots` | — | `true` |
| `trustProxy` | `STATS_TRUST_PROXY` | `1` (see [Security](#security) below) |
| `saltSecret` | `STATS_SALT_SECRET` | unset (see [Multi-replica deployments](#multi-replica-deployments) below) |
| `persistence` | — | unset |
| `persistSaveDebounceMs` | — | `30000` |

## Multi-replica deployments

The default in-memory design is single-instance: each Next.js worker has its own HyperLogLog sketch. If you run multiple replicas, each replica counts the visitors it serves, with no awareness of the others — visitor numbers across `/stats` will differ from replica to replica.

If you want a single consolidated number across replicas, you can opt in to **shared-salt mode** and pair it with an external collector that merges sketches:

1. Set `STATS_SALT_SECRET` (any long random string — `openssl rand -hex 32`) to the **same value** on every replica. The daily HLL salt then becomes `HMAC-SHA-256(saltSecret, utcDate)` — deterministic across replicas, still rotating daily, so cross-day unlinkability is preserved.
2. Run [`statswhatshesaid-collector`](../collector) — an external CLI — on a machine you control. Configure it with the per-replica URLs and the `STATS_TOKEN`. The collector polls `/stats?format=raw` from each replica, fetches the raw HLL register array plus a salt fingerprint, verifies the fingerprints match, merges the sketches register-wise (element-wise max), and stores the merged daily number in a local SQLite database.

If you don't set `STATS_SALT_SECRET`, the library behaves exactly as before — random per-process salts, `/stats?format=raw` simply ignored — and you can run a single-replica deployment without any of this.

## Security

This is a minimal library, but it runs inside your app's request path, so its defaults matter. Read this section before deploying.

### Threat model

- **In scope:** preventing trivial forging of visitor counts, protecting the `/stats` endpoint from unauthorized reads, keeping the process alive under abuse, making visitor hashes cross-day unlinkable.
- **Out of scope:** preventing a determined attacker with unlimited resources from skewing the numbers. statswhatshesaid is for day-one visibility on small apps. Once your traffic is big enough that someone would bother flooding your stats, you should be on Plausible / Umami / PostHog anyway.

### 1. `trustProxy` — who decides the client IP?

Unique-visitor dedup hashes the client IP alongside the User-Agent. If the attacker controls the IP you hash with, they control the count.

`X-Forwarded-For` is a list of IPs separated by commas. Each reverse proxy in the chain **appends** the IP of *its own peer*. The *leftmost* entry is whatever the original client claimed — i.e. attacker-controlled. The *rightmost N entries* are what trusted proxies added, so they're authentic. To pick the real client IP safely you must **walk the chain from the right, skipping one entry per trusted proxy**.

- `trustProxy: 0` — Never read forwarding headers. Every request hashes to a single constant peer. `uniqueVisitors` will under-count, but **nothing an attacker sends can forge it**.
- `trustProxy: 1` **(default)** — One trusted reverse proxy in front of this process (`client → nginx → next`). Library takes the **rightmost** entry of `X-Forwarded-For`.
- `trustProxy: 2` — Two trusted hops (`client → Cloudflare → nginx → next`). Library takes the **second-from-right** entry.
- `trustProxy: N` — Generalizes to N trusted hops.

**nginx recipe (trustProxy = 1):**

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header Host $host;
}
```

`$proxy_add_x_forwarded_for` appends the client's socket IP to whatever XFF the client sent. With `trustProxy: 1`, statswhatshesaid takes the rightmost entry (nginx's appended value), and the client's spoofed values sit uselessly to the left.

**Direct-exposed (no proxy) warning:** If you're running Next.js straight on `0.0.0.0:3000` with no proxy in front, **any header you see is attacker-controlled**. Set `trustProxy: 0` and accept that visitor dedup won't work, OR put any reverse proxy in front.

### 2. Token strength and rate limiting

`/stats` is protected by a single static token. A short token is brute-forceable.

- statswhatshesaid **warns** at startup if your token is shorter than 32 characters. It does not reject — you might pick a memorable token for ad-hoc browser access.
- A safer choice: `openssl rand -hex 32` → a 64-char hex string.
- The library does **not** rate-limit `/stats`. That's your CDN / reverse-proxy / application middleware's job ([nginx `limit_req`](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html), [Cloudflare rate limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/), [`@upstash/ratelimit`](https://github.com/upstash/ratelimit-js)).

### 3. Passing the token: `Authorization` header vs query string

Two ways to pass the token:

| Method | Use when |
| --- | --- |
| `Authorization: Bearer <token>` header | **Production** — doesn't leak to access logs, browser history, or Referer |
| `?t=<token>` query string | Ad-hoc browser checks |

Both are accepted. If both are present, the `Authorization` header wins.

```bash
curl -H "Authorization: Bearer $STATS_TOKEN" https://myapp.com/stats
```

### 4. Count inflation by flooding

An attacker who can send arbitrary `(IP, User-Agent)` pairs can insert arbitrarily many distinct "visitors" into the HLL sketch. Memory doesn't blow up (HLL is fixed 16 KB/day), but the reported count becomes meaningless during the attack. The library can't prevent this at the middleware layer — rate-limit at your CDN / reverse proxy.

### 5. Privacy properties

- **Cookieless.** The library never sets or reads cookies.
- **No personal data persisted by default.** Hashes go into the HLL (which discards them) and are never written anywhere. If you enable [Persistence](#persistence-optional), the library hands your callback an opaque snapshot — today's salt plus the HLL registers (no recoverable `(ip, ua)` hashes) plus daily counts — to store; see that section's privacy note for the trade-off.
- **Cross-day unlinkability.** The salt rotates at every UTC midnight. Yesterday's hash of `(ip, ua)` is unrelated to today's hash of the same tuple.
- **No telemetry.** The library itself makes zero outbound network requests. (An opt-in persistence callback, if you add one, runs *your* code — e.g. a database write.)

### 6. User-Agent length cap

Incoming User-Agent headers are truncated to **512 bytes** before hashing and bot-filter checks. Bounds per-request CPU regardless of upstream limits.

## Where it works

- ✅ **Self-hosted Next.js** (`next start` on a VPS, Docker, Fly.io, Railway, etc.) — single instance.
- ✅ **Vercel** and other serverless platforms — works in Edge middleware. Counts persist for the lifetime of each isolate; expect them to reset more often than on a long-running self-hosted process.
- ❌ **Multi-instance deployments** — each replica has its own in-memory counter and they don't sync. The library is single-process by design.

## Escape hatch (non-middleware integration)

If you need to call from a route handler or `instrumentation.ts`:

```ts
import { trackRequest } from 'statswhatshesaid'
import type { NextRequest } from 'next/server'

export async function GET(req: NextRequest) {
  await trackRequest(req)
  return new Response('ok')
}
```

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
# or, all at once:
npm run verify
```

The example app under `examples/basic` is the simplest way to smoke-test changes end-to-end.

## Releasing

Versioning and publishing are managed with [Changesets](https://github.com/changesets/changesets) and automated via the GitHub Actions Release workflow using **npm trusted publishing** (OIDC). No long-lived npm tokens live in the repo.

**Day-to-day flow:**

1. Make your changes on a branch and open a PR.
2. Add a changeset describing what changed:
   ```bash
   npx changeset
   ```
3. Merge the PR into `main`. The Release workflow opens (or updates) a "chore(release): version packages" PR that bumps `package.json` and updates `CHANGELOG.md`.
4. When you merge the release PR, the workflow publishes the new version to npm with provenance attached.

## License

MIT
