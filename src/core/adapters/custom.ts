import { AppError } from '../errors'
import { getByPath, toIsoTimestamp, toNumber } from '../util/json'
import { jsonRequest } from './http'
import { baseUrlOf, type AdapterContext, type SnapshotDraft } from './types'
import type { QuotaWindow } from '../types'

function substitute(input: string, apiKey: string): string {
  return input.replace(/\{\{\s*apiKey\s*\}\}/g, apiKey)
}

export async function customQuota(ctx: AdapterContext): Promise<SnapshotDraft> {
  const custom = ctx.account.options.custom
  if (!custom) throw new AppError('validation', '缺少自定义接口配置')
  const base = baseUrlOf(ctx, '')
  if (!base) throw new AppError('validation', '请填写接口 URL')
  const apiKey = ctx.account.auth.apiKey?.trim() ?? ''
  const url = substitute(base, apiKey)

  let headers: Record<string, string> = {}
  if (custom.headers?.trim()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(custom.headers)
    } catch {
      throw new AppError('validation', '请求头不是合法 JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AppError('validation', '请求头必须是 JSON 对象')
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      headers[key] = substitute(String(value), apiKey)
    }
  }

  const { data } = await jsonRequest<unknown>(ctx.fetch, {
    url,
    method: custom.method,
    headers,
    body: custom.method === 'POST' && custom.body ? substitute(custom.body, apiKey) : undefined,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })

  const balance = custom.balancePath ? toNumber(getByPath(data, custom.balancePath)) : null
  const currencyRaw = custom.currencyPath ? getByPath(data, custom.currencyPath) : undefined
  const currency = typeof currencyRaw === 'string' && /^(cny|usd)$/i.test(currencyRaw.trim())
    ? currencyRaw.trim().toUpperCase()
    : ctx.account.options.manualBalance?.currency ?? 'CNY'

  const windows: QuotaWindow[] = []
  if (custom.windowsPath) {
    const rows = getByPath(data, custom.windowsPath)
    if (!Array.isArray(rows)) throw new AppError('upstream', `窗口路径 ${custom.windowsPath} 不是数组`)
    rows.forEach((row, index) => {
      const total = custom.windowTotalPath ? toNumber(getByPath(row, custom.windowTotalPath)) : toNumber(getByPath(row, 'total'))
      const used = custom.windowUsedPath ? toNumber(getByPath(row, custom.windowUsedPath)) : toNumber(getByPath(row, 'used'))
      const labelRaw = custom.windowLabelPath ? getByPath(row, custom.windowLabelPath) : getByPath(row, 'label')
      const resetRaw = custom.windowResetPath ? getByPath(row, custom.windowResetPath) : getByPath(row, 'resetsAt')
      if (total === null || total <= 0 || used === null) return
      const pct = Math.min(100, Math.max(0, (used / total) * 100))
      windows.push({
        key: `w${index}`,
        label: typeof labelRaw === 'string' && labelRaw ? labelRaw : `窗口 ${index + 1}`,
        used,
        total,
        usedPct: pct,
        remainingPct: 100 - pct,
        resetsAt: toIsoTimestamp(resetRaw),
      })
    })
    if (windows.length === 0) throw new AppError('upstream', '未从窗口路径解析到有效额度')
  }

  if (balance === null && windows.length === 0) {
    throw new AppError('upstream', '未解析到余额或套餐窗口，请检查 JSON 路径')
  }

  const planLabelRaw = custom.planLabelPath ? getByPath(data, custom.planLabelPath) : undefined
  return {
    status: 'ok',
    kind: windows.length > 0 ? 'plan' : 'balance',
    source: 'unofficial',
    currency,
    balance: balance ?? undefined,
    windows: windows.length ? windows : undefined,
    planLabel: typeof planLabelRaw === 'string' ? planLabelRaw : undefined,
    extras: { interface: '自定义 HTTP' },
  }
}
