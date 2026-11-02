import { AppError } from '../errors'
import { DAY_MS, dateKey } from '../util/time'
import { toNumber } from '../util/json'
import { jsonRequest } from './http'
import { baseUrlOf, requireAuth, type AdapterContext, type RawUsage } from './types'

interface RecordAccumulator {
  ts: number
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  externalId: string
}

async function fetchOpenAiUsageBuckets(ctx: AdapterContext, start: number, end: number): Promise<any[]> {
  const key = requireAuth(ctx, 'adminKey', 'Admin Key')
  const base = baseUrlOf(ctx, 'https://api.openai.com')
  const buckets: any[] = []
  let page: string | undefined
  for (let i = 0; i < 12; i++) {
    const url = new URL(`${base}/v1/organization/usage/completions`)
    url.searchParams.set('start_time', String(start))
    url.searchParams.set('end_time', String(end))
    url.searchParams.set('bucket_width', '1d')
    url.searchParams.set('limit', '31')
    url.searchParams.set('group_by', 'model')
    if (page) url.searchParams.set('page', page)
    const { data } = await jsonRequest<any>(ctx.fetch, {
      url: url.toString(),
      headers: { Authorization: `Bearer ${key}` },
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    })
    buckets.push(...(Array.isArray(data.data) ? data.data : []))
    page = data.has_more && typeof data.next_page === 'string' ? data.next_page : undefined
    if (!page) break
  }
  return buckets
}

async function fetchOpenAiDailyCost(ctx: AdapterContext, start: number, end: number): Promise<Map<string, number>> {
  const key = requireAuth(ctx, 'adminKey', 'Admin Key')
  const base = baseUrlOf(ctx, 'https://api.openai.com')
  const byDay = new Map<string, number>()
  let page: string | undefined
  try {
    for (let i = 0; i < 12; i++) {
      const url = new URL(`${base}/v1/organization/costs`)
      url.searchParams.set('start_time', String(start))
      url.searchParams.set('end_time', String(end))
      url.searchParams.set('bucket_width', '1d')
      url.searchParams.set('limit', '31')
      if (page) url.searchParams.set('page', page)
      const { data } = await jsonRequest<any>(ctx.fetch, {
        url: url.toString(),
        headers: { Authorization: `Bearer ${key}` },
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
      })
      for (const bucket of Array.isArray(data.data) ? data.data : []) {
        const ts = toNumber(bucket.start_time)
        if (ts === null) continue
        const day = dateKey(ts * 1000)
        let total = 0
        for (const row of Array.isArray(bucket.results) ? bucket.results : []) {
          total += toNumber(row.amount?.value) ?? 0
        }
        byDay.set(day, (byDay.get(day) ?? 0) + total)
      }
      page = data.has_more && typeof data.next_page === 'string' ? data.next_page : undefined
      if (!page) break
    }
  } catch {
    return new Map()
  }
  return byDay
}

function accumulate(map: Map<string, RecordAccumulator>, row: RecordAccumulator): void {
  const key = `${row.ts}:${row.model}`
  const current = map.get(key)
  if (current) {
    current.input += row.input
    current.output += row.output
    current.cacheRead += row.cacheRead
    current.cacheWrite += row.cacheWrite
  } else {
    map.set(key, { ...row })
  }
}

function finalize(
  ctx: AdapterContext,
  map: Map<string, RecordAccumulator>,
  source: RawUsage['source'],
  providerTag: string,
  dailyCost: Map<string, number>,
  costCurrency: string,
): RawUsage[] {
  const records: RawUsage[] = []
  for (const row of map.values()) {
    const estimate = ctx.pricing.estimateCost({
      model: row.model,
      providerId: ctx.account.providerId,
      inputTokens: row.input,
      outputTokens: row.output,
      cacheReadTokens: row.cacheRead,
      cacheWriteTokens: row.cacheWrite,
    })
    records.push({
      ts: row.ts,
      model: row.model,
      inputTokens: row.input,
      outputTokens: row.output,
      cacheReadTokens: row.cacheRead,
      cacheWriteTokens: row.cacheWrite,
      reasoningTokens: 0,
      costUsdMicros: estimate.usdMicros,
      costEstimated: true,
      nativeCurrency: costCurrency,
      source,
      externalId: row.externalId,
      meta: {
        ...(estimate.matchKey ? { priceMatch: estimate.matchKey } : {}),
        ...(estimate.missingPrice ? { priceMissing: 1 } : {}),
        provider: providerTag,
      },
    })
  }

  const byDay = new Map<string, RawUsage[]>()
  for (const record of records) {
    const day = dateKey(record.ts)
    const list = byDay.get(day) ?? []
    list.push(record)
    byDay.set(day, list)
  }
  for (const [day, list] of byDay) {
    const actual = dailyCost.get(day)
    if (actual === undefined || actual <= 0) continue
    const estimated = list.reduce((total, record) => total + (record.costUsdMicros ?? 0), 0)
    if (estimated <= 0) continue
    const factor = (actual * 1_000_000) / estimated
    for (const record of list) {
      record.costUsdMicros = Math.round((record.costUsdMicros ?? 0) * factor)
      record.costEstimated = false
      record.meta = { ...(record.meta ?? {}), costBasis: `${costCurrency} daily cost report` }
    }
  }
  return records
}

export async function openaiUsage(ctx: AdapterContext, since: number): Promise<RawUsage[]> {
  const end = Math.floor(ctx.now / 1000)
  const start = Math.floor(Math.max(since, ctx.now - 30 * DAY_MS) / 1000)
  const buckets = await fetchOpenAiUsageBuckets(ctx, start, end)
  const costs = await fetchOpenAiDailyCost(ctx, start, end)
  const map = new Map<string, RecordAccumulator>()
  for (const bucket of buckets) {
    const ts = toNumber(bucket.start_time)
    if (ts === null) continue
    for (const row of Array.isArray(bucket.results) ? bucket.results : []) {
      const inputTotal = toNumber(row.input_tokens) ?? 0
      const cached = toNumber(row.input_cached_tokens) ?? 0
      const model = typeof row.model === 'string' && row.model ? row.model : 'unknown'
      accumulate(map, {
        ts: ts * 1000,
        model,
        input: Math.max(0, inputTotal - cached),
        output: toNumber(row.output_tokens) ?? 0,
        cacheRead: cached,
        cacheWrite: 0,
        externalId: `openai:${ts}:${model}`,
      })
    }
  }
  if (map.size === 0 && buckets.length === 0) {
    throw new AppError('upstream', '未返回用量数据（请确认 Admin Key 权限与时间范围）')
  }
  return finalize(ctx, map, 'admin-api', 'openai', costs, 'USD')
}

async function fetchAnthropicUsageBuckets(ctx: AdapterContext, start: string, end: string): Promise<any[]> {
  const key = requireAuth(ctx, 'adminKey', 'Admin Key')
  const base = baseUrlOf(ctx, 'https://api.anthropic.com')
  const buckets: any[] = []
  let page: string | undefined
  for (let i = 0; i < 12; i++) {
    const url = new URL(`${base}/v1/organizations/usage_report/messages`)
    url.searchParams.set('starting_at', start)
    url.searchParams.set('ending_at', end)
    url.searchParams.set('bucket_width', '1d')
    url.searchParams.set('limit', '31')
    url.searchParams.append('group_by[]', 'model')
    if (page) url.searchParams.set('page', page)
    const { data } = await jsonRequest<any>(ctx.fetch, {
      url: url.toString(),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    })
    buckets.push(...(Array.isArray(data.data) ? data.data : []))
    page = data.has_more && typeof data.next_page === 'string' ? data.next_page : undefined
    if (!page) break
  }
  return buckets
}

async function fetchAnthropicDailyCost(ctx: AdapterContext, start: string, end: string): Promise<Map<string, number>> {
  const key = requireAuth(ctx, 'adminKey', 'Admin Key')
  const base = baseUrlOf(ctx, 'https://api.anthropic.com')
  const byDay = new Map<string, number>()
  try {
    const url = new URL(`${base}/v1/organizations/cost_report`)
    url.searchParams.set('starting_at', start)
    url.searchParams.set('ending_at', end)
    url.searchParams.set('limit', '31')
    const { data } = await jsonRequest<any>(ctx.fetch, {
      url: url.toString(),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    })
    for (const bucket of Array.isArray(data.data) ? data.data : []) {
      const ts = toIsoTimestampSafe(bucket.starting_at ?? bucket.start_time ?? bucket.bucket_start_time)
      if (!ts) continue
      let totalCents = 0
      for (const row of Array.isArray(bucket.results) ? bucket.results : []) {
        totalCents += toNumber(row.amount?.value) ?? 0
      }
      const day = dateKey(ts)
      byDay.set(day, (byDay.get(day) ?? 0) + totalCents / 100)
    }
  } catch {
    return new Map()
  }
  return byDay
}

function toIsoTimestampSafe(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const num = toNumber(value)
  if (num === null) return undefined
  return num < 1_000_000_000_000 ? num * 1000 : num
}

export async function anthropicUsage(ctx: AdapterContext, since: number): Promise<RawUsage[]> {
  const startMs = Math.max(since, ctx.now - 30 * DAY_MS)
  const start = new Date(startMs).toISOString()
  const end = new Date(ctx.now).toISOString()
  const buckets = await fetchAnthropicUsageBuckets(ctx, start, end)
  const costs = await fetchAnthropicDailyCost(ctx, start, end)
  const map = new Map<string, RecordAccumulator>()
  for (const bucket of buckets) {
    const ts = toIsoTimestampSafe(bucket.starting_at ?? bucket.start_time)
    if (!ts) continue
    for (const row of Array.isArray(bucket.results) ? bucket.results : []) {
      const cacheWrite =
        toNumber(row.cache_creation_input_tokens) ??
        (toNumber(row.cache_creation?.ephemeral_5m_input_tokens) ?? 0) +
          (toNumber(row.cache_creation?.ephemeral_1h_input_tokens) ?? 0)
      const model = typeof row.model === 'string' && row.model ? row.model : 'unknown'
      accumulate(map, {
        ts,
        model,
        input: toNumber(row.uncached_input_tokens) ?? toNumber(row.input_tokens) ?? 0,
        output: toNumber(row.output_tokens) ?? 0,
        cacheRead: toNumber(row.cache_read_input_tokens) ?? 0,
        cacheWrite,
        externalId: `anthropic:${bucket.starting_at ?? bucket.start_time}:${model}`,
      })
    }
  }
  if (map.size === 0 && buckets.length === 0) {
    throw new AppError('upstream', '未返回用量数据（请确认 Admin Key 权限与时间范围）')
  }
  return finalize(ctx, map, 'admin-api', 'anthropic', costs, 'USD')
}
