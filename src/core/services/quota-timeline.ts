import type { QuotaDepletionForecast, QuotaSnapshot, QuotaWindow } from '../types'
import { windowPeriodHours, windowUsedPct } from '../util/quota'
import { DAY_MS } from '../util/time'

const MIN_OBSERVED_MS = 10 * 60_000
const MIN_DROP_PCT = 2

/** 只对同一重置周期内的近期余量变化做线性外推，不把旧周期或反弹后的数据混入。 */
export function estimateQuotaDepletion(
  window: QuotaWindow,
  history: QuotaSnapshot[],
  now: number,
  staleAfterMs = 30 * 60_000,
): QuotaDepletionForecast | undefined {
  const reset = window.resetsAt
  const used = windowUsedPct(window)
  if (!reset || !Number.isFinite(reset) || reset <= now || used === undefined || !Number.isFinite(used)) return undefined
  const remaining = Math.min(100, Math.max(0, 100 - used))
  if (remaining <= 0) return undefined
  const period = windowPeriodHours(window)
  const since = Math.max(now - DAY_MS, period ? reset - period * 3_600_000 : 0)
  const byTime = new Map<number, number>()
  for (const snapshot of history) {
    if (snapshot.status !== 'ok' || !Number.isFinite(snapshot.at) || snapshot.at < since || snapshot.at > now) continue
    const past = snapshot.windows?.find(item => item.key === window.key)
    // 重置时间允许厂商秒级取整；更大的变化属于不同周期，不参与拟合。
    if (!past?.resetsAt || Math.abs(past.resetsAt - reset) > 60_000) continue
    const pastUsed = windowUsedPct(past)
    if (pastUsed === undefined || !Number.isFinite(pastUsed) || pastUsed < 0 || pastUsed > 100) continue
    byTime.set(snapshot.at, 100 - pastUsed)
  }
  const ordered = [...byTime].sort(([a], [b]) => a - b)
  let cycleStart = 0
  ordered.forEach((point, index) => {
    if (index > 0 && point[1] > ordered[index - 1][1] + 0.5) cycleStart = index
  })
  const samples = ordered.slice(cycleStart)
  if (samples.length < 3) return undefined
  const [firstAt, firstPct] = samples[0]
  const [lastAt, lastPct] = samples[samples.length - 1]
  const observedMs = lastAt - firstAt
  if (now - lastAt > staleAfterMs || observedMs < MIN_OBSERVED_MS || Math.abs(lastPct - remaining) > 0.5) return undefined
  const drop = firstPct - lastPct
  if (drop < MIN_DROP_PCT) return undefined
  const rate = drop / observedMs
  // 从最新观测点外推，刷新间隔内已经经过的时间不应重复加到预计耗尽时间上。
  const depletesAt = lastAt + lastPct / rate
  if (!Number.isFinite(new Date(depletesAt).getTime())) return undefined
  return {
    windowKey: window.key, depletesAt, resetsAt: reset,
    sampleCount: samples.length, observedFrom: firstAt, observedTo: lastAt,
    remainingPctPerHour: rate * 3_600_000,
  }
}
