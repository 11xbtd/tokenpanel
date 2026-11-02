import { useMemo } from 'react'

export function Sparkline({
  values,
  color,
  width = 120,
  height = 40,
}: {
  values: number[]
  color: string
  width?: number
  height?: number
}) {
  const points = useMemo(() => {
    const max = Math.max(...values, 0.000001)
    const count = Math.max(1, values.length - 1)
    const line = values.map((value, index) => `${(index / count) * width},${height - (value / max) * (height - 6) - 3}`)
    return { line: line.join(' '), area: `0,${height} ${line.join(' ')} ${width},${height}` }
  }, [values, width, height])
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polygon points={points.area} fill={color} opacity={0.07} />
      <polyline points={points.line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

export function colorFor(id: string, palette: string[]): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return palette[hash % palette.length]
}
