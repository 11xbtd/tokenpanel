import { describe, expect, it } from 'vitest'
import { DAY_MS, planExpiry } from '../src/core/util/time'

const now = Date.parse('2026-11-12T12:00:00+08:00')

describe('套餐到期倒计时', () => {
  it('未设置或非法到期日不显示', () => {
    expect(planExpiry(undefined, now)).toBeNull()
    expect(planExpiry(0, now)).toBeNull()
    expect(planExpiry(Number.NaN, now)).toBeNull()
  })

  it('已到期标红', () => {
    expect(planExpiry(now - 1000, now)).toEqual({ days: 0, tone: 'danger', label: '已到期' })
    expect(planExpiry(now, now)?.tone).toBe('danger')
  })

  it('7 天内预警，剩余天数向上取整', () => {
    expect(planExpiry(now + 3 * DAY_MS, now)).toEqual({ days: 3, tone: 'warn', label: '3 天后到期' })
    expect(planExpiry(now + 7 * DAY_MS, now)?.tone).toBe('warn')
    // 6 天 1 小时 → 向上取整为 7 天，仍预警
    expect(planExpiry(now + 6 * DAY_MS + 3_600_000, now)?.days).toBe(7)
  })

  it('超过 7 天为正常态', () => {
    expect(planExpiry(now + 8 * DAY_MS, now)).toEqual({ days: 8, tone: 'ok', label: '8 天后到期' })
    expect(planExpiry(now + 30 * DAY_MS, now)?.tone).toBe('ok')
  })
})
