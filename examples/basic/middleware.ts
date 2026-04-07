import stats from 'statswhatshesaid'

export default stats.middleware()

export const config = {
  // Match everything except Next internals and static files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
  // REQUIRED: this library uses node:crypto and node:fs, which are not
  // available in the Next.js Edge runtime. Opt into the Node runtime here.
  runtime: 'nodejs',
}
