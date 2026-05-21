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
