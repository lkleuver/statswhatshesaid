import type { PollResponse } from './types.js'

export interface PollOptions {
  url: string
  token: string
  timeoutMs: number
  userAgent: string
  /** Append `?format=raw` so the library returns the raw HLL sketch. */
  raw?: boolean
}

/**
 * GET /stats from a single endpoint with a bearer token. Throws `PollError`
 * for any networking, HTTP, or parsing problem so the caller can decide
 * whether to mark a cycle FAILED.
 */
export async function pollOne(opts: PollOptions): Promise<PollResponse> {
  const url = opts.raw ? appendQuery(opts.url, 'format', 'raw') : opts.url

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${opts.token}`,
        'user-agent': opts.userAgent,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  } catch (err) {
    throw new PollError(
      `GET ${url} failed: ${(err as Error).message}`,
      { url, cause: err as Error },
    )
  }

  if (!res.ok) {
    throw new PollError(`GET ${url} returned ${res.status}`, {
      url,
      status: res.status,
    })
  }

  let body: PollResponse
  try {
    body = (await res.json()) as PollResponse
  } catch (err) {
    throw new PollError(`Response from ${url} was not valid JSON: ${(err as Error).message}`, {
      url,
    })
  }

  if (!body || typeof body !== 'object') {
    throw new PollError(`Response from ${url} is not an object`, { url })
  }
  if (!body.today || typeof body.today.uniqueVisitors !== 'number') {
    throw new PollError(`Response from ${url} is missing today.uniqueVisitors`, { url })
  }
  if (!Array.isArray(body.history)) {
    throw new PollError(`Response from ${url} is missing history[]`, { url })
  }
  return body
}

function appendQuery(url: string, key: string, value: string): string {
  const u = new URL(url)
  u.searchParams.set(key, value)
  return u.toString()
}

export interface PollErrorDetails {
  url: string
  status?: number
  cause?: Error
}

export class PollError extends Error {
  override readonly name = 'PollError'
  readonly url: string
  readonly status?: number
  constructor(message: string, details: PollErrorDetails) {
    super(message, { cause: details.cause })
    this.url = details.url
    this.status = details.status
  }
}
