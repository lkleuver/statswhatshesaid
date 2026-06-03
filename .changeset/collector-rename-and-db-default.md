---
"statswhatshesaid-collector": minor
---

**Breaking — CLI binary renamed and default DB path changed.**

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
