# `swhsd-collect serve` — design

**Date:** 2026-05-21
**Package:** `packages/collector`
**Status:** approved, ready for implementation plan

## Goal

Add a `serve` subcommand to the `statswhatshesaid-collector` CLI that spins
up a tiny local web interface visualizing the stats already persisted in the
collector's SQLite database.

The collector remains a one-shot poller; `serve` is a read-only view layer
on top of the same DB.

## Non-goals

- Editing config or apps from the UI.
- Triggering polls from the UI (use `swhsd-collect` for that, or schedule it).
- Multi-user auth, RBAC, accounts.
- Public-internet hosting. The default binding is loopback.
- Long historical drill-down, custom date ranges, replica skew analysis — out
  of scope for this iteration (the SQLite file is queryable for that).
- Bundling a frontend framework or a build step.

## CLI surface

```
swhsd-collect serve [options]

Options:
  --config <path>   Path to the config file (default: ./swhsd.json or XDG)
  --port <n>        Listen port (default: 7878)
  --host <addr>     Bind address (default: 127.0.0.1)
  --help, -h        Show help
```

`--config` is honored for DB-path discovery only; no apps need to be
configured for `serve` to start (the DB may already contain history from a
prior config).

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Graceful shutdown after SIGINT or SIGTERM |
| 1 | Config error (e.g. config file missing/invalid when explicitly requested) |
| 3 | Bind error (port in use), DB open failure, or fatal runtime error |

## Architecture

Files added:

```
packages/collector/src/
  serve/
    index.ts        // startServer({ dbPath, host, port }) -> { close(), url }
    handlers.ts     // pure handlers, take a Queries object, return Response
    queries.ts      // SQL prepared statements + typed accessors
    render.ts       // HTML page template + inline CSS
    sparkline.ts    // number[] -> inline <svg> path
  serve-cmd.ts      // CLI glue: parse flags, open db RO, signals, log "listening"
```

Files edited:

- `src/cli-main.ts` — add `serve` parsing branch; extend `HELP`.
- `README.md` — new "Serve" section.

No new runtime dependencies. `better-sqlite3` is already a dep; Node's
built-in `http`/`url`/`os` modules cover the rest.

### Server

- `http.createServer` from `node:http`.
- Two routes:
  - `GET /` → server-rendered HTML.
  - `GET /api/overview.json` → JSON payload powering the auto-refresh.
- Anything else → `404 not found` text/plain.
- DB opened read-only:
  `new Database(dbPath, { readonly: true, fileMustExist: true })`.
- Prepared statements created once at server startup.
- Graceful shutdown on SIGINT/SIGTERM: `server.close()`, await in-flight
  requests, then `db.close()`. The wrapper exits 0.

### Page contents

One table — one row per app:

| App | Today | Last poll | 30-day sparkline | 30-day total |
|---|---|---|---|---|

- **Today** — `unique_visitors` from the most-recent `snapshots` row with
  `is_today = 1` for that app. If there is no live row, fall back to the
  `daily` view's row for today's date. Empty cell if neither exists.
- **Last poll** — `MAX(polled_at)` across all `snapshots` for that app,
  rendered server-side as ISO8601 and re-rendered client-side as a relative
  string ("2 min ago").
- **30-day sparkline** — inline `<svg>` polyline drawn server-side from the
  `daily` view for the last 30 calendar days (UTC), zero-filling missing
  days.
- **30-day total** — `SUM(unique_visitors)` over the same 30-day window.

Page-level chrome:

- `<title>statswhatshesaid — collector</title>`
- A small header with the DB path and "Last updated: …" stamp.
- A footer link to `/api/overview.json` for operators who prefer raw data.

Empty state (no apps in DB yet):

- Friendly message: "No data yet. Run `swhsd-collect` to record your first
  poll, then refresh."
- Show the resolved DB path.

Auto-refresh:

- Inline `<script>` polls `/api/overview.json` every 30s.
- On success, re-renders the table body in place. On failure, leaves the
  previous table and shows a small "refresh failed" indicator.
- No external JS, no CDN.

### Queries

All parameterized, prepared once. The `?N` placeholders below use the
`better-sqlite3` positional style at runtime.

```sql
-- All apps known to the DB.
SELECT DISTINCT app
FROM snapshots
ORDER BY app;

-- 30-day series for one app (JS zero-fills missing dates).
SELECT date, unique_visitors
FROM daily
WHERE app = ? AND date >= ?
ORDER BY date;

-- Latest "today" value for one app.
SELECT unique_visitors, polled_at
FROM snapshots
WHERE app = ? AND is_today = 1
ORDER BY polled_at DESC
LIMIT 1;

-- Most recent poll for one app (any source).
SELECT MAX(polled_at) AS polled_at
FROM snapshots
WHERE app = ?;
```

### JSON API shape

```ts
interface OverviewResponse {
  generatedAt: string                // ISO timestamp the response was built
  dbPath: string                     // resolved absolute path
  apps: Array<{
    name: string
    today: number | null             // null when no live row and no daily fallback
    lastPolledAt: string | null      // ISO timestamp or null when no rows
    series30d: Array<{ date: string; uniqueVisitors: number }> // zero-filled
    total30d: number
  }>
}
```

## Error handling

- **Bind error** (`EADDRINUSE`, `EACCES`) — log a clear message naming the
  port and host, exit 3.
- **DB open failure** — log the DB path and underlying error, exit 3.
- **Per-request handler error** — caught at the route boundary:
  - `/` → return a minimal HTML 500 page with a single sentence.
  - `/api/*` → return JSON `{ "error": "<short message>" }` with status 500.
- **404** — text/plain `not found`.
- Stack traces are never sent in responses, even on loopback.

## Security

- Default `host = 127.0.0.1` so the server is unreachable from other hosts
  unless the operator explicitly overrides `--host`.
- DB handle is read-only at the SQLite layer (`readonly: true`); a buggy
  handler cannot mutate the DB even by accident.
- All SQL is parameterized via prepared statements.
- No user-controlled values are interpolated into HTML — every value
  rendered to `/` is either an app name from the DB or a server-generated
  number/timestamp. Escape via a small `escapeHtml` helper applied to every
  string interpolation regardless, as defense-in-depth.
- No cookies, no sessions, no CORS headers (loopback default makes this
  moot, but we deliberately do not set `Access-Control-Allow-Origin: *`).

## Testing

Vitest, in `packages/collector/test/`. Targets the 80%+ coverage line the
repo follows.

- `serve.test.ts` — unit tests for handler functions, called directly with
  a fixture `Queries` against an in-memory or temp-file SQLite DB. Asserts
  on JSON shape, empty-state behavior, HTML containing app names.
- `serve-cli.test.ts` — integration: spin up `startServer({ port: 0 })`,
  read back the chosen port, `fetch('/')` and `fetch('/api/overview.json')`,
  assert on status/body, then `close()`. One scenario with apps, one
  empty-DB scenario.
- `sparkline.test.ts` — pure unit tests: empty input, single point,
  zero-filled flat, monotonic increase, all-same. Asserts on the `<path d>`
  string.
- `cli.test.ts` — extend with: `serve --help` works, unknown flag fails,
  `--port abc` fails cleanly.

All tests deterministic; no real network, no real time-of-day dependence
(the "today" cutoff in queries uses a date parameter the test can inject).

## Open questions for the plan stage

- Does `startServer` accept the date-of-today as a parameter so tests can
  freeze time, or does it always use `new Date()` and tests use real dates?
  Lean toward dependency-injected `now()` for testability.
- Should the page poll interval be configurable via a query string
  (`/?refresh=60`)? Probably yes — it's free to support.

These are deferrable to the implementation plan.
