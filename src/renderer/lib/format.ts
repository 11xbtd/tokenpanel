import type { QuotaColorThresholds } from '../../core/types'
import { quotaColorThresholds } from '../../core/util/quota'

export { formatMoney, formatPct, formatTokens } from '../../core/util/money'
export { formatCountdown, formatDateTime, formatDuration, planExpiry } from '../../core/util/time'
export { CAPABILITY_LABELS, CATEGORY_LABELS, STABILITY_LABELS } from '../../core/providers/registry'

export const usdFromMicros = (micros: number): number => micros / 1_000_000

export function shortDate(date: string): string {
  return date.slice(5).replace('-', '/')
}

export function remainingTone(pct?: number, thresholds?: QuotaColorThresholds): 'ok' | 'warn' | 'danger' {
  if (pct === undefined || !Number.isFinite(pct)) return 'ok'
  const { warningPct, dangerPct } = quotaColorThresholds(thresholds)
  if (pct <= dangerPct) return 'danger'
  if (pct <= warningPct) return 'warn'
  return 'ok'
}

export function formatSpeed(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '—'
  if (value > 0 && value < 0.01) return '<0.01'
  return value.toFixed(value < 1 ? 2 : value < 10 ? 1 : 0)
}

export const SOURCE_LABELS: Record<string, string> = {
  'admin-api': '官方用量',
  'relay-log': '中转日志',
  csv: 'CSV 导入',
  manual: '手动录入',
  'balance-delta': '余额差估算',
  'local-log': '本机日志',
}

/** 本机日志的归属依据：命中的是哪一条规则。 */
export const ATTRIBUTION_LABELS: Record<string, string> = {
  manual: '绑定命中',
  auto: '模型规则',
  provider: '厂商线索',
  none: '未归属',
}

/** 模型与 token 构成的分类色；账户维度优先使用厂商品牌色。 */
export const CHART_COLORS = ['#2d8b70', '#4c79c6', '#b47b25', '#9470c7', '#ca6c83', '#418eaa', '#7a934e', '#7d8a9e']
const DARK_CHART_COLORS = ['#73ceb0', '#92b7fa', '#e2b566', '#b89bea', '#ea9eac', '#84c8dc', '#b0cc7b', '#a8b4c8']

export function chartColors(dark: boolean): string[] {
  return dark ? DARK_CHART_COLORS : CHART_COLORS
}

