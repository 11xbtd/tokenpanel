import type { QuotaSnapshot, QuotaWindow, UsageRecord, WeeklyQuotaEstimate } from '../types'
import { windowPeriodHours, windowUsedPct } from '../util/quota'
import { DAY_MS } from '../util/time'

const WEEK_HOURS = 168
/** 百分比变化太小时，厂商百分点的舍入误差会盖过真实用量，不参与折算。 */
const MIN_DELTA_PCT = 1
/** 厂商的重置时间可能秒级取整，跨快照比较时留一点余量。 */
const RESET_TOLERANCE_MS = 60_000

/**
 * 从窗口 key 里认模型限定词：Claude 的 `week-opus`、MiniMax 的 `模型:week`。
 * `general`/`pool` 这类是厂商的通用池，不对应日志里的模型名，按全账户统计。
 */
function windowModelHint(window: QuotaWindow): string | undefined {
  const pair = /^(.*):(?:week|5h)$/i.exec(window.key)
  if (pair && pair[1] && !/^(general|pool)$/i.test(pair[1])) return pair[1]
  return /^week-(.+)$/i.exec(window.key)?.[1]
}

function recordTokens(record: UsageRecord): number {
  return record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens
}

const clampPct = (value: number): number => Math.min(100, Math.max(0, value))

interface Observation {
  at: number
  pct: number
}

/** 同一周期内的百分比观测点，起点固定为重置时刻的 0%。 */
function observationsOf(
  window: QuotaWindow,
  history: QuotaSnapshot[],
  measuredAt: number,
  resetsAt: number,
  cycleStart: number,
): Observation[] {
  const points = new Map<number, number>()
  for (const snapshot of history) {
    if (snapshot.status !== 'ok' || snapshot.at < cycleStart || snapshot.at > measuredAt) continue
    const past = snapshot.windows?.find((item) => item.key === window.key)
    // 重置时间对不上的是别的周期，百分比不能混进同一条曲线。
    if (!past?.resetsAt || Math.abs(past.resetsAt - resetsAt) > RESET_TOLERANCE_MS) continue
    const pct = windowUsedPct(past)
    if (pct === undefined || !Number.isFinite(pct)) continue
    points.set(snapshot.at, clampPct(pct))
  }
  const current = windowUsedPct(window)
  if (current !== undefined && Number.isFinite(current)) points.set(measuredAt, clampPct(current))
  points.set(cycleStart, 0)
  return [...points.entries()]
    .map(([at, pct]) => ({ at, pct }))
    .sort((a, b) => a.at - b.at)
}

/**
 * 周额度总量未知，厂商只给百分比；而百分比是**所有设备**共用额度后的结果，
 * 本机日志可能只是其中一部分。所以不能用「累计本机 token ÷ 当前百分比」，
 * 那会把别的设备/没接入日志的客户端用掉的额度算成「本机用掉的」，导致总量偏低。
 *
 * 这里改为看相邻快照：本机在区间内记录到 Δtoken，额度百分比同时上涨 Δpct，
 * 则该区间的折算值是 Δtoken × 100 / Δpct。外部用量只会让 Δpct 变大、折算值变小，
 * 所以真实周额度不低于所有区间折算值的最大值，取最大者作为下限。
 * 缺少快照、没有足够百分比变化或本机记录时返回 undefined。
 */
export function estimateWeeklyQuota(
  window: QuotaWindow,
  records: UsageRecord[],
  history: QuotaSnapshot[],
  measuredAt: number,
  now: number,
): WeeklyQuotaEstimate | undefined {
  if (windowPeriodHours(window) !== WEEK_HOURS) return undefined
  const resetsAt = window.resetsAt
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= now) return undefined
  const currentPct = windowUsedPct(window)
  if (currentPct === undefined || !Number.isFinite(currentPct)) return undefined
  const usedPct = clampPct(currentPct)
  const cycleStart = resetsAt - 7 * DAY_MS
  const cutoff = Math.min(measuredAt, now)
  if (usedPct <= 0 || cutoff <= cycleStart) return undefined

  const hint = windowModelHint(window)
  const needle = hint?.toLowerCase()
  const scoped = records
    .filter(
      (record) =>
        record.ts >= cycleStart &&
        record.ts <= cutoff &&
        (!needle || record.model.toLowerCase().includes(needle)),
    )
    .sort((a, b) => a.ts - b.ts)
  const points = observationsOf(window, history, cutoff, resetsAt, cycleStart)
  if (points.length < 2) return undefined

  let best: { from: number; to: number; tokens: number; pct: number; total: number } | undefined
  let externalUsageDetected = false
  let cursor = 0
  let cumulative = 0
  let prevTokens = 0
  let prevPct = points[0].pct
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]
    while (cursor < scoped.length && scoped[cursor].ts <= point.at) {
      cumulative += recordTokens(scoped[cursor])
      cursor += 1
    }
    const deltaTokens = cumulative - prevTokens
    const deltaPct = point.pct - prevPct
    if (deltaPct >= MIN_DELTA_PCT) {
      if (deltaTokens > 0) {
        const total = (deltaTokens * 100) / deltaPct
        if (!best || total > best.total) {
          best = { from: points[index - 1].at, to: point.at, tokens: deltaTokens, pct: deltaPct, total }
        }
      } else {
        // 额度涨了、本机却没有对应记录：至少有一部分消耗来自别处。
        externalUsageDetected = true
      }
    }
    prevTokens = cumulative
    prevPct = point.pct
  }
  if (!best) return undefined

  return {
    windowKey: window.key,
    modelHint: hint,
    usedPct,
    usedTokens: cumulative,
    estimatedTotalTokens: Math.round(best.total),
    observedFrom: best.from,
    observedTo: best.to,
    observedTokens: best.tokens,
    observedPct: best.pct,
    externalUsageDetected,
    cycleStart,
    resetsAt,
  }
}
