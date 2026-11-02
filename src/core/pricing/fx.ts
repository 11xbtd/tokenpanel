const ENDPOINTS = [
  'https://api.frankfurter.app/latest?from=USD&to=CNY',
  'https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY',
]

export async function fetchUsdCny(fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<number | null> {
  for (const url of ENDPOINTS) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) continue
      const body = (await response.json()) as { rates?: Record<string, number> }
      const rate = body.rates?.CNY
      if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) return rate
    } catch {
      // 下一源
    }
  }
  return null
}
