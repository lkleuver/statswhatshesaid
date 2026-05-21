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
