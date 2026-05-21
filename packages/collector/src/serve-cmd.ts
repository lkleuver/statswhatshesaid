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
    io.stderr.write(`swhsd-collect serve: ${opts.dbPath}: ${(err as Error).message}\n`)
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
