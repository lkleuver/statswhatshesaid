---
"statswhatshesaid": minor
---

Add an optional `persistence: { load, save }` config for single-instance
durability. When provided, the library hydrates the in-memory sketch on first
request and saves an opaque JSON snapshot (today's salt + HLL registers +
history) with a debounced, fire-and-forget write — so counts survive deploys
and restarts. Zero new runtime dependencies; your database driver stays in your
app. Also adds `persistSaveDebounceMs` (default 30000).
