# statswhatshesaid — monorepo

Repository for the [`statswhatshesaid`](./packages/lib/README.md) library and
its optional companion collector CLI.

## Packages

| Package | Path | Published as | Description |
| --- | --- | --- | --- |
| Library | [`packages/lib`](./packages/lib) | [`statswhatshesaid`](https://www.npmjs.com/package/statswhatshesaid) | The zero-dep, one-line Next.js middleware. See its [README](./packages/lib/README.md). |
| Collector | [`packages/collector`](./packages/collector) | [`statswhatshesaid-collector`](https://www.npmjs.com/package/statswhatshesaid-collector) | External CLI that polls one or many deployed apps and persists results to a local SQLite database. *(Not yet published.)* |
| HLL primitives | [`packages/hll`](./packages/hll) | *(internal, not published)* | Shared HyperLogLog primitives consumed by both packages. |

## Development

```bash
npm install
npm run verify   # typecheck + test + build across all packages
```

Per-package scripts run via npm workspaces; you can scope to a single
package with e.g. `npm run test --workspace packages/lib`.

## Releasing

Versioning and publishing are managed with [Changesets](https://github.com/changesets/changesets)
and automated via the GitHub Actions Release workflow using npm trusted
publishing (OIDC). Add a changeset with `npx changeset` describing what
changed; merging the resulting "Version Packages" PR triggers the publish.
