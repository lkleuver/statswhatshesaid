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
