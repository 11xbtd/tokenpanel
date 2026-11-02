import { createHash } from 'node:crypto'
import { AppError } from '../errors'
import { toNumber } from '../util/json'
import { jsonRequest } from './http'
import { baseUrlOf, requireAuth, type AdapterContext, type RawUsage, type SnapshotDraft } from './types'

function authHeaders(ctx: AdapterContext): Record<string, string> {
  const token = requireAuth(ctx, 'accessToken', 'Access Token')
  const userId = ctx.account.auth.userId?.trim()
  return {
    Authorization: `Bearer ${token}`,
    ...(userId ? { 'New-Api-User': userId } : {}),
  }
}

function baseOf(ctx: AdapterContext): string {
  const base = baseUrlOf(ctx, '')
  if (!base) throw new AppError('auth', '请先填写中转站 Base URL')
  return base
}

export async function relayBalance(ctx: AdapterContext): Promise<SnapshotDraft> {
  const base = baseOf(ctx)
  const { data } = await jsonRequest<any>(ctx.fetch, {
    url: `${base}/api/user/self`,
    headers: authHeaders(ctx),
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  if (data.success === false) throw new AppError('upstream', String(data.message ?? '中转站返回失败'))
  const row = data.data && typeof data.data === 'object' ? data.data : data
  const quota = toNumber(row.quota)
  if (quota === null) throw new AppError('upstream', '未返回 quota 字段，可能不是 New API / One API')
  const unit = ctx.quotaPerUnit || 500000
  const used = toNumber(row.used_quota) ?? 0
  return {
    status: 'ok',
    kind: 'relay',
    source: 'official',
    currency: 'USD',
    balance: quota / unit,
    usage: { costUsd: used / unit, requests: toNumber(row.request_count) ?? 0 },
    planLabel: '中转站余额',
    extras: {
      used: used / unit,
      requests: toNumber(row.request_count) ?? 0,
      quotaPerUnit: unit,
    },
  }
}

function cacheTokensOf(row: Record<string, any>): { read: number; write: number } {
  const other = row.other
  if (other === null || other === undefined) return { read: 0, write: 0 }
  let parsed: Record<string, any> | undefined
  if (typeof other === 'string') {
    try {
      parsed = JSON.parse(other)
    } catch {
      return { read: 0, write: 0 }
    }
  } else if (typeof other === 'object') {
    parsed = other
  }
  if (!parsed) return { read: 0, write: 0 }
  const read =
    toNumber(parsed.cache_read_tokens) ??
    toNumber(parsed.cache_read_input_tokens) ??
    toNumber(parsed.cache_tokens) ??
    0
  const write = toNumber(parsed.cache_creation_input_tokens) ?? toNumber(parsed.cache_write_tokens) ?? 0
  return { read, write }
}

export async function relayUsage(ctx: AdapterContext, since: number): Promise<RawUsage[]> {
  const base = baseOf(ctx)
  const unit = ctx.quotaPerUnit || 500000
  const startTimestamp = Math.floor(since / 1000)
  const records: RawUsage[] = []
  for (let page = 1; page <= 20; page++) {
    const url = new URL(`${base}/api/log/self`)
    url.searchParams.set('p', String(page))
    url.searchParams.set('page_size', '100')
    url.searchParams.set('type', '2')
    url.searchParams.set('start_timestamp', String(startTimestamp))
    const { data } = await jsonRequest<any>(ctx.fetch, {
      url: url.toString(),
      headers: authHeaders(ctx),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    })
    if (data.success === false) throw new AppError('upstream', String(data.message ?? '日志接口返回失败'))
    const payload = data.data
    const items: any[] = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : []
    const total = toNumber(payload?.total) ?? null
    if (items.length === 0) break
    for (const row of items) {
      if (toNumber(row.type) !== 2) continue
      const createdAt = toNumber(row.created_at)
      if (createdAt === null) continue
      const ts = createdAt < 1_000_000_000_000 ? createdAt * 1000 : createdAt
      if (ts < since) continue
      const model = typeof row.model_name === 'string' && row.model_name ? row.model_name : 'unknown'
      const quota = toNumber(row.quota) ?? 0
      const cache = cacheTokensOf(row)
      const externalId = row.id !== undefined && row.id !== null ? `newapi:${row.id}` : `newapi:${createHash('sha1').update(`${ts}|${model}|${quota}|${row.prompt_tokens}|${row.completion_tokens}`).digest('hex').slice(0, 16)}`
      records.push({
        ts,
        model,
        inputTokens: toNumber(row.prompt_tokens) ?? 0,
        outputTokens: toNumber(row.completion_tokens) ?? 0,
        cacheReadTokens: cache.read,
        cacheWriteTokens: cache.write,
        reasoningTokens: 0,
        costUsdMicros: Math.round((quota / unit) * 1_000_000),
        costEstimated: false,
        nativeCost: quota / unit,
        nativeCurrency: 'USD',
        source: 'relay-log',
        externalId,
        meta: { provider: 'newapi' },
      })
    }
    if (total !== null && page * 100 >= total) break
    if (items.length < 100) break
  }
  return records
}
