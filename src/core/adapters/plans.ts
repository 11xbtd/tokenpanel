import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppError } from '../errors'
import type { QuotaWindow } from '../types'
import { toIsoTimestamp, toNumber } from '../util/json'
import { jsonRequest } from './http'
import { baseUrlOf, requireAuth, type AdapterContext, type SnapshotDraft } from './types'

function toWindow(input: {
  key: string
  label: string
  used?: number | null
  total?: number | null
  usedPct?: number | null
  unit?: string
  resetsAt?: number
}): QuotaWindow | null {
  let usedPct = input.usedPct ?? null
  if (usedPct === null && input.used !== undefined && input.used !== null && input.total && input.total > 0) {
    usedPct = (input.used / input.total) * 100
  }
  if (usedPct === null || !Number.isFinite(usedPct)) return null
  const clamped = Math.min(100, Math.max(0, usedPct))
  return {
    key: input.key,
    label: input.label,
    used: input.used ?? undefined,
    total: input.total ?? undefined,
    unit: input.unit,
    usedPct: clamped,
    remainingPct: 100 - clamped,
    resetsAt: input.resetsAt,
  }
}

function fromRemaining(
  key: string,
  label: string,
  remainingRaw: unknown,
  resetsAt?: number,
  unit?: string,
): QuotaWindow | null {
  const remaining = toNumber(remainingRaw)
  if (remaining === null) return null
  const clamped = Math.min(100, Math.max(0, remaining))
  return {
    key,
    label,
    unit,
    usedPct: 100 - clamped,
    remainingPct: clamped,
    resetsAt,
  }
}

function planDone(windows: QuotaWindow[], extras?: Record<string, string | number>, planLabel?: string): SnapshotDraft {
  return {
    status: 'ok',
    kind: 'plan',
    source: 'unofficial',
    windows,
    planLabel,
    extras: { interface: '非官方接口', ...(extras ?? {}) },
  }
}

async function zaiLike(ctx: AdapterContext, fallbackBase: string): Promise<SnapshotDraft> {
  const key = requireAuth(ctx, 'apiKey', 'API Key')
  const base = baseUrlOf(ctx, fallbackBase)
  const { data } = await jsonRequest<Record<string, any>>(ctx.fetch, {
    url: `${base}/api/monitor/usage/quota/limit`,
    headers: {
      Authorization: key,
      Accept: 'application/json',
      'Accept-Language': 'en-US,en',
    },
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  const code = toNumber(data.code)
  if (code === 401 || code === 403) throw new AppError('auth', 'Key 被拒绝，请检查权限')
  if (data.success === false) throw new AppError('upstream', '接口返回失败状态')
  const payload = (data.data && typeof data.data === 'object' ? data.data : data) as Record<string, any>
  const limits = Array.isArray(payload.limits) ? payload.limits : []
  const windows: QuotaWindow[] = []
  for (const limit of limits) {
    if (!limit || typeof limit !== 'object') continue
    if (limit.type !== 'CREDIT_LIMIT' && limit.type !== 'TOKENS_LIMIT') continue
    const unit = toNumber(limit.unit)
    const count = toNumber(limit.number)
    let key = ''
    let label = ''
    if (unit === 3 && count === 5) {
      key = '5h'
      label = '5 小时'
    } else if (unit === 6 && count === 1) {
      key = 'week'
      label = '每周'
    } else {
      continue
    }
    const percentage = toNumber(limit.percentage)
    const used = toNumber(limit.currentValue) ?? toNumber(limit.used)
    const total = toNumber(limit.usage) ?? toNumber(limit.total)
    const window = toWindow({
      key,
      label,
      used,
      total,
      usedPct: percentage,
      resetsAt: toIsoTimestamp(limit.nextResetTime),
    })
    if (window) windows.push(window)
  }
  if (windows.length === 0) throw new AppError('upstream', '未返回可识别的额度窗口，接口可能已变更')
  windows.sort((a, b) => (a.key === '5h' ? -1 : 1) - (b.key === '5h' ? -1 : 1))
  const level =
    typeof payload.level === 'string'
      ? payload.level
          .replace(/_/g, ' ')
          .toLowerCase()
          .replace(/(^|\s)\w/g, (match) => match.toUpperCase())
      : undefined
  return planDone(windows, undefined, level)
}

export function glmPlan(ctx: AdapterContext): Promise<SnapshotDraft> {
  return zaiLike(ctx, 'https://open.bigmodel.cn')
}

export function zaiPlan(ctx: AdapterContext): Promise<SnapshotDraft> {
  return zaiLike(ctx, 'https://api.z.ai')
}

/** MiniMax 与千问 Token Plan共用 /v1/token_plan/remains 形状，仅鉴权字段与默认 Base URL 不同。 */
async function tokenPlanRemains(
  ctx: AdapterContext,
  opts: { authKey: string; authLabel: string; fallbackBase: string; planLabel: string },
): Promise<SnapshotDraft> {
  const key = requireAuth(ctx, opts.authKey, opts.authLabel)
  const base = baseUrlOf(ctx, opts.fallbackBase)
  const { data } = await jsonRequest<Record<string, any>>(ctx.fetch, {
    url: `${base}/v1/token_plan/remains`,
    headers: { Authorization: `Bearer ${key}` },
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  const statusCode = toNumber(data.base_resp?.status_code)
  if (statusCode !== null && statusCode !== 0) {
    throw new AppError('upstream', String(data.base_resp?.status_msg ?? 'Token Plan 接口返回失败'))
  }
  const rows = (Array.isArray(data.model_remains) ? data.model_remains : Array.isArray(data.data?.model_remains) ? data.data.model_remains : []) as any[]
  const windows: QuotaWindow[] = []
  for (const row of rows) {
    const model = typeof row.model_name === 'string' && row.model_name && row.model_name !== 'general' ? row.model_name : undefined
    let intervalReset = toIsoTimestamp(row.end_time)
    if (!intervalReset) {
      const remains = toNumber(row.remains_time)
      if (remains !== null && remains > 0 && remains < 7 * 86_400_000) intervalReset = ctx.now + remains
    }
    let weeklyReset = toIsoTimestamp(row.weekly_end_time)
    if (!weeklyReset) {
      const remains = toNumber(row.weekly_remains_time)
      if (remains !== null && remains > 0 && remains < 30 * 86_400_000) weeklyReset = ctx.now + remains
    }

    // Coding Plan 返回的是剩余百分比，计数字段可能全为 0；百分比优先。
    const intervalByPercent = fromRemaining(
      `${model ?? 'general'}:5h`,
      model ? `${model} · 5 小时` : '5 小时',
      row.current_interval_remaining_percent,
      intervalReset,
    )
    const weeklyByPercent = fromRemaining(
      `${model ?? 'general'}:week`,
      model ? `${model} · 每周` : '每周',
      row.current_weekly_remaining_percent,
      weeklyReset,
    )

    if (intervalByPercent) windows.push(intervalByPercent)
    else {
      const total = toNumber(row.current_interval_total_count)
      const used = toNumber(row.current_interval_usage_count)
      const window = toWindow({
        key: `${model ?? 'general'}:5h`,
        label: model ? `${model} · 5 小时` : '5 小时',
        used,
        total,
        unit: '次',
        resetsAt: intervalReset,
      })
      if (window) windows.push(window)
    }

    if (weeklyByPercent) windows.push(weeklyByPercent)
    else {
      const weeklyTotal = toNumber(row.current_weekly_total_count)
      const weeklyUsed = toNumber(row.current_weekly_usage_count)
      const window = toWindow({
        key: `${model ?? 'general'}:week`,
        label: model ? `${model} · 每周` : '每周',
        used: weeklyUsed,
        total: weeklyTotal,
        unit: '次',
        resetsAt: weeklyReset,
      })
      if (window) windows.push(window)
    }
  }
  if (windows.length === 0) throw new AppError('upstream', '未返回 Token Plan 额度，字段可能已变更')
  return planDone(windows, undefined, opts.planLabel)
}

export function minimaxPlan(ctx: AdapterContext): Promise<SnapshotDraft> {
  return tokenPlanRemains(ctx, { authKey: 'planKey', authLabel: '订阅 Key', fallbackBase: 'https://api.minimaxi.com', planLabel: 'Token Plan' })
}

export async function claudePlan(ctx: AdapterContext): Promise<SnapshotDraft> {
  const token = requireAuth(ctx, 'oauthToken', 'OAuth Access Token')
  const base = baseUrlOf(ctx, 'https://api.anthropic.com')
  const { data } = await jsonRequest<Record<string, any>>(ctx.fetch, {
    url: `${base}/api/oauth/usage`,
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
    },
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  const make = (key: string, label: string, row: any): QuotaWindow | null => {
    if (!row || typeof row !== 'object') return null
    return toWindow({
      key,
      label,
      usedPct: toNumber(row.utilization),
      resetsAt: toIsoTimestamp(row.resets_at),
    })
  }
  const windows = [
    make('5h', '5 小时', data.five_hour),
    make('week', '7 天', data.seven_day),
    make('week-opus', '7 天 · Opus', data.seven_day_opus),
    make('week-sonnet', '7 天 · Sonnet', data.seven_day_sonnet),
  ].filter((window): window is QuotaWindow => window !== null)
  if (windows.length === 0) throw new AppError('upstream', '未返回 5h/7d 窗口，Token 可能已失效')
  return planDone(windows)
}

export async function codexPlan(ctx: AdapterContext): Promise<SnapshotDraft> {
  const token = requireAuth(ctx, 'oauthToken', 'OAuth Access Token')
  const accountId = requireAuth(ctx, 'accountId', 'Account ID')
  const base = baseUrlOf(ctx, 'https://chatgpt.com')
  const { data } = await jsonRequest<Record<string, any>>(ctx.fetch, {
    url: `${base}/backend-api/wham/usage`,
    headers: {
      Authorization: `Bearer ${token}`,
      'ChatGPT-Account-Id': accountId,
      Accept: 'application/json',
    },
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  const labelFor = (seconds: number | null): string => {
    if (seconds === 18_000) return '5 小时'
    if (seconds === 604_800) return '7 天'
    if (seconds && seconds % 3600 === 0) return `${seconds / 3600} 小时`
    if (seconds) return `${Math.round(seconds / 60)} 分钟`
    return '窗口'
  }
  const make = (key: string, row: any): QuotaWindow | null => {
    if (!row || typeof row !== 'object') return null
    const seconds = toNumber(row.limit_window_seconds)
    const reset = toNumber(row.reset_at)
    return toWindow({
      key,
      label: labelFor(seconds),
      usedPct: toNumber(row.used_percent) ?? toNumber(row.usedPercent),
      resetsAt: reset !== null ? (reset < 1_000_000_000_000 ? reset * 1000 : reset) : undefined,
    })
  }
  const primary = make('primary', data.rate_limit?.primary_window)
  const secondary = make('secondary', data.rate_limit?.secondary_window)
  const windows = [primary, secondary].filter((window): window is QuotaWindow => window !== null)
  if (windows.length === 0) throw new AppError('upstream', '未返回额度窗口，登录态可能已失效')
  const credits = toNumber(data.credits?.remaining) ?? toNumber(data.credits)
  return planDone(
    windows,
    {
      ...(typeof data.plan_type === 'string' ? { plan: data.plan_type } : {}),
      ...(credits !== null ? { credits } : {}),
    },
    typeof data.plan_type === 'string' ? data.plan_type : undefined,
  )
}

function kimiIdentityHeaders(accountId: string): Record<string, string> {
  let deviceId = ''
  try {
    const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code')
    deviceId = readFileSync(path.join(home, 'device_id'), 'utf8').trim()
  } catch {
    deviceId = ''
  }
  if (!deviceId) {
    const hex = createHash('sha256').update(`tokenpanel:${accountId}`).digest('hex')
    deviceId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  const ascii = (value: string) => value.replace(/[^\x20-\x7E]/g, '').trim() || 'unknown'
  return {
    'User-Agent': 'TokenPanel/0.1',
    'X-Msh-Platform': 'kimi_code_cli',
    'X-Msh-Version': '0.1.0',
    'X-Msh-Device-Name': ascii(os.hostname()),
    'X-Msh-Device-Model': ascii(`${os.type()} ${os.release()} ${os.arch()}`),
    'X-Msh-Os-Version': ascii(os.release()),
    'X-Msh-Device-Id': deviceId,
  }
}

export async function kimiCodePlan(ctx: AdapterContext): Promise<SnapshotDraft> {
  const apiKey = ctx.account.auth.apiKey?.trim()
  const cliToken = ctx.account.auth.accessToken?.trim()
  const token = apiKey || cliToken
  if (!token) throw new AppError('auth', '请填写 Kimi Code API Key 或 CLI Access Token')
  const base = baseUrlOf(ctx, 'https://api.kimi.com')
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  }
  // 订阅 API Key 只需 Bearer；CLI 登录态还要补 X-Msh-* 设备头。
  if (!apiKey) Object.assign(headers, kimiIdentityHeaders(ctx.account.id))
  const { data } = await jsonRequest<Record<string, any>>(ctx.fetch, {
    url: `${base}/coding/v1/usages`,
    headers,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  const windowFrom = (key: string, label: string, detail: any): QuotaWindow | null => {
    if (!detail || typeof detail !== 'object') return null
    const limit = toNumber(detail.limit)
    if (limit === null || limit <= 0) return null
    const remaining = toNumber(detail.remaining)
    const used = toNumber(detail.used) ?? Math.max(0, limit - (remaining ?? limit))
    const usedPct = Math.min(100, Math.max(0, (used / limit) * 100))
    // Kimi 没有公开 limit/remaining 的单位，100/80 更像额度刻度而不是请求次数，只展示百分比。
    return {
      key,
      label,
      usedPct,
      remainingPct: 100 - usedPct,
      resetsAt: toIsoTimestamp(detail.resetTime ?? detail.reset_at ?? detail.resetAt ?? detail.reset_time),
    }
  }
  const labelFor = (duration: unknown, timeUnit: unknown): string => {
    let value = toNumber(duration)
    if (value === null || typeof timeUnit !== 'string') return '窗口'
    let unit = timeUnit.toLowerCase().replace(/^time_unit_/, '').replace(/s$/, '')
    if (unit === 'minute' && value >= 60 && value % 60 === 0) {
      value /= 60
      unit = 'hour'
    }
    if (unit === 'hour') return `${value} 小时`
    if (unit === 'day') return value === 7 ? '每周' : `${value} 天`
    if (unit === 'week') return '每周'
    if (unit === 'month') return '每月'
    return `${value} ${unit}`
  }
  const windows: QuotaWindow[] = []
  const weekly = windowFrom('week', '每周', data.usage)
  if (weekly) windows.push(weekly)
  for (const limit of Array.isArray(data.limits) ? data.limits : []) {
    const label = labelFor(limit?.window?.duration, limit?.window?.timeUnit)
    const window = windowFrom(`limit:${windows.length}`, label, limit?.detail)
    if (window) windows.push(window)
  }

  // 新版响应把 5h/7d/月额度放在 usages 池里，只有 used_ratio。
  const pools = data.usages && typeof data.usages === 'object' ? data.usages : undefined
  if (pools) {
    const defs = [
      ['limit_5h', '5 小时'],
      ['limit_7d', '每周'],
      ['limit_month_total', '每月（共享）'],
    ] as const
    for (const [key, label] of defs) {
      if (windows.some((window) => window.label === label)) continue
      const pool = (pools as Record<string, any>)[key]
      if (!pool || typeof pool !== 'object') continue
      const ratio = toNumber(pool.used_ratio)
      if (ratio === null) continue
      const usedPct = Math.min(100, Math.max(0, ratio <= 1 ? ratio * 100 : ratio))
      windows.push({
        key: `pool:${key}`,
        label,
        usedPct,
        remainingPct: 100 - usedPct,
        resetsAt: toIsoTimestamp(pool.reset_time ?? pool.resetTime),
      })
    }
  }

  if (windows.length === 0) throw new AppError('upstream', '未返回额度窗口，请检查 Key 或登录态')
  const rawLevel: string = typeof data.user?.membership?.level === 'string' ? data.user.membership.level : ''
  const level =
    rawLevel && !/UNSPECIFIED/i.test(rawLevel)
      ? rawLevel
          .replace(/^LEVEL_/i, '')
          .toLowerCase()
          .replace(/(^|\s)\w/g, (match: string) => match.toUpperCase())
      : undefined
  return planDone(windows, undefined, level)
}

/**
 * OpenCode Go 的额度接口：GET /zen/go/v1/usage，用 OpenCode Console 的 API Key 认证。
 * Go 是订阅制（Go / Go Plus / Go Teams），额度按模型的月度金额折算成三个窗口：
 * 5 小时 = 月额度的 20%、每周 = 50%、每月 = 100%。
 * 官方没有公开这个接口（文档只说"可以在控制台查看用量"），字段名按开源实现（CodexBar）
 * 做了多形状兼容：既认 usage.rolling.percent，也认 rollingUsage.usagePercent；
 * 有 used/limit 绝对值时优先用绝对值算百分比。
 */
const GO_WINDOW_SPECS = [
  { key: '5h', label: '5 小时', aliases: ['rolling', 'rollingUsage', 'fiveHour', 'five_hour'] },
  { key: 'week', label: '每周', aliases: ['weekly', 'weeklyUsage', 'sevenDay', 'seven_day'] },
  { key: 'month', label: '每月', aliases: ['monthly', 'monthlyUsage', 'month'] },
]
const GO_PERCENT_FIELDS = ['percent', 'usagePercent', 'usedPercent', 'used_percent', 'usedPct']
const GO_USED_FIELDS = ['used', 'usedMicroCents', 'currentValue', 'used_value']
const GO_LIMIT_FIELDS = ['limit', 'limitMicroCents', 'total', 'quota', 'totalMicroCents']
const GO_RESET_IN_SEC_FIELDS = ['resetInSec', 'resetsInSec', 'reset_in_sec']
const GO_RESET_AT_FIELDS = ['resetsAt', 'resetAt', 'resetTime', 'reset_time', 'resets_at']

/** 在 data、data.usage 两层里按别名找字段；别名顺序即优先级。 */
function goField(data: Record<string, any>, aliases: string[], fields: string[]): unknown {
  for (const alias of aliases) {
    const containers: any[] = []
    const usage = data?.usage
    if (usage && typeof usage === 'object' && usage[alias] && typeof usage[alias] === 'object') {
      containers.push(usage[alias])
    }
    if (data?.[alias] && typeof data[alias] === 'object') containers.push(data[alias])
    for (const container of containers) {
      for (const field of fields) {
        const value = container[field]
        if (value !== undefined && value !== null) return value
      }
    }
  }
  return undefined
}

export async function openCodeGoPlan(ctx: AdapterContext): Promise<SnapshotDraft> {
  const key = requireAuth(ctx, 'apiKey', 'API Key')
  const base = baseUrlOf(ctx, 'https://opencode.ai')
  let data: Record<string, any>
  try {
    const response = await jsonRequest<Record<string, any>>(ctx.fetch, {
      url: `${base}/zen/go/v1/usage`,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    })
    data = response.data
  } catch (error) {
    if (error instanceof AppError && error.code === 'auth') {
      throw new AppError('auth', 'Key 被拒绝：请用 OpenCode Console 里 Go 订阅的 API Key', 401, error.detail)
    }
    throw error
  }
  const windows: QuotaWindow[] = []
  for (const spec of GO_WINDOW_SPECS) {
    const percent = toNumber(goField(data, spec.aliases, GO_PERCENT_FIELDS))
    const used = toNumber(goField(data, spec.aliases, GO_USED_FIELDS))
    const limit = toNumber(goField(data, spec.aliases, GO_LIMIT_FIELDS))
    // 绝对值优先：百分比字段的单位在不同版本间变过，used/limit 不会。
    let usedPct: number | null = null
    if (used !== null && limit !== null && limit > 0) usedPct = (used / limit) * 100
    else if (percent !== null) usedPct = percent
    if (usedPct === null || !Number.isFinite(usedPct)) continue
    const clamped = Math.min(100, Math.max(0, usedPct))
    const resetInSec = toNumber(goField(data, spec.aliases, GO_RESET_IN_SEC_FIELDS))
    const resetAt = toIsoTimestamp(goField(data, spec.aliases, GO_RESET_AT_FIELDS))
    windows.push({
      key: spec.key,
      label: spec.label,
      usedPct: clamped,
      remainingPct: 100 - clamped,
      resetsAt: resetInSec !== null && resetInSec > 0 ? ctx.now + resetInSec * 1000 : resetAt,
    })
  }
  if (windows.length === 0) {
    throw new AppError('upstream', '未返回额度窗口，接口可能已变更，或这个 Key 不是 Go 订阅的 Key')
  }
  const planRaw = data.plan ?? data.planType ?? data.plan_type ?? data.tier ?? data.subscription?.plan
  const planLabel = typeof planRaw === 'string' && planRaw.trim() ? planRaw.trim() : undefined
  return planDone(windows, undefined, planLabel)
}
