---
"statswhatshesaid": minor
"statswhatshesaid-collector": minor
---

**Library — opt-in shared-salt mode + raw HLL sketch export**

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
