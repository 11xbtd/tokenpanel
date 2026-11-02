export function getByPath(input: unknown, path: string): unknown {
  if (!path) return undefined
  const tokens: Array<string | number> = []
  for (const part of path.split('.')) {
    if (!part) continue
    const re = /([^[\]]+)|\[(\d+)\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(part))) {
      if (m[1] !== undefined) tokens.push(m[1])
      else if (m[2] !== undefined) tokens.push(Number(m[2]))
    }
  }
  let cur: unknown = input
  for (const token of tokens) {
    if (cur === null || cur === undefined) return undefined
    if (typeof token === 'number') {
      if (!Array.isArray(cur)) return undefined
      cur = cur[token]
    } else {
      if (typeof cur !== 'object') return undefined
      cur = (cur as Record<string, unknown>)[token]
    }
  }
  return cur
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/,/g, ''))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function numberValue(value: unknown, fallback = 0): number {
  const parsed = toNumber(value)
  return parsed === null ? fallback : parsed
}

export function toIsoTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const num = toNumber(value)
  if (num !== null) {
    const ms = num < 1_000_000_000_000 ? num * 1000 : num
    return Number.isFinite(ms) ? ms : undefined
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
