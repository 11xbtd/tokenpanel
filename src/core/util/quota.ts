import type { QuotaColorThresholds, QuotaWindow } from '../types'

export const DEFAULT_QUOTA_COLORS: QuotaColorThresholds = { warningPct: 50, dangerPct: 20 }

export function validQuotaColors(value: unknown): value is QuotaColorThresholds {
  if (!value || typeof value !== 'object') return false
  const { warningPct, dangerPct } = value as QuotaColorThresholds
  return Number.isFinite(warningPct) && Number.isFinite(dangerPct)
    && dangerPct >= 0 && warningPct <= 100 && dangerPct < warningPct
}

/** 旧配置和旧备份缺少颜色分级时补默认值，独立于通知告警阈值。 */
export function quotaColorThresholds(value?: Partial<QuotaColorThresholds> | null): QuotaColorThresholds {
  return validQuotaColors(value) ? { warningPct: value.warningPct, dangerPct: value.dangerPct } : { ...DEFAULT_QUOTA_COLORS }
}

/** 从 key/label 推断窗口时长（小时），认不出来返回 undefined。 */
export function windowPeriodHours(window: QuotaWindow): number | undefined {
  const text = `${window.key} ${window.label}`.toLowerCase()
  const hours = /(\d+(?:\.\d+)?)\s*(?:小时|hours?|h\b)/.exec(text)
  if (hours) return Number(hours[1])
  const days = /(\d+)\s*(?:天|days?|d\b)/.exec(text)
  if (days) return Number(days[1]) * 24
  if (/周|week|7d/.test(text)) return 24 * 7
  if (/月|month|30d/.test(text)) return 24 * 30
  return undefined
}

/** 各厂商返回的窗口顺序不一样，这里固定成短周期在前，卡片行序才能对齐。 */
export function sortQuotaWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return [...windows].sort((a, b) => {
    const pa = windowPeriodHours(a) ?? Number.MAX_SAFE_INTEGER
    const pb = windowPeriodHours(b) ?? Number.MAX_SAFE_INTEGER
    if (pa !== pb) return pa - pb
    if (a.resetsAt !== undefined && b.resetsAt !== undefined && a.resetsAt !== b.resetsAt) return a.resetsAt - b.resetsAt
    return a.label.localeCompare(b.label, 'zh-CN')
  })
}

export function windowUsedPct(window: QuotaWindow): number | undefined {
  if (window.usedPct !== undefined) return window.usedPct
  if (window.remainingPct !== undefined) return 100 - window.remainingPct
  if (window.used !== undefined && window.total && window.total > 0) return (window.used / window.total) * 100
  return undefined
}
