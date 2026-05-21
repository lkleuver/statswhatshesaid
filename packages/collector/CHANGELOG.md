# statswhatshesaid-collector

## 0.3.0

### Minor Changes

- a0b8337: **Breaking — CLI binary renamed and default DB path changed.**

  The CLI is now `statswhatshesaid-collector` instead of `swhsd-collect`. Anywhere
  you invoked the old name (cron entries, systemd units, launchd plists, scripts)
  needs the new name:

  ```diff
  -swhsd-collect --config /etc/swhsd.json
  +statswhatshesaid-collector --config /etc/swhsd.json
  ```

  The default database location is now **`./collector.db` next to the config
  file** rather than `$XDG_DATA_HOME/statswhatshesaid/collector.db`. This means a
  config directory is fully self-contained: copy or move the folder and the DB
  travels with it.

  If you were relying on the old XDG default, set `db` explicitly in your config
  to keep the existing path:

  ```json
  {
    "db": "~/.local/share/statswhatshesaid/collector.db",
    "apps": { ... }
  }
  ```

  The exported helper `defaultXdgDbPath()` has been renamed to
  `defaultDbPath(configPath)` and now takes the config file path as an argument.
  The `swhsd-collect/0.1` `User-Agent` default is now `statswhatshesaid-collector/0.1`.

## 0.2.0

### Minor Changes

- a404924: **Library — opt-in shared-salt mode + raw HLL sketch export**

  Add a new `saltSecret` option (env: `STATS_SALT_SECRET`). When set, the
  daily HLL salt is derived as `HMAC-SHA-256(saltSecret, utcDate)` instead of
  random per-process bytes. Replicas configured with the same secret then
  produce identical daily salts — the mathematical precondition for an
  external tool to merge HLL sketches across replicas. Cross-day
  unlinkability is preserved (the salt still rotates daily).

  When shared-salt mode is on, `GET /stats?format=raw` additionally returns
  the raw 16,384-byte HLL register array (base64) plus an 8-byte
  `saltFingerprint` so a collector can verify replicas are using the same
  salt before merging. When the secret is unset, behavior is unchanged.

  This is fully backwards-compatible: existing deployments need no changes.

  **New package — `statswhatshesaid-collector`**

  External one-shot CLI (`swhsd-collect`) that polls one or more deployed
  `statswhatshesaid` apps and persists their results to a local SQLite
  database. Solves what the in-memory library deliberately does not:

  - multi-app aggregation
  - best-effort persistence across app restarts
  - long-term retention beyond the library's in-memory window
  - multi-replica merging (opt-in, requires `STATS_SALT_SECRET`)

  Schedule it however you like — cron, systemd timer, launchd, GitHub
  Actions. See `packages/collector/README.md` for examples.
