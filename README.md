# statswhatshesaid

A super minimal drop-in stats library for **self-hosted Next.js**. One metric, one line of integration, **zero runtime dependencies**.

- Tracks **unique visitors per day** — that's it.
- No tracking pixel, no client JS, no cookies.
- **Zero dependencies.** No native modules, no SQLite, no Docker volume gymnastics.
- Single ~22KB JSON file for persistence. Atomic writes. Put it anywhere or nowhere.
- Read your stats by visiting `myapp.com/stats?t=<your-secret>` — JSON response.

> **Designed for freshly launched apps.** Once traffic gets serious you should graduate to a proper analytics suite (Plausible, Umami, PostHog, ...). This library is the thing you drop in on day one so you can tell whether anyone's visiting yet, with absolutely no setup ceremony.

## Install

```bash
npm install statswhatshesaid
```

## Use it

Add **one line** to your `middleware.ts`:

```ts
// middleware.ts
import stats from 'statswhatshesaid'

export default stats.middleware()

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
  runtime: 'nodejs', // REQUIRED — see "Why isn't this just one line?" below
}
```

Set your secret in the environment:

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

That's the whole library.

## Why isn't this just one line?

Honest answer: I tried, and Next.js won't let me. The minimum drop-in is a few lines because two independent constraints stack:

### 1. Next.js middleware needs the Node runtime, and that has to be declared inline

Next.js middleware defaults to the **Edge runtime**, which sandboxes away `node:fs` (no snapshot file) and gives you an async-only `crypto.subtle.digest` (which would force the hot path async). statswhatshesaid uses both, so the middleware has to opt into the Node runtime:

```ts
export const config = {
  runtime: 'nodejs', // requires Next.js 15.2+
}
```

I can't ship that line for you because of constraint #2.

### 2. Next.js's middleware build step ignores re-exported `config`

You might think the library could export a pre-baked `config` object you re-export from your `middleware.ts`:

```ts
// what I wish worked
export { default, config } from 'statswhatshesaid/middleware'
```

It doesn't. Next.js does **static AST analysis** of `middleware.ts` at build time and only recognizes a literal top-level `export const config = {...}` with an inline object expression. It can't resolve imported identifiers or follow re-exports. A Next.js maintainer explained in [vercel/next.js#70008](https://github.com/vercel/next.js/issues/70008): *"the extractor would need to resolve identifiers or follow re-exports. That requires symbol resolution (and potentially executing code), which the middleware/proxy config parser intentionally avoids."*

There's an open PR ([#90017](https://github.com/vercel/next.js/pull/90017)) that would fix this. Until it lands and ships in a stable Next, every middleware library in the ecosystem has to ask you to write the `config` block yourself. Clerk, next-intl, and the others all do the same.

### So what's the actual minimum?

Three lines + the import:

```ts
import stats from 'statswhatshesaid'
export default stats.middleware()
export const config = { runtime: 'nodejs' }
```

That's the floor today. If you also want a custom matcher (e.g. to skip your own static asset routes), the example at the top of this README shows how to set one.

When [vercel/next.js#90017](https://github.com/vercel/next.js/pull/90017) (or equivalent) ships, this README will be updated with a one-line form.

## How a "unique visitor" is counted

Cookieless, Plausible-style:

```
visitorHash = SHA-256( ip + ":" + userAgent + ":" + dailySalt )
```

- `dailySalt` is generated in process memory and rotates at every UTC midnight.
- The hash is fed into a [**HyperLogLog** sketch](https://en.wikipedia.org/wiki/HyperLogLog) with 16384 one-byte registers (16 KB fixed per day, forever).
- At UTC midnight the day's estimate is written to a historical map and the sketch is reset with a fresh salt.
- Cross-day unlinkability: because the salt is regenerated, hashes from different days can't be correlated back to the same visitor.
- Common bot User-Agents are filtered out by default.

### About accuracy

HyperLogLog **estimates** cardinality — it doesn't count exactly. The expected standard error at `p=14` is **~0.8%**. If you had 1,000 true unique visitors, `/stats` will say somewhere in the range of ~992–1008. For a "how are we doing?" dashboard this is fine; it's what Plausible, Redis `PFCOUNT`, and BigQuery's `APPROX_COUNT_DISTINCT` use under the hood.

If you need exact counts down to the last human, don't use this library — graduate to a real analytics suite.

## Storage

A single JSON file. Default location: `./.statswhatshesaid.json`.

```jsonc
{
  "version": 1,
  "today": "2026-04-07",
  "salt": "<base64 32 bytes>",
  "hllRegisters": "<base64 16 KB>",
  "history": { "2026-04-06": 388, "2026-04-05": 401 }
}
```

- **One file.** Not a directory, not a DB, no WAL/SHM sidecars.
- **~22 KB today + 20 bytes per historical day.** Never grows beyond a few hundred KB, ever.
- **Atomic writes** via write-to-`.tmp` + `rename`. Crash-safe.
- **Flushed every hour** (tunable) and on `SIGTERM`/`SIGINT`/`beforeExit`.
- **Nothing on the hot path touches disk.** Tracking a visit is: one SHA-256, one HLL register update. Sub-millisecond.

### Docker / containers

Because it's one small file, you have options:

```dockerfile
# Option A: persist it on a volume
VOLUME /data
ENV STATS_SNAPSHOT_PATH=/data/stats.json
```

```dockerfile
# Option B: bind-mount a single file from the host
# docker run -v $(pwd)/stats.json:/app/stats.json \
#            -e STATS_SNAPSHOT_PATH=/app/stats.json ...
```

```dockerfile
# Option C: accept ephemerality. Losing "today" on a redeploy is often fine
# for a small app. The snapshot is flushed on SIGTERM when Node is PID 1,
# so graceful stops keep the latest data.
ENV STATS_SNAPSHOT_PATH=/tmp/statswhatshesaid.json
```

Works fine on `node:20-alpine`, `node:20-slim`, distroless — there are no native modules to compile.

### Bring your own backend

If you want to stash the snapshot in Redis, Vercel KV, S3, or anything else, pass a `persist` adapter:

```ts
import stats from 'statswhatshesaid'
import type { PersistAdapter, SnapshotV1 } from 'statswhatshesaid'

const redisPersist: PersistAdapter = {
  load: () => {
    const raw = redisClient.get('statswhatshesaid:snap') // your sync/blocking client
    return raw ? (JSON.parse(raw) as SnapshotV1) : null
  },
  save: (snap) => {
    redisClient.set('statswhatshesaid:snap', JSON.stringify(snap))
  },
}

export default stats.middleware({ persist: redisPersist })
```

The adapter interface is synchronous on purpose so the shutdown handler can flush deterministically.

## Configuration

Configure via env vars (preferred) or by passing options to `stats.middleware({...})`. Options override env.

| Option | Env var | Default |
| --- | --- | --- |
| `token` | `STATS_TOKEN` | **required** |
| `snapshotPath` | `STATS_SNAPSHOT_PATH` | `./.statswhatshesaid.json` |
| `persist` | — | file adapter at `snapshotPath` |
| `flushIntervalMs` | `STATS_FLUSH_INTERVAL_MS` | `3600000` (1 hour) |
| `endpointPath` | `STATS_ENDPOINT_PATH` | `/stats` |
| `historyDays` | — | `90` (returned from `/stats`) |
| `maxHistoryDays` | — | `365` (kept in snapshot) |
| `filterBots` | — | `true` |
| `trustProxy` | `STATS_TRUST_PROXY` | `1` (see [Security](#security) below) |

```ts
export default stats.middleware({
  endpointPath: '/_internal/stats',
  flushIntervalMs: 5 * 60 * 1000,
  historyDays: 30,
  trustProxy: 1,
})
```

## Security

This is a minimal library, but it runs inside your app's request path and writes to your filesystem, so its defaults matter. Read this section before deploying.

### Threat model

- **In scope:** preventing trivial forging of visitor counts, protecting the `/stats` endpoint from unauthorized reads, keeping the process alive under abuse, making visitor hashes cross-day unlinkable.
- **Out of scope:** preventing a determined attacker with unlimited resources from skewing the numbers. statswhatshesaid is for day-one visibility on small, self-hosted apps. Once your traffic is big enough that someone would bother flooding your stats, you should be on Plausible / Umami / PostHog anyway.

### 1. `trustProxy` — who decides the client IP?

Unique-visitor dedup hashes the client IP alongside the User-Agent. If the attacker controls the IP you hash with, they control the count.

**The problem:** `X-Forwarded-For` is a list of IPs separated by commas. Each reverse proxy in the chain **appends** the IP of *its own peer* (the thing that spoke TCP to it). The *leftmost* entry is whatever the original client claimed — i.e. attacker-controlled. The *rightmost N entries* are what trusted proxies added, so they're authentic.

To pick the real client IP safely you must **walk the chain from the right, skipping one entry per trusted proxy**.

**Configuration:**

- `trustProxy: 0` — Never read forwarding headers. Every request hashes to a single constant peer. `uniqueVisitors` will under-count dramatically (ideally it collapses to 1), but **nothing an attacker sends can forge it**. Use this only if (a) your process is directly exposed to untrusted clients, or (b) you're OK with a "did anybody visit today?" binary signal.

- `trustProxy: 1` **(default)** — One trusted reverse proxy sits in front of this Node process. The library takes the **rightmost** entry of `X-Forwarded-For`. This is correct for the single most common self-hosted shape: `client → nginx → next`, or `client → Caddy → next`, or `client → Traefik → next`.

- `trustProxy: 2` — Two trusted hops. The library takes the **second-from-right** entry of `X-Forwarded-For`. Use this for setups like `client → Cloudflare → nginx → next` where Cloudflare is ALSO adding to XFF.

- `trustProxy: N` — Generalizes to N trusted hops.

**nginx recipe (trustProxy = 1):**

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header Host $host;
}
```

`$proxy_add_x_forwarded_for` appends the client's socket IP to whatever XFF the client sent. With `trustProxy: 1`, statswhatshesaid ignores whatever the client sent and takes the rightmost entry (which is what nginx appended). The client's spoofed values sit uselessly to the left.

**Caddy recipe (trustProxy = 1):**

```caddyfile
example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Caddy automatically appends the client IP to `X-Forwarded-For` by default.

**Cloudflare + nginx recipe (trustProxy = 2):**

```nginx
# nginx behind Cloudflare
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

With `trustProxy: 2`, the second-from-right entry is the real client: `attacker-spoof, real-client, cloudflare-edge`.

**Direct-exposed (no proxy) warning:** If you're running `next start` straight on `0.0.0.0:3000` with no proxy, **any header you see is attacker-controlled**. Set `trustProxy: 0` and accept that visitor dedup won't work, OR put any reverse proxy in front.

### 2. Token strength and rate limiting

`/stats` is protected by a single static token. A short token is brute-forceable if an attacker hammers the endpoint.

- statswhatshesaid **warns** at startup if your token is shorter than 32 characters. It does not reject — you might deliberately pick a memorable token for ad-hoc browser access from anywhere.
- A safer choice: `openssl rand -hex 32` → a 64-char hex string.
- The library does **not** rate-limit `/stats`. That's your CDN / reverse-proxy / application middleware's job. For nginx: [`limit_req`](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html). For Cloudflare: [rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/). For Next.js middleware chains: [`@upstash/ratelimit`](https://github.com/upstash/ratelimit-js).

### 3. Passing the token: `Authorization` header vs query string

You can pass the token two ways:

| Method | Use when |
| --- | --- |
| `Authorization: Bearer <token>` header | **Production** — doesn't leak to access logs, browser history, or Referer |
| `?t=<token>` query string | Ad-hoc browser checks where typing a header is annoying |

Both are accepted. If both are present, the `Authorization` header wins. Example production check:

```bash
curl -H "Authorization: Bearer $STATS_TOKEN" https://myapp.com/stats
```

The query string is convenient but ends up in **nginx/CDN access logs, browser history, and Referer headers**. Don't link to `/stats?t=...` from any page.

### 4. Count inflation by flooding

An attacker who can send arbitrary (IP, User-Agent) pairs — even behind a correctly configured `trustProxy` — can insert arbitrarily many distinct "visitors" into the HLL sketch. Memory doesn't blow up (HLL is fixed 16 KB/day), but the reported `uniqueVisitors` becomes meaningless during the attack. The library cannot prevent this at the middleware layer. **Defense:** rate-limit tracked routes at the same layer that protects the rest of your app. Don't treat the number as authoritative during a suspected abuse event.

### 5. Snapshot file permissions and contents

- The snapshot file is written with mode `0o600` (owner read/write only). It contains the current day's salt, which would make visitor hashes linkable back to their `(ip, ua)` tuples if disclosed alongside an independent request log.
- Write is atomic via `.tmp` + `rename`. A crash mid-write leaves the previous snapshot intact.
- The snapshot file contains **no personal data** — just the HLL registers, the salt, and per-day visitor counts. No IPs or User-Agents are stored.

### 6. User-Agent length cap

Incoming User-Agent headers are truncated to **512 bytes** before hashing and bot-filter checks. Node already caps total header size at ~16 KB, but this bounds per-request CPU regardless.

### 7. Privacy properties

- **Cookieless.** The library never sets or reads cookies.
- **No personal data persisted.** Hashes go into the HLL (which discards them) and are never written to disk.
- **Cross-day unlinkability.** The salt rotates at every UTC midnight. Yesterday's hash of `(ip, ua)` is unrelated to today's hash of the same tuple.
- **Mid-day restart caveat.** If the process restarts within the same UTC day, the restored salt (from the snapshot file) is the same, so the same visitor returning after the restart doesn't get double-counted. This means the salt IS on disk for the current day. Rotate `STATS_TOKEN` and delete the snapshot file if you think the file was exposed.

## Where it works

- ✅ **Self-hosted Next.js** — `next start` on a VPS, Docker, Fly.io, Railway, etc. Single long-running Node process.
- ❌ **Vercel / Netlify / serverless by default** — ephemeral filesystem and per-request lambdas mean the in-memory HLL doesn't survive. You *could* make this work with a custom `persist` adapter pointing at Vercel KV or Upstash Redis, but at that point you're probably better off with a hosted analytics service.

## Escape hatch (non-middleware integration)

If you can't use `runtime: 'nodejs'` in middleware, call the tracker manually from a route handler or `instrumentation.ts`:

```ts
import stats from 'statswhatshesaid'
import type { NextRequest } from 'next/server'

export function GET(req: NextRequest) {
  stats.track(req)
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

Versioning and publishing are managed with [Changesets](https://github.com/changesets/changesets) and automated via GitHub Actions.

**Day-to-day flow:**

1. Make your changes on a branch and open a PR.
2. Add a changeset describing what changed:
   ```bash
   npx changeset
   ```
   Pick the bump type (patch / minor / major) and write a short summary. Commit the generated `.changeset/*.md` file.
3. Merge the PR into `main`. The `Release` workflow will open (or update) a **"chore(release): version packages"** PR that bumps `package.json` and updates `CHANGELOG.md`.
4. When you merge the release PR, the workflow publishes the new version to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements) attached.

**One-time setup:**

- The unscoped package name `statswhatshesaid` must be available on npm (`npm view statswhatshesaid` — a 404 means it's yours for the taking on first publish).
- Add an automation token to the GitHub repo as the `NPM_TOKEN` secret (`Settings → Secrets and variables → Actions`). Use a **granular** token scoped to publish the `statswhatshesaid` package.
- In `Settings → Actions → General`, under *Workflow permissions*, allow GitHub Actions to **create and approve pull requests** so the release bot can open the version PR.

**Manual publishing (escape hatch):**

If you ever need to cut a release locally:

```bash
npx changeset version   # bumps package.json + updates CHANGELOG
git commit -am "chore(release): version packages"
git push
npm run release         # verify + changeset publish
```

## License

MIT
