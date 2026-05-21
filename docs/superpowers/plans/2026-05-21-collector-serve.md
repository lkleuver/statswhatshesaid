# `swhsd-collect serve` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `serve` subcommand to `statswhatshesaid-collector` that serves a tiny localhost-only HTML dashboard reading from the collector's SQLite database, with zero new runtime dependencies.

**Architecture:** A new `src/serve/` module owns the dashboard. The HTTP server uses Node's built-in `http` module. SQLite is opened read-only via the existing `better-sqlite3` dep. The page is a single server-rendered HTML string that auto-refreshes a table body from `GET /api/overview.json` every 30 seconds, using DOM APIs (no `innerHTML` with untrusted data). CLI parsing in `src/cli-main.ts` gets a new `serve` branch that delegates to `src/serve-cmd.ts`.

**Tech Stack:** Node ≥20, TypeScript, `better-sqlite3` (already a dep), `node:http`, vitest. No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-05-21-collector-serve-design.md`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/collector/src/serve/sparkline.ts` | Pure `buildSparklinePath(values, width, height)` → `string` (SVG `d=`). |
| `packages/collector/src/serve/queries.ts` | `Queries` class wrapping prepared statements over a read-only `better-sqlite3` handle. Exposes `listApps()`, `getSeries30d(app, today)`, `getLatestToday(app)`, `getLastPolledAt(app)`. |
| `packages/collector/src/serve/handlers.ts` | Pure handler functions taking `{ queries, now, dbPath }` and returning a `{ status, headers, body }` triple for `/` and `/api/overview.json`. No `http` types here. |
| `packages/collector/src/serve/render.ts` | `renderPage(overview)` returns the HTML string. `escapeHtml` helper. |
| `packages/collector/src/serve/index.ts` | `startServer({ dbPath, host, port, now? })` boots `http.createServer`, wires routes to handlers, returns `{ url, close() }`. |
| `packages/collector/src/serve-cmd.ts` | CLI glue: flag parsing, opens RO db, calls `startServer`, installs SIGINT/SIGTERM handlers, returns an exit code from `cli-main`. |
| `packages/collector/src/cli-main.ts` | Modified to dispatch `serve` subcommand and extend `HELP`. |
| `packages/collector/README.md` | Modified with a new "Serve" section. |
| `packages/collector/test/serve-sparkline.test.ts` | Pure tests for sparkline output. |
| `packages/collector/test/serve-queries.test.ts` | Query tests against a fixture DB. |
| `packages/collector/test/serve-handlers.test.ts` | Handler-level tests (no socket). |
| `packages/collector/test/serve-integration.test.ts` | `startServer({ port: 0 })` + `fetch` integration test. |
| `packages/collector/test/serve-render.test.ts` | Renderer + `escapeHtml` tests. |
| `packages/collector/test/serve-cmd.test.ts` | Unit tests for `runServe`. |
| `packages/collector/test/cli.test.ts` | Extended with `serve --help` and flag-parsing checks. |

Each file < 200 lines, single responsibility, separable.

---

## Task 1: Sparkline pure function

**Files:**
- Create: `packages/collector/src/serve/sparkline.ts`
- Test: `packages/collector/test/serve-sparkline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/collector/test/serve-sparkline.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { buildSparklinePath } from '../src/serve/sparkline.js'

describe('buildSparklinePath', () => {
  it('returns empty string for empty input', () => {
    expect(buildSparklinePath([], 100, 20)).toBe('')
  })

  it('returns a single horizontal line at mid-height for one point', () => {
    expect(buildSparklinePath([42], 100, 20)).toBe('M 0 10 L 100 10')
  })

  it('renders a monotonic increasing series from bottom-left to top-right', () => {
    const d = buildSparklinePath([0, 1, 2, 3], 100, 20)
    expect(d).toBe('M 0 20 L 33.33 13.33 L 66.67 6.67 L 100 0')
  })

  it('renders a flat line when all values are equal', () => {
    expect(buildSparklinePath([5, 5, 5, 5], 90, 30)).toBe(
      'M 0 15 L 30 15 L 60 15 L 90 15',
    )
  })

  it('maps zero against a positive max to the bottom edge', () => {
    const d = buildSparklinePath([0, 10, 0], 40, 20)
    expect(d).toBe('M 0 20 L 20 0 L 40 20')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/collector && npx vitest run test/serve-sparkline.test.ts
```

Expected: FAIL — `Cannot find module '../src/serve/sparkline.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/collector/src/serve/sparkline.ts`:

```ts
/**
 * Convert a numeric series into an SVG `d` attribute string for a polyline
 * sparkline. Pure; no DOM, no XML escaping concerns (digits and spaces only).
 *
 * When all values are equal (or there is exactly one), the line is rendered
 * at the vertical midpoint of the box so it stays visually centered.
 */
export function buildSparklinePath(
  values: readonly number[],
  width: number,
  height: number,
): string {
  if (values.length === 0) return ''
  if (values.length === 1) {
    const mid = round(height / 2)
    return `M 0 ${mid} L ${width} ${mid}`
  }

  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min
  const flat = range === 0

  const stepX = width / (values.length - 1)
  const segments: string[] = []
  for (let i = 0; i < values.length; i++) {
    const x = round(i * stepX)
    const y = flat
      ? round(height / 2)
      : round(height - ((values[i] - min) / range) * height)
    segments.push(i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`)
  }
  return segments.join(' ')
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/serve-sparkline.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/collector/src/serve/sparkline.ts \
        packages/collector/test/serve-sparkline.test.ts
git commit -m "feat(collector): add sparkline SVG path builder"
```

---

## Task 2: Queries module (read-only DB layer)

**Files:**
- Create: `packages/collector/src/serve/queries.ts`
- Test: `packages/collector/test/serve-queries.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/collector/test/serve-queries.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CollectorDb } from '../src/db.js'
import { reconcileApp } from '../src/reconcile.js'
import { Queries } from '../src/serve/queries.js'
import type { PollResponse } from '../src/types.js'

function seed(db: CollectorDb, app: string, today: string, todayCount: number) {
  const response: PollResponse = {
    today: { date: today, uniqueVisitors: todayCount },
    history: [
      { date: '2026-05-18', uniqueVisitors: 50 },
      { date: '2026-05-19', uniqueVisitors: 60 },
      { date: '2026-05-20', uniqueVisitors: 70 },
    ],
    generatedAt: `${today}T12:00:00Z`,
  }
  reconcileApp(db, { app, source: 'single', polledAt: `${today}T12:00:01Z`, response })
}

describe('Queries', () => {
  let dbPath: string
  let writeDb: CollectorDb
  let queries: Queries | null
  let readHandle: Database.Database | null

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'swhsd-serve-queries-'))
    dbPath = join(dir, 'collector.db')
    writeDb = CollectorDb.open(dbPath)
    queries = null
    readHandle = null
  })

  afterEach(() => {
    queries?.close()
    writeDb.close()
  })

  function openReadonly() {
    readHandle = new Database(dbPath, { readonly: true, fileMustExist: true })
    queries = new Queries(readHandle)
    return queries
  }

  it('listApps returns empty array on a fresh DB', () => {
    expect(openReadonly().listApps()).toEqual([])
  })

  it('listApps returns distinct app names sorted ascending', () => {
    seed(writeDb, 'blog', '2026-05-21', 10)
    seed(writeDb, 'api', '2026-05-21', 20)
    seed(writeDb, 'api', '2026-05-21', 25)
    expect(openReadonly().listApps()).toEqual(['api', 'blog'])
  })

  it('getLatestToday returns the latest is_today row for that app', () => {
    seed(writeDb, 'blog', '2026-05-21', 10)
    seed(writeDb, 'blog', '2026-05-21', 22)
    const row = openReadonly().getLatestToday('blog')
    expect(row?.uniqueVisitors).toBe(22)
    expect(row?.polledAt).toBe('2026-05-21T12:00:01Z')
  })

  it('getLatestToday returns null when no rows for that app', () => {
    seed(writeDb, 'blog', '2026-05-21', 10)
    expect(openReadonly().getLatestToday('missing')).toBeNull()
  })

  it('getLastPolledAt returns the max polled_at across all snapshots for the app', () => {
    seed(writeDb, 'blog', '2026-05-21', 10)
    expect(openReadonly().getLastPolledAt('blog')).toBe('2026-05-21T12:00:01Z')
  })

  it('getLastPolledAt returns null for unknown app', () => {
    expect(openReadonly().getLastPolledAt('missing')).toBeNull()
  })

  it('getSeries30d returns rows on or after the cutoff date in ascending order', () => {
    seed(writeDb, 'blog', '2026-05-21', 10)
    const rows = openReadonly().getSeries30d('blog', '2026-04-22')
    expect(rows.map((r) => r.date)).toEqual([
      '2026-05-18',
      '2026-05-19',
      '2026-05-20',
      '2026-05-21',
    ])
    expect(rows[3]?.uniqueVisitors).toBe(10)
  })

  it('getSeries30d filters out dates earlier than the cutoff', () => {
    seed(writeDb, 'blog', '2026-05-21', 10)
    const rows = openReadonly().getSeries30d('blog', '2026-05-20')
    expect(rows.map((r) => r.date)).toEqual(['2026-05-20', '2026-05-21'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/serve-queries.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/collector/src/serve/queries.ts`:

```ts
import type Database from 'better-sqlite3'

export interface TodayRow {
  uniqueVisitors: number
  polledAt: string
}

export interface SeriesPoint {
  date: string
  uniqueVisitors: number
}

/**
 * Read-only access layer over the collector's SQLite database. Owns the
 * prepared statements the dashboard needs. Constructed once at server
 * startup; not safe to share across DB handles.
 */
export class Queries {
  private readonly stmtListApps: Database.Statement
  private readonly stmtSeries30d: Database.Statement
  private readonly stmtLatestToday: Database.Statement
  private readonly stmtLastPolled: Database.Statement
  private readonly handle: Database.Database

  constructor(db: Database.Database) {
    this.handle = db
    this.stmtListApps = db.prepare(
      `SELECT DISTINCT app FROM snapshots ORDER BY app`,
    )
    this.stmtSeries30d = db.prepare(
      `SELECT date, unique_visitors AS uniqueVisitors
       FROM daily
       WHERE app = ? AND date >= ?
       ORDER BY date`,
    )
    this.stmtLatestToday = db.prepare(
      `SELECT unique_visitors AS uniqueVisitors, polled_at AS polledAt
       FROM snapshots
       WHERE app = ? AND is_today = 1
       ORDER BY polled_at DESC
       LIMIT 1`,
    )
    this.stmtLastPolled = db.prepare(
      `SELECT MAX(polled_at) AS polledAt
       FROM snapshots
       WHERE app = ?`,
    )
  }

  listApps(): string[] {
    return (this.stmtListApps.all() as Array<{ app: string }>).map((r) => r.app)
  }

  getSeries30d(app: string, cutoffDate: string): SeriesPoint[] {
    return this.stmtSeries30d.all(app, cutoffDate) as SeriesPoint[]
  }

  getLatestToday(app: string): TodayRow | null {
    const row = this.stmtLatestToday.get(app) as TodayRow | undefined
    return row ?? null
  }

  getLastPolledAt(app: string): string | null {
    const row = this.stmtLastPolled.get(app) as { polledAt: string | null } | undefined
    return row?.polledAt ?? null
  }

  close(): void {
    this.handle.close()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/serve-queries.test.ts
```

Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/collector/src/serve/queries.ts \
        packages/collector/test/serve-queries.test.ts
git commit -m "feat(collector): add read-only Queries layer for serve"
```

---

## Task 3: HTML renderer + escape helper (DOM-safe refresh script)

**Files:**
- Create: `packages/collector/src/serve/render.ts`
- Test: `packages/collector/test/serve-render.test.ts`

The auto-refresh script uses `document.createElement` + `textContent` for every JSON value. The only DOM nodes built from string templates are static, server-controlled fragments (no untrusted input).

- [ ] **Step 1: Write the failing test**

Create `packages/collector/test/serve-render.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { renderPage, escapeHtml } from '../src/serve/render.js'

describe('escapeHtml', () => {
  it('escapes the five XML-significant characters', () => {
    expect(escapeHtml(`<script>alert("xss & 'pwn')</script>`)).toBe(
      `&lt;script&gt;alert(&quot;xss &amp; &#39;pwn&#39;)&lt;/script&gt;`,
    )
  })

  it('leaves safe ASCII untouched', () => {
    expect(escapeHtml('blog-app_123')).toBe('blog-app_123')
  })
})

describe('renderPage', () => {
  it('renders an empty state with the DB path when there are no apps', () => {
    const html = renderPage({
      generatedAt: '2026-05-21T12:00:00Z',
      dbPath: '/tmp/collector.db',
      apps: [],
    })
    expect(html).toContain('<title>statswhatshesaid')
    expect(html).toContain('No data yet')
    expect(html).toContain('/tmp/collector.db')
  })

  it('renders one table row per app with today count and 30d total', () => {
    const html = renderPage({
      generatedAt: '2026-05-21T12:00:00Z',
      dbPath: '/tmp/x.db',
      apps: [
        {
          name: 'blog',
          today: 42,
          lastPolledAt: '2026-05-21T11:59:00Z',
          series30d: [
            { date: '2026-05-20', uniqueVisitors: 100 },
            { date: '2026-05-21', uniqueVisitors: 42 },
          ],
          total30d: 142,
        },
      ],
    })
    expect(html).toContain('blog')
    expect(html).toContain('42')
    expect(html).toContain('142')
    expect(html).toContain('<svg')
    expect(html).toContain('2026-05-21T11:59:00Z')
  })

  it('escapes app names in HTML output', () => {
    const html = renderPage({
      generatedAt: '2026-05-21T12:00:00Z',
      dbPath: '/tmp/x.db',
      apps: [
        {
          name: '<script>alert(1)</script>',
          today: 1,
          lastPolledAt: null,
          series30d: [],
          total30d: 0,
        },
      ],
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('refresh script uses textContent rather than innerHTML for dynamic data', () => {
    const html = renderPage({
      generatedAt: '2026-05-21T12:00:00Z',
      dbPath: '/tmp/x.db',
      apps: [],
    })
    // The inline script must not assign innerHTML — that would be an XSS
    // sink if /api/overview.json content were ever influenced by untrusted
    // sources. Dynamic values come in via textContent / createElement.
    expect(html).not.toMatch(/\.innerHTML\s*=/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/serve-render.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/collector/src/serve/render.ts`:

```ts
import { buildSparklinePath } from './sparkline.js'

export interface OverviewApp {
  name: string
  today: number | null
  lastPolledAt: string | null
  series30d: Array<{ date: string; uniqueVisitors: number }>
  total30d: number
}

export interface Overview {
  generatedAt: string
  dbPath: string
  apps: OverviewApp[]
}

const SVG_WIDTH = 120
const SVG_HEIGHT = 28
const SVG_NS = 'http://www.w3.org/2000/svg'

export function renderPage(overview: Overview): string {
  const body = overview.apps.length === 0
    ? renderEmptyState(overview.dbPath)
    : renderTable(overview.apps)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>statswhatshesaid — collector</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; --fg: #111; --muted: #666; --line: #ddd; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #eee; --muted: #999; --line: #333; }
    body { background: #111; }
  }
  body { font: 14px/1.5 system-ui, sans-serif; color: var(--fg); margin: 2rem; max-width: 56rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  .meta { color: var(--muted); font-size: .85rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; }
  th, td { padding: .5rem .75rem; text-align: left; border-bottom: 1px solid var(--line); }
  th { font-weight: 600; color: var(--muted); font-size: .8rem; text-transform: uppercase; }
  td.num { font-variant-numeric: tabular-nums; text-align: right; }
  svg { display: block; }
  .empty { padding: 2rem; border: 1px dashed var(--line); border-radius: 4px; }
  code { background: rgba(127,127,127,.15); padding: 0 .25rem; border-radius: 3px; }
  footer { margin-top: 2rem; color: var(--muted); font-size: .8rem; }
  #refresh-error { color: #c00; font-size: .8rem; margin-left: .5rem; }
</style>
</head>
<body>
<h1>statswhatshesaid</h1>
<div class="meta">
  DB: <code>${escapeHtml(overview.dbPath)}</code> ·
  Last updated: <span id="updated">${escapeHtml(overview.generatedAt)}</span>
  <span id="refresh-error" hidden>refresh failed</span>
</div>
${body}
<footer>
  Raw data: <a href="/api/overview.json">/api/overview.json</a>
</footer>
<script>
(function () {
  var REFRESH_MS = 30000;
  var SVG_W = ${SVG_WIDTH};
  var SVG_H = ${SVG_HEIGHT};
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function fmtRel(iso) {
    if (!iso) return '—';
    var t = Date.parse(iso);
    if (isNaN(t)) return iso;
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function paintRelative() {
    var nodes = document.querySelectorAll('[data-relative]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = fmtRel(nodes[i].getAttribute('data-relative'));
    }
  }
  function sparkPath(series) {
    if (!series || series.length === 0) return '';
    var values = series.map(function (p) { return p.uniqueVisitors; });
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < values.length; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    var flat = max === min;
    var step = values.length > 1 ? SVG_W / (values.length - 1) : 0;
    var parts = [];
    for (var j = 0; j < values.length; j++) {
      var x = Math.round(j * step * 100) / 100;
      var y = flat
        ? SVG_H / 2
        : Math.round((SVG_H - ((values[j] - min) / (max - min)) * SVG_H) * 100) / 100;
      parts.push((j === 0 ? 'M ' : 'L ') + x + ' ' + y);
    }
    return parts.join(' ');
  }
  function buildSparkSvg(series) {
    var path = sparkPath(series);
    if (!path) return null;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(SVG_W));
    svg.setAttribute('height', String(SVG_H));
    svg.setAttribute('viewBox', '0 0 ' + SVG_W + ' ' + SVG_H);
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', path);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.5');
    svg.appendChild(p);
    return svg;
  }
  function buildRow(app) {
    var tr = document.createElement('tr');
    var tdName = document.createElement('td');
    tdName.textContent = app.name;
    tr.appendChild(tdName);

    var tdToday = document.createElement('td');
    tdToday.className = 'num';
    tdToday.textContent = app.today == null ? '—' : String(app.today);
    tr.appendChild(tdToday);

    var tdLast = document.createElement('td');
    var span = document.createElement('span');
    if (app.lastPolledAt) span.setAttribute('data-relative', app.lastPolledAt);
    span.textContent = app.lastPolledAt || '—';
    tdLast.appendChild(span);
    tr.appendChild(tdLast);

    var tdSpark = document.createElement('td');
    var svg = buildSparkSvg(app.series30d);
    if (svg) tdSpark.appendChild(svg);
    tr.appendChild(tdSpark);

    var tdTotal = document.createElement('td');
    tdTotal.className = 'num';
    tdTotal.textContent = String(app.total30d);
    tr.appendChild(tdTotal);

    return tr;
  }
  function showError(visible) {
    var note = document.getElementById('refresh-error');
    if (note) note.hidden = !visible;
  }
  function refresh() {
    fetch('/api/overview.json', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var tbody = document.getElementById('rows');
        if (!tbody) return;
        while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
        for (var i = 0; i < data.apps.length; i++) {
          tbody.appendChild(buildRow(data.apps[i]));
        }
        var updated = document.getElementById('updated');
        if (updated) updated.textContent = data.generatedAt;
        paintRelative();
        showError(false);
      })
      .catch(function () { showError(true); });
  }
  paintRelative();
  setInterval(refresh, REFRESH_MS);
})();
</script>
</body>
</html>`
}

function renderEmptyState(dbPath: string): string {
  return `<div class="empty">
  <p><strong>No data yet.</strong></p>
  <p>Run <code>swhsd-collect</code> to record your first poll, then refresh this page.</p>
  <p class="meta">DB: <code>${escapeHtml(dbPath)}</code></p>
</div>`
}

function renderTable(apps: OverviewApp[]): string {
  const rows = apps.map((a) => {
    const path = buildSparklinePath(
      a.series30d.map((p) => p.uniqueVisitors),
      SVG_WIDTH,
      SVG_HEIGHT,
    )
    const svg = path === ''
      ? ''
      : `<svg xmlns="${SVG_NS}" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`
    const todayCell = a.today == null ? '—' : String(a.today)
    const lastPolled = a.lastPolledAt ?? ''
    const relativeAttr = lastPolled ? ` data-relative="${escapeHtml(lastPolled)}"` : ''
    return `<tr>
  <td>${escapeHtml(a.name)}</td>
  <td class="num">${todayCell}</td>
  <td><span${relativeAttr}>${escapeHtml(lastPolled || '—')}</span></td>
  <td>${svg}</td>
  <td class="num">${a.total30d}</td>
</tr>`
  }).join('\n')
  return `<table>
<thead>
<tr><th>App</th><th>Today</th><th>Last poll</th><th>30-day</th><th>30-day total</th></tr>
</thead>
<tbody id="rows">
${rows}
</tbody>
</table>`
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/serve-render.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/collector/src/serve/render.ts \
        packages/collector/test/serve-render.test.ts
git commit -m "feat(collector): add HTML renderer (DOM-safe refresh)"
```

---

## Task 4: Handlers (compose queries + renderer)

**Files:**
- Create: `packages/collector/src/serve/handlers.ts`
- Test: `packages/collector/test/serve-handlers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/collector/test/serve-handlers.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CollectorDb } from '../src/db.js'
import { reconcileApp } from '../src/reconcile.js'
import { Queries } from '../src/serve/queries.js'
import {
  handleOverviewJson,
  handlePageHtml,
  buildOverview,
} from '../src/serve/handlers.js'
import type { PollResponse } from '../src/types.js'

function seed(db: CollectorDb, app: string, today: string, todayCount: number) {
  const response: PollResponse = {
    today: { date: today, uniqueVisitors: todayCount },
    history: [
      { date: '2026-05-19', uniqueVisitors: 60 },
      { date: '2026-05-20', uniqueVisitors: 70 },
    ],
    generatedAt: `${today}T12:00:00Z`,
  }
  reconcileApp(db, {
    app,
    source: 'single',
    polledAt: `${today}T12:00:01Z`,
    response,
  })
}

describe('handlers', () => {
  let dbPath: string
  let writeDb: CollectorDb
  let queries: Queries | null
  let readHandle: Database.Database | null
  const now = () => new Date('2026-05-21T12:00:30Z')

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'swhsd-handlers-'))
    dbPath = join(dir, 'c.db')
    writeDb = CollectorDb.open(dbPath)
    queries = null
    readHandle = null
  })

  afterEach(() => {
    queries?.close()
    writeDb.close()
  })

  function open() {
    readHandle = new Database(dbPath, { readonly: true, fileMustExist: true })
    queries = new Queries(readHandle)
    return queries
  }

  it('buildOverview returns empty apps[] for a fresh DB', () => {
    const overview = buildOverview({ queries: open(), now, dbPath })
    expect(overview.apps).toEqual([])
    expect(overview.dbPath).toBe(dbPath)
    expect(overview.generatedAt).toBe('2026-05-21T12:00:30.000Z')
  })

  it('buildOverview zero-fills missing dates in the 30-day series', () => {
    seed(writeDb, 'blog', '2026-05-21', 42)
    const overview = buildOverview({ queries: open(), now, dbPath })
    const blog = overview.apps.find((a) => a.name === 'blog')!
    expect(blog.series30d).toHaveLength(30)
    expect(blog.series30d[0]?.date).toBe('2026-04-22')
    expect(blog.series30d[29]?.date).toBe('2026-05-21')
    expect(blog.series30d[27]?.uniqueVisitors).toBe(60)
    expect(blog.series30d[28]?.uniqueVisitors).toBe(70)
    expect(blog.series30d[29]?.uniqueVisitors).toBe(42)
    expect(blog.series30d[0]?.uniqueVisitors).toBe(0)
    expect(blog.total30d).toBe(60 + 70 + 42)
    expect(blog.today).toBe(42)
    expect(blog.lastPolledAt).toBe('2026-05-21T12:00:01Z')
  })

  it('handleOverviewJson returns 200 + application/json + valid JSON body', () => {
    seed(writeDb, 'blog', '2026-05-21', 7)
    const res = handleOverviewJson({ queries: open(), now, dbPath })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    const parsed = JSON.parse(res.body)
    expect(parsed.apps[0].name).toBe('blog')
  })

  it('handlePageHtml returns 200 + text/html and contains an app name', () => {
    seed(writeDb, 'api', '2026-05-21', 9)
    const res = handlePageHtml({ queries: open(), now, dbPath })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('api')
    expect(res.body).toContain('<!doctype html>')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/serve-handlers.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/collector/src/serve/handlers.ts`:

```ts
import type { Queries } from './queries.js'
import { renderPage, type Overview, type OverviewApp } from './render.js'

export interface HandlerContext {
  queries: Queries
  now: () => Date
  dbPath: string
}

export interface HandlerResponse {
  status: number
  headers: Record<string, string>
  body: string
}

const WINDOW_DAYS = 30

/**
 * Build the dashboard's view-model. Zero-fills missing dates so the
 * sparkline x-axis stays uniform regardless of polling gaps.
 */
export function buildOverview(ctx: HandlerContext): Overview {
  const now = ctx.now()
  const today = isoDate(now)
  const cutoff = isoDate(addDays(now, -(WINDOW_DAYS - 1)))
  const dates = enumerateDates(cutoff, today)

  const appNames = ctx.queries.listApps()
  const apps: OverviewApp[] = appNames.map((name) => {
    const rows = ctx.queries.getSeries30d(name, cutoff)
    const byDate = new Map(rows.map((r) => [r.date, r.uniqueVisitors]))
    const series30d = dates.map((date) => ({
      date,
      uniqueVisitors: byDate.get(date) ?? 0,
    }))
    const total30d = series30d.reduce((sum, p) => sum + p.uniqueVisitors, 0)
    const latest = ctx.queries.getLatestToday(name)
    return {
      name,
      today: latest?.uniqueVisitors ?? null,
      lastPolledAt: ctx.queries.getLastPolledAt(name),
      series30d,
      total30d,
    }
  })

  return {
    generatedAt: now.toISOString(),
    dbPath: ctx.dbPath,
    apps,
  }
}

export function handleOverviewJson(ctx: HandlerContext): HandlerResponse {
  const overview = buildOverview(ctx)
  return {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(overview),
  }
}

export function handlePageHtml(ctx: HandlerContext): HandlerResponse {
  const overview = buildOverview(ctx)
  return {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: renderPage(overview),
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime())
  out.setUTCDate(out.getUTCDate() + n)
  return out
}

function enumerateDates(fromIso: string, toIso: string): string[] {
  const result: string[] = []
  const start = new Date(`${fromIso}T00:00:00Z`)
  const end = new Date(`${toIso}T00:00:00Z`)
  for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    result.push(isoDate(d))
  }
  return result
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/serve-handlers.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/collector/src/serve/handlers.ts \
        packages/collector/test/serve-handlers.test.ts
git commit -m "feat(collector): add serve handlers + zero-filled overview"
```

---

## Task 5: `startServer` (Node http wiring)

**Files:**
- Create: `packages/collector/src/serve/index.ts`
- Test: `packages/collector/test/serve-integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/collector/test/serve-integration.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CollectorDb } from '../src/db.js'
import { reconcileApp } from '../src/reconcile.js'
import { startServer, type RunningServer } from '../src/serve/index.js'
import type { PollResponse } from '../src/types.js'

function seed(db: CollectorDb, app: string, todayCount: number) {
  const response: PollResponse = {
    today: { date: '2026-05-21', uniqueVisitors: todayCount },
    history: [{ date: '2026-05-20', uniqueVisitors: 50 }],
    generatedAt: '2026-05-21T12:00:00Z',
  }
  reconcileApp(db, {
    app,
    source: 'single',
    polledAt: '2026-05-21T12:00:01Z',
    response,
  })
}

describe('startServer integration', () => {
  let dbPath: string
  let server: RunningServer | null

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'swhsd-serve-int-'))
    dbPath = join(dir, 'c.db')
    server = null
  })

  afterEach(async () => {
    if (server) await server.close()
  })

  it('serves an empty-state HTML page when the DB has no rows', async () => {
    CollectorDb.open(dbPath).close()
    server = await startServer({ dbPath, host: '127.0.0.1', port: 0 })
    const res = await fetch(server.url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const body = await res.text()
    expect(body).toContain('No data yet')
  })

  it('serves a populated dashboard and matching /api/overview.json', async () => {
    const db = CollectorDb.open(dbPath)
    seed(db, 'blog', 12)
    db.close()
    server = await startServer({ dbPath, host: '127.0.0.1', port: 0 })

    const html = await (await fetch(server.url)).text()
    expect(html).toContain('blog')
    expect(html).toContain('<table')

    const json = (await (await fetch(`${server.url}/api/overview.json`)).json()) as {
      apps: Array<{ name: string; today: number }>
    }
    expect(json.apps[0]?.name).toBe('blog')
    expect(json.apps[0]?.today).toBe(12)
  })

  it('returns 404 for unknown paths', async () => {
    CollectorDb.open(dbPath).close()
    server = await startServer({ dbPath, host: '127.0.0.1', port: 0 })
    const res = await fetch(`${server.url}/nope`)
    expect(res.status).toBe(404)
  })

  it('rejects bind on a port already in use with a clear error', async () => {
    CollectorDb.open(dbPath).close()
    const first = await startServer({ dbPath, host: '127.0.0.1', port: 0 })
    const port = Number(new URL(first.url).port)
    await expect(
      startServer({ dbPath, host: '127.0.0.1', port }),
    ).rejects.toThrow(/EADDRINUSE|in use/)
    await first.close()
  })

  it('close() releases the socket so a follow-up bind on the same port succeeds', async () => {
    CollectorDb.open(dbPath).close()
    const first = await startServer({ dbPath, host: '127.0.0.1', port: 0 })
    const port = Number(new URL(first.url).port)
    await first.close()
    const second = await startServer({ dbPath, host: '127.0.0.1', port })
    await second.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/serve-integration.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/collector/src/serve/index.ts`:

```ts
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'

import Database from 'better-sqlite3'

import {
  handleOverviewJson,
  handlePageHtml,
  type HandlerContext,
  type HandlerResponse,
} from './handlers.js'
import { Queries } from './queries.js'

export interface StartServerOptions {
  dbPath: string
  host: string
  port: number
  /** Injected clock for tests. Defaults to `() => new Date()`. */
  now?: () => Date
}

export interface RunningServer {
  /** Origin including scheme and port — e.g. `http://127.0.0.1:53187`. */
  url: string
  /** Gracefully close the listener and the DB handle. */
  close: () => Promise<void>
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c)
}

/**
 * Boot the dashboard HTTP server. Opens the DB read-only, prepares
 * statements once, and routes the two known paths. All other paths get a
 * 404. Per-handler errors are caught at the route boundary so they cannot
 * crash the process.
 */
export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const dbHandle = new Database(opts.dbPath, { readonly: true, fileMustExist: true })
  const queries = new Queries(dbHandle)
  const ctx: HandlerContext = {
    queries,
    now: opts.now ?? (() => new Date()),
    dbPath: opts.dbPath,
  }

  const server = createServer((req, res) => {
    void route(req, res, ctx)
  })

  try {
    await listen(server, opts.host, opts.port)
  } catch (err) {
    queries.close()
    throw err
  }

  const addr = server.address()
  const port = addr && typeof addr !== 'string' ? addr.port : opts.port
  const url = `http://${opts.host}:${port}`

  return {
    url,
    close: async () => {
      await closeServer(server)
      queries.close()
    },
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  if (req.method !== 'GET') {
    return send(res, {
      status: 405,
      headers: { 'content-type': 'text/plain' },
      body: 'method not allowed',
    })
  }
  const path = (req.url ?? '/').split('?')[0]
  try {
    if (path === '/' || path === '/index.html') {
      return send(res, handlePageHtml(ctx))
    }
    if (path === '/api/overview.json') {
      return send(res, handleOverviewJson(ctx))
    }
    return send(res, {
      status: 404,
      headers: { 'content-type': 'text/plain' },
      body: 'not found',
    })
  } catch (err) {
    const message = (err as Error).message || 'internal error'
    if (path.startsWith('/api/')) {
      return send(res, {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: message }),
      })
    }
    return send(res, {
      status: 500,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: `<!doctype html><h1>Internal error</h1><p>${escapeHtml(message)}</p>`,
    })
  }
}

function send(res: ServerResponse, r: HandlerResponse): void {
  res.statusCode = r.status
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v)
  res.end(r.body)
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/serve-integration.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/collector/src/serve/index.ts \
        packages/collector/test/serve-integration.test.ts
git commit -m "feat(collector): boot serve HTTP server with graceful shutdown"
```

---

## Task 6: CLI glue — `serve-cmd.ts`

**Files:**
- Create: `packages/collector/src/serve-cmd.ts`
- Test: `packages/collector/test/serve-cmd.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/collector/test/serve-cmd.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CollectorDb } from '../src/db.js'
import { runServe } from '../src/serve-cmd.js'

class CaptureStream extends Writable {
  chunks: Buffer[] = []
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk))
    cb()
  }
  get text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

function makeIo() {
  const stdout = new CaptureStream()
  const stderr = new CaptureStream()
  return { io: { stdout, stderr }, stdout, stderr }
}

describe('runServe', () => {
  let dbPath: string

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'swhsd-serve-cmd-'))
    dbPath = join(dir, 'c.db')
  })

  it('returns 0 after the abort signal fires; logs the listening URL', async () => {
    CollectorDb.open(dbPath).close()
    const { io, stderr } = makeIo()
    const controller = new AbortController()

    const pending = runServe(
      { dbPath, host: '127.0.0.1', port: 0, signal: controller.signal },
      io,
    )

    for (let i = 0; i < 50 && !stderr.text.includes('Listening'); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(stderr.text).toMatch(/Listening on http:\/\/127\.0\.0\.1:\d+/)

    controller.abort()
    const code = await pending
    expect(code).toBe(0)
  })

  it('returns 3 when the DB file does not exist', async () => {
    const { io, stderr } = makeIo()
    const code = await runServe(
      { dbPath: join(dbPath, 'missing.db'), host: '127.0.0.1', port: 0 },
      io,
    )
    expect(code).toBe(3)
    expect(stderr.text).toMatch(/missing\.db|unable to open/i)
  })
})
```

> Note: A "port-in-use" assertion is already covered by the integration
> test in Task 5 (`startServer rejects bind on a port already in use`),
> so we deliberately keep this file focused on the abort and DB-missing
> paths to avoid environment-sensitive flakes.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/serve-cmd.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/collector/src/serve-cmd.ts`:

```ts
import type { IoStreams } from './cli-main.js'
import { startServer, type RunningServer } from './serve/index.js'

export interface RunServeOptions {
  dbPath: string
  host: string
  port: number
  /**
   * Abort signal. When aborted, the server is closed and runServe resolves
   * with exit code 0. The CLI wires this to SIGINT/SIGTERM; tests use an
   * `AbortController` directly.
   */
  signal?: AbortSignal
}

/**
 * Boot the dashboard server and block until the abort signal fires.
 * Returns an exit code (0 on graceful shutdown, 3 on startup error).
 */
export async function runServe(opts: RunServeOptions, io: IoStreams): Promise<number> {
  let server: RunningServer
  try {
    server = await startServer({
      dbPath: opts.dbPath,
      host: opts.host,
      port: opts.port,
    })
  } catch (err) {
    io.stderr.write(`swhsd-collect serve: ${(err as Error).message}\n`)
    return 3
  }

  io.stderr.write(`Listening on ${server.url}\n`)
  io.stderr.write(`DB: ${opts.dbPath}\n`)
  io.stderr.write(`Press Ctrl+C to stop.\n`)

  await waitForAbort(opts.signal)
  await server.close()
  return 0
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/serve-cmd.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/collector/src/serve-cmd.ts \
        packages/collector/test/serve-cmd.test.ts
git commit -m "feat(collector): add runServe CLI command function"
```

---

## Task 7: Wire `serve` into the CLI

**Files:**
- Modify: `packages/collector/src/cli-main.ts`
- Modify: `packages/collector/test/cli.test.ts`

- [ ] **Step 1: Extend `cli.test.ts` with the failing tests**

Append to `packages/collector/test/cli.test.ts` (the existing `CaptureStream` and `makeIo` are reused; no new imports beyond `process` are needed since `process` is a Node global):

```ts
describe('runCli serve', () => {
  it('--help mentions the serve subcommand', async () => {
    const { io, stdout } = makeIo()
    const code = await runCli(['--help'], io)
    expect(code).toBe(0)
    expect(stdout.text).toMatch(/serve/)
  })

  it('serve --help prints serve-specific options', async () => {
    const { io, stdout } = makeIo()
    const code = await runCli(['serve', '--help'], io)
    expect(code).toBe(0)
    expect(stdout.text).toMatch(/--port/)
    expect(stdout.text).toMatch(/--host/)
  })

  it('serve rejects an invalid --port value with exit code 1', async () => {
    const { io, stderr } = makeIo()
    const code = await runCli(['serve', '--port', 'abc'], io)
    expect(code).toBe(1)
    expect(stderr.text).toMatch(/port/i)
  })

  it('serve boots, prints the listening URL, and shuts down on SIGINT', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'swhsd-cli-serve-'))
    const dbPath = join(workDir, 'c.db')
    const { CollectorDb } = await import('../src/db.js')
    CollectorDb.open(dbPath).close()
    const configPath = join(workDir, 'swhsd.json')
    writeFileSync(
      configPath,
      JSON.stringify({ db: dbPath, apps: {} }),
      'utf8',
    )

    const { io, stderr } = makeIo()
    const promise = runCli(
      ['serve', '--config', configPath, '--host', '127.0.0.1', '--port', '0'],
      io,
    )

    for (let i = 0; i < 50 && !stderr.text.includes('Listening'); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(stderr.text).toMatch(/Listening on http:\/\/127\.0\.0\.1:\d+/)

    process.kill(process.pid, 'SIGINT')
    const code = await promise
    expect(code).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify the new tests fail**

```bash
npx vitest run test/cli.test.ts
```

Expected: the 4 new tests in `runCli serve` fail (`serve` not a known command yet); other tests still pass.

- [ ] **Step 3: Modify `cli-main.ts`**

**3a.** Replace the entire `HELP` constant in `packages/collector/src/cli-main.ts` with:

```ts
export const HELP = `
swhsd-collect — poll statswhatshesaid endpoints and persist results to SQLite.

Usage:
  swhsd-collect [options]                Run one poll cycle (default).
  swhsd-collect init [path]              Write a starter config file.
  swhsd-collect serve [options]          Serve a local dashboard from the DB.

Run options:
  --config <path>   Path to the config file (default: ./swhsd.json or XDG)
  --dry-run         Poll all apps and print results; do NOT write to the DB
  --keep-raw        Also store the full response JSON in snapshots.raw
  --verbose         Log per-request details to stderr

Serve options:
  --config <path>   Path to the config file (used only to discover the DB path)
  --port <n>        Listen port (default: 7878)
  --host <addr>     Bind address (default: 127.0.0.1)

Common:
  --help, -h        Show this help text
  --version, -V     Print the collector version

Exit codes:
  0  success (poll cycle clean, or serve shut down cleanly)
  1  config / flag error
  2  partial poll failure (one or more apps could not be polled)
  3  total failure (DB error, bind error, all apps failed)
`.trim()
```

**3b.** Replace the existing `ParsedArgs` interface and `parseCliArgs` function with:

```ts
interface ParsedArgs {
  command: 'run' | 'init' | 'serve' | 'help' | 'version'
  configPath?: string
  initPath?: string
  dryRun: boolean
  keepRaw: boolean
  verbose: boolean
  host?: string
  port?: number
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const sub = argv[0]
  if (sub === 'help' || argv.includes('--help') || argv.includes('-h')) {
    return { command: 'help', dryRun: false, keepRaw: false, verbose: false }
  }
  if (argv.includes('--version') || argv.includes('-V')) {
    return { command: 'version', dryRun: false, keepRaw: false, verbose: false }
  }

  if (sub === 'init') {
    return {
      command: 'init',
      initPath: argv[1] ?? './swhsd.json',
      dryRun: false,
      keepRaw: false,
      verbose: false,
    }
  }

  if (sub === 'serve') {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        config: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    let port = 7878
    if (values.port != null) {
      const parsed = Number(values.port)
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`invalid --port value: ${values.port}`)
      }
      port = parsed
    }
    return {
      command: 'serve',
      configPath: values.config,
      host: values.host ?? '127.0.0.1',
      port,
      dryRun: false,
      keepRaw: false,
      verbose: false,
    }
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'keep-raw': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  })

  return {
    command: 'run',
    configPath: values.config,
    dryRun: Boolean(values['dry-run']),
    keepRaw: Boolean(values['keep-raw']),
    verbose: Boolean(values.verbose),
  }
}
```

**3c.** Inside `main()`, add this branch immediately before the final `return runCommand(parsed, io)`:

```ts
  if (parsed.command === 'serve') {
    return runServeCommand(parsed, io)
  }
```

**3d.** Append this function at the bottom of `cli-main.ts`:

```ts
async function runServeCommand(parsed: ParsedArgs, io: IoStreams): Promise<number> {
  const discovered = discoverConfig(parsed.configPath)
  let dbPath: string
  try {
    const config = await loadConfig(discovered.path)
    dbPath = config.dbPath
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr.write(`${err.message}\n`)
      return 1
    }
    throw err
  }

  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const { runServe } = await import('./serve-cmd.js')
    return await runServe(
      {
        dbPath,
        host: parsed.host ?? '127.0.0.1',
        port: parsed.port ?? 7878,
        signal: controller.signal,
      },
      io,
    )
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}
```

The `import('./serve-cmd.js')` is dynamic so the run-only path keeps its existing startup cost (no `node:http` loaded until `serve` is invoked).

- [ ] **Step 4: Run the full CLI test file**

```bash
npx vitest run test/cli.test.ts
```

Expected: every test passes, including the 4 new `runCli serve` tests.

- [ ] **Step 5: Commit**

```bash
git add packages/collector/src/cli-main.ts \
        packages/collector/test/cli.test.ts
git commit -m "feat(collector): wire serve subcommand into the CLI"
```

---

## Task 8: README

**Files:**
- Modify: `packages/collector/README.md`

- [ ] **Step 1: Insert a "Serve — local dashboard" section before `## Config reference`**

Open `packages/collector/README.md` and insert this block immediately above the `## Config reference` heading (i.e. after the `**GitHub Actions**` code block that closes the Scheduling section):

````markdown
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
  the DOM API — no `innerHTML` for untrusted values),
- has **no built-in auth** — protect access with the OS (loopback, SSH
  tunnel, reverse proxy) rather than the dashboard itself.

The page shows, per app: today's running count, time since last poll, a
30-day sparkline (zero-filled when polling gaps exist), and a 30-day total.

| Flag | Default | Notes |
| --- | --- | --- |
| `--config <path>` | discovered | Used only to resolve the DB path. The dashboard works even when `apps` is empty. |
| `--host <addr>` | `127.0.0.1` | Set to `0.0.0.0` to expose on the network — combine with a reverse proxy + auth. |
| `--port <n>` | `7878` | TCP port |

````

(Keep everything else in the README intact.)

- [ ] **Step 2: Commit**

```bash
git add packages/collector/README.md
git commit -m "docs(collector): document the serve subcommand"
```

---

## Task 9: Verification pass

**Files:** none modified unless a problem surfaces.

- [ ] **Step 1: Typecheck**

```bash
cd packages/collector && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2: Full test suite**

```bash
npx vitest run
```

Expected: every test passes.

- [ ] **Step 3: Coverage spot-check**

```bash
npx vitest run --coverage --coverage.include='src/serve/**' --coverage.include='src/serve-cmd.ts'
```

Expected: ≥80% line coverage on the new files. If a file is under, add a focused test for the uncovered branch and commit it before continuing.

- [ ] **Step 4: Build the binary**

```bash
npm run build
```

Expected: `dist/cli.js` rebuilt and includes the new serve module. No bundling errors.

- [ ] **Step 5: Smoke-run the binary**

```bash
./dist/cli.js serve --port 0 &
PID=$!
# Give it a beat to bind and print, then stop it.
for i in 1 2 3 4 5; do sleep 0.4; kill -0 $PID 2>/dev/null && break; done
kill -INT $PID
wait $PID
echo "exit=$?"
```

Expected: stderr shows `Listening on http://127.0.0.1:<port>`; final `exit=0`.

- [ ] **Step 6: Final commit only if verification produced edits**

```bash
git status
# If anything is modified, commit it focused, e.g.:
git commit -am "fix(collector): tighten serve coverage edge"
```

---

## Self-Review Notes

- **Spec coverage:**
  - CLI flags (`--port`, `--host`, `--config`) → Task 7 (parsing) + Task 6 (impl).
  - Two routes (`/`, `/api/overview.json`) → Task 5 wiring + Task 4 handlers.
  - 30-day sparkline + zero-fill → Task 1 (path) + Task 4 (zero-fill).
  - Read-only DB → Task 2 (`Queries` ctor takes a handle opened RO in Task 5).
  - Empty state → Task 3 renderer + Task 5 integration test.
  - Graceful shutdown → Task 6 + Task 7.
  - Bind error handling → Task 5 integration test + Task 6 unit test.
  - HTML escaping → Task 3 (`escapeHtml`) used in every server-side interpolation.
  - No `innerHTML` for untrusted data → Task 3 refresh script uses `createElement`/`textContent`; Task 3 has an explicit test that the rendered HTML contains no `innerHTML =` assignment.
  - 80%+ test coverage → Task 9 step 3.
  - All SQL parameterized → Task 2.
- **Placeholders:** none. Every code step contains the full text to write.
- **Type consistency:** `Overview`, `OverviewApp`, `HandlerContext`, `HandlerResponse`, `Queries`, `RunningServer`, `IoStreams`, `runServe` referenced consistently across tasks.
- **Dynamic import:** `cli-main.ts` uses `import('./serve-cmd.js')` so the existing run path keeps its current startup. `tsup` (ESM, `target: node20`) supports this.
