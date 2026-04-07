import stats from '@statswhatshesaid/next'

export default stats.middleware()

export const config = {
  // Match everything except Next internals and static files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
  // REQUIRED: this library uses node:crypto, node:fs, and better-sqlite3.
  // Next.js middleware defaults to the Edge runtime which cannot run them.
  runtime: 'nodejs',
}
