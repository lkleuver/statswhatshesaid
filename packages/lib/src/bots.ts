export const BOT_UA_RE =
  /bot|crawler|spider|crawling|facebookexternalhit|slurp|mediapartners|ahrefs|semrush|bingpreview|headlesschrome|lighthouse|curl|wget|python-requests|node-fetch|axios|httpclient|java\//i

export function isBot(ua: string | null | undefined): boolean {
  if (!ua) return true
  return BOT_UA_RE.test(ua)
}
