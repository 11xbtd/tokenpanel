import { AppError } from '../errors'
import { jsonRequest } from './http'
import { baseUrlOf, requireAuth, type AdapterContext, type SnapshotDraft } from './types'
import { toNumber } from '../util/json'

function done(input: Omit<SnapshotDraft, 'status' | 'kind' | 'source'> & { kind?: SnapshotDraft['kind'] }): SnapshotDraft {
  return {
    status: 'ok',
    kind: input.kind ?? 'balance',
    source: 'official',
    ...input,
  }
}

export async function deepseekBalance(ctx: AdapterContext): Promise<SnapshotDraft> {
  const key = requireAuth(ctx, 'apiKey', 'API Key')
  const base = baseUrlOf(ctx, 'https://api.deepseek.com')
  const { data } = await jsonRequest<{
    is_available?: boolean
    balance_infos?: Array<{
      currency?: string
      total_balance?: string | number
      granted_balance?: string | number
      topped_up_balance?: string | number
    }>
  }>(ctx.fetch, {
    url: `${base}/user/balance`,
    headers: { Authorization: `Bearer ${key}` },
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
  const primary = infos.find((info) => String(info.currency).toUpperCase() === 'CNY') ?? infos[0]
  const balance = toNumber(primary?.total_balance)
  if (balance === null) throw new AppError('upstream', '未返回余额信息')
  return done({
    currency: String(primary?.currency ?? 'CNY').toUpperCase(),
    balance,
    extras: {
      available: data.is_available ? 1 : 0,
      granted: toNumber(primary?.granted_balance) ?? 0,
      toppedUp: toNumber(primary?.topped_up_balance) ?? 0,
      accounts: infos.length,
    },
  })
}

export async function kimiBalance(ctx: AdapterContext): Promise<SnapshotDraft> {
  const key = requireAuth(ctx, 'apiKey', 'API Key')
  const base = baseUrlOf(ctx, 'https://api.moonshot.cn')
  const { data } = await jsonRequest<{
    data?: { available_balance?: string | number; voucher_balance?: string | number; cash_balance?: string | number }
  }>(ctx.fetch, {
    url: `${base}/v1/users/me/balance`,
    headers: { Authorization: `Bearer ${key}` },
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  const row = data.data ?? {}
  const balance = toNumber(row.available_balance)
  if (balance === null) throw new AppError('upstream', '未返回余额信息')
  return done({
    currency: ctx.account.providerId === 'kimi-global' ? 'USD' : 'CNY',
    balance,
    extras: {
      voucher: toNumber(row.voucher_balance) ?? 0,
      cash: toNumber(row.cash_balance) ?? 0,
    },
  })
}

export async function stepfunBalance(ctx: AdapterContext): Promise<SnapshotDraft> {
  const key = requireAuth(ctx, 'apiKey', 'API Key')
  const base = baseUrlOf(ctx, 'https://api.stepfun.com')
  const { data } = await jsonRequest<Record<string, unknown>>(ctx.fetch, {
    url: `${base}/v1/accounts`,
    headers: { Authorization: `Bearer ${key}` },
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  const row = (data.data && typeof data.data === 'object' ? data.data : data) as Record<string, unknown>
  const direct = toNumber(row.balance)
  const cash = toNumber(row.total_cash_balance) ?? 0
  const voucher = toNumber(row.total_voucher_balance) ?? 0
  const balance = direct ?? cash + voucher
  if (!Number.isFinite(balance)) throw new AppError('upstream', '未返回余额信息')
  return done({
    currency: String(row.currency ?? 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY',
    balance,
    extras: { cash, voucher },
  })
}

export async function ai302Balance(ctx: AdapterContext): Promise<SnapshotDraft> {
  const key = requireAuth(ctx, 'apiKey', 'API Key')
  const base = baseUrlOf(ctx, 'https://api.302.ai')
  const { data } = await jsonRequest<Record<string, unknown>>(ctx.fetch, {
    url: `${base}/dashboard/balance`,
    headers: { Authorization: `Bearer ${key}` },
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  const row = (data.data && typeof data.data === 'object' ? data.data : data) as Record<string, unknown>
  const balance = toNumber(row.balance)
  if (balance === null) throw new AppError('upstream', '未返回余额信息')
  return done({ currency: 'USD', balance })
}

export async function aihubmixBalance(ctx: AdapterContext): Promise<SnapshotDraft> {
  const token = requireAuth(ctx, 'systemToken', 'System Access Token')
  const base = baseUrlOf(ctx, 'https://aihubmix.com')
  const { data } = await jsonRequest<Record<string, unknown>>(ctx.fetch, {
    url: `${base}/api/user/self`,
    headers: { Authorization: token },
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  const row = (data.data && typeof data.data === 'object' ? data.data : data) as Record<string, unknown>
  const quota = toNumber(row.quota)
  const used = toNumber(row.used_quota) ?? 0
  if (quota === null) throw new AppError('upstream', '未返回 quota 字段')
  const unit = ctx.quotaPerUnit || 500000
  return done({
    currency: 'USD',
    balance: quota / unit,
    extras: { used: used / unit, requests: toNumber(row.request_count) ?? 0 },
  })
}

export async function novitaBalance(ctx: AdapterContext): Promise<SnapshotDraft> {
  const key = requireAuth(ctx, 'apiKey', 'API Key')
  const base = baseUrlOf(ctx, 'https://api.novita.ai')
  const { data } = await jsonRequest<Record<string, unknown>>(ctx.fetch, {
    url: `${base}/openapi/v1/billing/balance/detail`,
    headers: { Authorization: `Bearer ${key}` },
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  const row = (data.data && typeof data.data === 'object' ? data.data : data) as Record<string, unknown>
  const available = toNumber(row.availableBalance) ?? toNumber(row.cashBalance)
  if (available === null) throw new AppError('upstream', '未返回余额信息')
  return done({
    currency: 'USD',
    balance: available / 10000,
    extras: {
      cash: (toNumber(row.cashBalance) ?? 0) / 10000,
      creditLimit: (toNumber(row.creditLimit) ?? 0) / 10000,
      pendingCharges: (toNumber(row.pendingCharges) ?? 0) / 10000,
    },
  })
}

export async function openrouterBalance(ctx: AdapterContext): Promise<SnapshotDraft> {
  const managementKey = ctx.account.auth.managementKey?.trim()
  const apiKey = ctx.account.auth.apiKey?.trim()
  const base = baseUrlOf(ctx, 'https://openrouter.ai')

  if (managementKey) {
    const { data } = await jsonRequest<{ data?: { total_credits?: number; total_usage?: number } }>(ctx.fetch, {
      url: `${base}/api/v1/credits`,
      headers: { Authorization: `Bearer ${managementKey}` },
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    })
    const row = data.data ?? {}
    const credits = toNumber(row.total_credits)
    const usage = toNumber(row.total_usage) ?? 0
    if (credits === null) throw new AppError('upstream', '未返回 credits 信息')
    return done({
      currency: 'USD',
      balance: credits - usage,
      usage: { costUsd: usage },
      planLabel: '账户余额',
      extras: { totalCredits: credits, totalUsage: usage },
    })
  }

  if (!apiKey) throw new AppError('auth', '请至少配置 Management Key 或 API Key')
  const { data } = await jsonRequest<{
    data?: { limit?: number | null; usage?: number; limit_remaining?: number | null; is_free_tier?: boolean; label?: string }
  }>(ctx.fetch, {
    url: `${base}/api/v1/key`,
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  const row = data.data ?? {}
  const usage = toNumber(row.usage) ?? 0
  const limit = toNumber(row.limit)
  const remaining = toNumber(row.limit_remaining) ?? (limit !== null ? limit - usage : null)
  const windows =
    limit !== null && limit > 0
      ? [
          {
            key: 'key',
            label: 'Key 限额',
            used: usage,
            total: limit,
            unit: 'USD',
            usedPct: Math.min(100, Math.max(0, (usage / limit) * 100)),
            remainingPct: Math.max(0, 100 - Math.min(100, (usage / limit) * 100)),
          },
        ]
      : undefined
  return done({
    currency: 'USD',
    balance: remaining ?? undefined,
    windows,
    usage: { costUsd: usage },
    planLabel: row.label || (limit === null ? '无额度上限' : 'Key 限额'),
    extras: { isFreeTier: row.is_free_tier ? 1 : 0, limit: limit ?? -1, usage },
  })
}

export async function xaiBalance(ctx: AdapterContext): Promise<SnapshotDraft> {
  const key = requireAuth(ctx, 'managementKey', 'Management Key')
  const teamId = requireAuth(ctx, 'teamId', 'Team ID')
  const base = baseUrlOf(ctx, 'https://management-api.x.ai')
  const { data } = await jsonRequest<Record<string, unknown>>(ctx.fetch, {
    url: `${base}/v1/billing/teams/${encodeURIComponent(teamId)}/prepaid/balance`,
    headers: { Authorization: `Bearer ${key}` },
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  const row = (data.data && typeof data.data === 'object' ? data.data : data) as Record<string, any>
  const cents = toNumber(row.total?.val) ?? toNumber(row.total) ?? toNumber(row.balance)
  if (cents === null) throw new AppError('upstream', '未返回 prepaid balance')
  return done({ currency: 'USD', balance: cents / 100, extras: { rawTotal: cents } })
}
