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
  const path = (req.url ?? '/').split('?')[0] ?? '/'
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
