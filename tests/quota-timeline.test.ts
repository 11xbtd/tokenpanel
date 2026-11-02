import { describe, expect, it } from 'vitest'
import type { QuotaSnapshot, QuotaWindow } from '../src/core/types'
import { estimateQuotaDepletion } from '../src/core/services/quota-timeline'

const minute = 60_000
const now = Date.parse('2026-10-30T12:00:00+08:00')
const window: QuotaWindow = { key: '5h', label: '5 小时', remainingPct: 20, resetsAt: now + 120 * minute }
const snapshot = (minutesAgo: number, pct: number, extra: Partial<QuotaWindow> = {}): QuotaSnapshot => ({
  id: String(minutesAgo), accountId: 'account', providerId: 'codex-plan', at: now - minutesAgo * minute,
  status: 'ok', kind: 'plan', latencyMs: 0, source: 'official', windows: [{ ...window, remainingPct: pct, ...extra }],
})

describe('额度耗尽预估', () => {
  it('同周期的近期余量下降可预测提前耗尽，保留样本依据', () => {
    const forecast = estimateQuotaDepletion(window, [snapshot(20, 40), snapshot(10, 30), snapshot(0, 20)], now)
    expect(forecast).toMatchObject({ depletesAt: now + 20 * minute, sampleCount: 3, remainingPctPerHour: 60 })
    expect(forecast!.depletesAt).toBeLessThan(window.resetsAt!)
    expect(forecast!.observedFrom).toBe(now - 20 * minute)
  })

  it('从最新观测点外推，经过的空档不会重复计时', () => {
    const forecast = estimateQuotaDepletion(window, [snapshot(25, 40), snapshot(15, 30), snapshot(5, 20)], now)
    expect(forecast?.depletesAt).toBe(now + 15 * minute)
  })

  it('样本不足、时间太短、余量不变、快照过旧时不猜测', () => {
    expect(estimateQuotaDepletion(window, [snapshot(20, 40), snapshot(0, 20)], now)).toBeUndefined()
    expect(estimateQuotaDepletion(window, [snapshot(2, 40), snapshot(1, 30), snapshot(0, 20)], now)).toBeUndefined()
    expect(estimateQuotaDepletion(window, [snapshot(20, 20), snapshot(10, 20), snapshot(0, 20)], now)).toBeUndefined()
    expect(estimateQuotaDepletion(window, [snapshot(60, 40), snapshot(50, 30), snapshot(40, 20)], now)).toBeUndefined()
  })

  it('重置前的周期和余量反弹前的样本都不用于本次预估', () => {
    const oldReset = now + 60 * minute
    expect(estimateQuotaDepletion(window, [snapshot(20, 40, { resetsAt: oldReset }), snapshot(10, 30), snapshot(0, 20)], now)).toBeUndefined()
    expect(estimateQuotaDepletion(window, [snapshot(40, 50), snapshot(30, 10), snapshot(20, 30), snapshot(0, 20)], now)).toBeUndefined()
  })

  it('忽略失败、未来、无效或相同时间的重复快照，过期窗口不预测', () => {
    const rows = [snapshot(20, 40), snapshot(10, 30), snapshot(0, 20), snapshot(0, 20), snapshot(-10, 1), { ...snapshot(15, 90), status: 'error' as const }, snapshot(5, Number.NaN)]
    expect(estimateQuotaDepletion(window, rows, now)?.sampleCount).toBe(3)
    expect(estimateQuotaDepletion({ ...window, resetsAt: now }, rows, now)).toBeUndefined()
    expect(estimateQuotaDepletion({ ...window, remainingPct: 0 }, rows, now)).toBeUndefined()
  })
})
