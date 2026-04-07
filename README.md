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
npm install @statswhatshesaid/next
```

## Use it

Add **one line** to your `middleware.ts`:

```ts
// middleware.ts
import stats from '@statswhatshesaid/next'

export default stats.middleware()

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
  runtime: 'nodejs', // REQUIRED — see "Edge Runtime" below
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

## Edge Runtime — read this first

Next.js middleware defaults to the **Edge runtime**, which can't run `node:crypto` or `node:fs`. You **must** opt into the Node runtime:

```ts
export const config = {
  matcher: [...],
  runtime: 'nodejs',
}
```

This is stable in **Next.js 15.2 and newer**.

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
import stats from '@statswhatshesaid/next'
import type { PersistAdapter, SnapshotV1 } from '@statswhatshesaid/next'

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

```ts
export default stats.middleware({
  endpointPath: '/_internal/stats',
  flushIntervalMs: 5 * 60 * 1000,
  historyDays: 30,
})
```

## Where it works

- ✅ **Self-hosted Next.js** — `next start` on a VPS, Docker, Fly.io, Railway, etc. Single long-running Node process.
- ❌ **Vercel / Netlify / serverless by default** — ephemeral filesystem and per-request lambdas mean the in-memory HLL doesn't survive. You *could* make this work with a custom `persist` adapter pointing at Vercel KV or Upstash Redis, but at that point you're probably better off with a hosted analytics service.

## Escape hatch (non-middleware integration)

If you can't use `runtime: 'nodejs'` in middleware, call the tracker manually from a route handler or `instrumentation.ts`:

```ts
import stats from '@statswhatshesaid/next'
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
```

The example app under `examples/basic` is the simplest way to smoke-test changes end-to-end.

## License

MIT
