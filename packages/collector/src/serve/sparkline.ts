/**
 * Convert a numeric series into an SVG `d` attribute string for a polyline
 * sparkline. Pure; no DOM, no XML escaping concerns (digits and spaces only).
 *
 * When all values are equal (or there is exactly one), the line is rendered
 * at the vertical midpoint of the box so it stays visually centered.
 */
export function buildSparklinePath(
  values: readonly number[],
  width: number,
  height: number,
): string {
  if (values.length === 0) return ''
  if (values.length === 1) {
    const mid = round(height / 2)
    return `M 0 ${mid} L ${width} ${mid}`
  }

  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min
  const flat = range === 0

  const stepX = width / (values.length - 1)
  const segments: string[] = []
  for (let i = 0; i < values.length; i++) {
    const x = round(i * stepX)
    const y = flat
      ? round(height / 2)
      : round(height - ((values[i] - min) / range) * height)
    segments.push(i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`)
  }
  return segments.join(' ')
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
