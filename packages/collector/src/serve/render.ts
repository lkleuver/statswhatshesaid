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
    if (series.length === 1) {
      var mid = SVG_H / 2;
      return 'M 0 ' + mid + ' L ' + SVG_W + ' ' + mid;
    }
    var values = series.map(function (p) { return p.uniqueVisitors; });
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < values.length; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    var flat = max === min;
    var step = SVG_W / (values.length - 1);
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
  <td class="num">${String(a.total30d)}</td>
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
