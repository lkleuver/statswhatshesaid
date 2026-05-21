# statswhatshesaid-collector

External, one-shot CLI that polls one or more deployed
[`statswhatshesaid`](../lib) instances and persists their results to a local
SQLite database.

Solves what the in-memory library deliberately does not:

- **Multi-app aggregation** — see all your apps in one database.
- **Best-effort persistence across restarts** — frequent polling snapshots
  today's running count before the next deploy wipes it.
- **Long-term retention** — collector never deletes; SQLite holds years of
  daily numbers regardless of the library's in-memory window.
- **Multi-replica merging** *(opt-in)* — fetch raw HLL sketches from each
  replica and merge them register-wise into a single union estimate.

The collector is intentionally separate from the library. The library stays
zero-dep and Edge-runtime-safe; the collector runs on any machine you own
(your laptop, a small VPS, a CI runner) and reaches your apps over HTTP.

## Install

```bash
npm i -g statswhatshesaid-collector
# or use without installing:
npx statswhatshesaid-collector
```

## Quick start

1. Create a config:

   ```bash
   swhsd-collect init ./swhsd.json
   ```

2. Edit `swhsd.json` and fill in your app(s):

   ```json
   {
     "$schema": "https://github.com/lkleuver/statswhatshesaid/raw/main/packages/collector/config.schema.json",
     "apps": {
       "blog": {
         "url": "https://blog.example.com/stats",
         "token": "your-STATS_TOKEN-here"
       }
     }
   }
   ```

3. Run it:

   ```bash
   swhsd-collect
   ```

   You should see one line per app:

   ```
   OK app=blog today=412 historyRows=89
   ```

4. Query the DB:

   ```bash
   sqlite3 ~/.local/share/statswhatshesaid/collector.db \
     "SELECT app, date, unique_visitors FROM daily ORDER BY date DESC LIMIT 14;"
   ```

## Scheduling

`swhsd-collect` is one-shot — schedule it like any other periodic job.

**cron** (every 15 minutes):

```cron
*/15 * * * * /usr/local/bin/swhsd-collect --config /home/you/swhsd.json
```

**systemd timer** (`swhsd-collect.service` + `swhsd-collect.timer`):

```ini
# /etc/systemd/system/swhsd-collect.service
[Unit]
Description=statswhatshesaid collector
[Service]
Type=oneshot
ExecStart=/usr/local/bin/swhsd-collect --config /etc/swhsd.json

# /etc/systemd/system/swhsd-collect.timer
[Unit]
Description=Run swhsd-collect every 15 min
[Timer]
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
```

**launchd** (macOS, `~/Library/LaunchAgents/com.you.swhsd-collect.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.you.swhsd-collect</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/swhsd-collect</string>
    <string>--config</string>
    <string>/Users/you/swhsd.json</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
</dict>
</plist>
```

**GitHub Actions** (run from a private repo):

```yaml
on:
  schedule: [{ cron: '*/15 * * * *' }]
jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx -y statswhatshesaid-collector --config ./swhsd.json
```

## Serve — local dashboard

`swhsd-collect serve` boots a tiny read-only HTML dashboard against the same
SQLite database the collector writes to.

```bash
swhsd-collect serve --config ./swhsd.json
# Listening on http://127.0.0.1:7878
```

The server:

- binds to **`127.0.0.1` only** by default (override with `--host`),
- opens the DB read-only,
- serves a single page at `/` and a JSON payload at `/api/overview.json`
  (the page polls the JSON endpoint every 30s and re-renders in place via
  the DOM API — no `innerHTML` for dynamic values),
- has **no built-in auth** — protect access with the OS (loopback, SSH
  tunnel, reverse proxy) rather than the dashboard itself.

The page shows, per app: today's running count, time since last poll, a
30-day sparkline (zero-filled when polling gaps exist), and a 30-day total.

| Flag | Default | Notes |
| --- | --- | --- |
| `--config <path>` | discovered | Used only to resolve the DB path. The dashboard works even when `apps` is empty. |
| `--host <addr>` | `127.0.0.1` | Set to `0.0.0.0` to expose on the network — combine with a reverse proxy + auth. |
| `--port <n>` | `7878` | TCP port (use `0` to let the OS pick a free one) |

## Config reference

| Top-level | Type | Default | Notes |
| --- | --- | --- | --- |
| `db` | string | `~/.local/share/statswhatshesaid/collector.db` | SQLite file path, supports `~` |
| `defaults.timeoutMs` | int | `10000` | Per-request timeout |
| `defaults.userAgent` | string | `swhsd-collect/0.1` | Sent as `User-Agent` |
| `apps` | object | **required** | Map of `{ name: appConfig }` |

| Per-app | Type | Notes |
| --- | --- | --- |
| `url` | string | Single endpoint. Mutually exclusive with `replicas`. |
| `replicas` | string[] | Per-replica URLs. Requires `merge: true` and shared salt. |
| `token` | string | **required** — the app's `STATS_TOKEN` |
| `timeoutMs` | int | Overrides `defaults.timeoutMs` for this app |
| `merge` | boolean | Required when `replicas` is set |

Config discovery order: `--config <path>` → `$SWHSD_CONFIG` → `./swhsd.json`
→ `$XDG_CONFIG_HOME/statswhatshesaid/config.json`.

## Multi-replica merging

If your app runs multiple replicas (e.g. several Kubernetes pods behind a
load balancer), each replica has its own HLL sketch and `/stats` will report
different numbers depending on which replica answers. The collector can
merge them — see the
["Multi-replica deployments"](../lib/README.md#multi-replica-deployments)
section of the library README for the prerequisites (`STATS_SALT_SECRET` set
on every replica, plus stable per-replica URLs).

Then declare the app with `replicas` + `merge: true` instead of `url`:

```json
{
  "apps": {
    "api": {
      "replicas": [
        "https://api-pod-1.internal/stats",
        "https://api-pod-2.internal/stats",
        "https://api-pod-3.internal/stats"
      ],
      "token": "...",
      "merge": true
    }
  }
}
```

The collector polls every replica concurrently, verifies the salt
fingerprints match, merges the raw HLL register arrays (element-wise max),
and writes one row per cycle with `source = 'merged'`. Per-replica
detail is also recorded in `replica_snapshots` for debugging skew.

## Schema

```sql
-- One row per (app, polled_at) for today, plus one row per (app, date)
-- for each historical day (idempotent via UNIQUE INDEX).
CREATE TABLE snapshots (
  id, app, date, unique_visitors, source,
  polled_at, generated_at, is_today, raw
);

-- Multi-replica detail (only populated for merge: true apps).
CREATE TABLE replica_snapshots (
  id, app, replica_url, date, unique_visitors,
  salt_fingerprint, polled_at
);

-- Convenience view — best-known count per (app, date).
CREATE VIEW daily AS
  SELECT app, date,
         MAX(unique_visitors) AS unique_visitors,
         MAX(polled_at) AS last_polled_at
  FROM snapshots
  GROUP BY app, date;
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | All apps polled and recorded successfully |
| 1 | Config error (missing file, malformed, missing token) |
| 2 | Partial failure (one or more apps could not be polled; others were recorded) |
| 3 | Total failure (DB error, or all apps failed) |

## License

MIT
