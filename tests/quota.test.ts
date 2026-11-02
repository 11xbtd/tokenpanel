import { describe, expect, it } from 'vitest'
import type { AccountPublic, QuotaSnapshot, QuotaWindow, UsageRecord } from '../src/core/types'
import { estimateWeeklyQuota } from '../src/core/services/weekly-quota'
import { buildOverview } from '../src/core/services/analytics'
import { DEFAULT_SETTINGS } from '../src/core/storage/defaults'
import { DAY_MS } from '../src/core/util/time'
import { sortQuotaWindows, windowPeriodHours, windowUsedPct } from '../src/core/util/quota'

const w = (key: string, label: string, extra: Partial<QuotaWindow> = {}): QuotaWindow => ({ key, label, ...extra })

describe('quota 窗口排序', () => {
  it('不同厂商的窗口行按周期从短到长排', () => {
    const kimi = [w('week', '每周'), w('pool:limit_5h', '5 小时'), w('pool:limit_month_total', '每月（共享）')]
    const minimax = [w('general:week', '每周'), w('general:5h', '5 小时')]
    const claude = [w('week-sonnet', '7 天 · Sonnet'), w('5h', '5 小时'), w('week', '7 天')]
    expect(sortQuotaWindows(kimi).map((window) => window.label)).toEqual(['5 小时', '每周', '每月（共享）'])
    expect(sortQuotaWindows(minimax).map((window) => window.label)).toEqual(['5 小时', '每周'])
    expect(sortQuotaWindows(claude).map((window) => window.label)).toEqual(['5 小时', '7 天', '7 天 · Sonnet'])
  })

  it('认不出周期的窗口排最后并按标签稳定排序', () => {
    const list = [w('manual-1', '自定义池'), w('secondary', '次级限流'), w('5h', '5 小时')]
    expect(sortQuotaWindows(list).map((window) => window.label)).toEqual(['5 小时', '次级限流', '自定义池'])
    expect(windowPeriodHours(w('primary', '窗口'))).toBeUndefined()
  })

  it('已用比例按 usedPct → remainingPct → used/total 依次取', () => {
    expect(windowUsedPct(w('a', 'A', { usedPct: 40 }))).toBe(40)
    expect(windowUsedPct(w('b', 'B', { remainingPct: 30 }))).toBe(70)
    expect(windowUsedPct(w('c', 'C', { used: 3, total: 12 }))).toBe(25)
    expect(windowUsedPct(w('d', 'D'))).toBeUndefined()
  })
})

const CYCLE_START = Date.UTC(2026, 9, 22)
const NOW = CYCLE_START + 3 * DAY_MS
const RESET = CYCLE_START + 7 * DAY_MS

const record = (ts: number, model: string, input: number): UsageRecord => ({
  id: `${ts}-${model}`,
  accountId: 'acc',
  providerId: 'claude-plan',
  ts,
  model,
  inputTokens: input,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsdMicros: 0,
  costEstimated: false,
  source: 'local-log',
  externalId: `${ts}-${model}`,
  billingMode: 'plan',
})

const snapshot = (at: number, pct: number): QuotaSnapshot => ({
  id: `snap-${at}`,
  accountId: 'acc',
  providerId: 'claude-plan',
  at,
  status: 'ok',
  kind: 'plan',
  source: 'official',
  latencyMs: 0,
  windows: [w('week', '7 天', { usedPct: pct, resetsAt: RESET })],
})

describe('周额度反推', () => {
  const estimate = (
    window: QuotaWindow,
    records: UsageRecord[],
    history: QuotaSnapshot[] = [],
    measuredAt = NOW,
  ) => estimateWeeklyQuota(window, records, history, measuredAt, NOW)

  it('按相邻快照增量取最大折算值，外部用量只拉低单段结果', () => {
    const t1 = CYCLE_START + DAY_MS
    const t2 = CYCLE_START + 2 * DAY_MS
    const result = estimate(
      w('week', '每周', { usedPct: 50, resetsAt: RESET }),
      [
        record(t1 - 1, 'kimi-k2', 20_000_000),
        record(t2 - 1, 'kimi-k2', 10_000_000),
        record(NOW - 1, 'kimi-k2', 5_000_000),
      ],
      [snapshot(t1, 20), snapshot(t2, 40), snapshot(NOW, 50)],
    )
    expect(result).toMatchObject({
      windowKey: 'week',
      usedPct: 50,
      usedTokens: 35_000_000,
      estimatedTotalTokens: 100_000_000,
      observedFrom: CYCLE_START,
      observedTo: t1,
      observedTokens: 20_000_000,
      observedPct: 20,
      externalUsageDetected: false,
      cycleStart: CYCLE_START,
      resetsAt: RESET,
    })
  })

  it('额度上涨但本机没有记录的区间会标记外部用量', () => {
    const t1 = CYCLE_START + DAY_MS
    const t2 = CYCLE_START + 2 * DAY_MS
    const result = estimate(
      w('week', '每周', { usedPct: 30, resetsAt: RESET }),
      [record(NOW - 1, 'kimi-k2', 10_000_000)],
      [snapshot(t1, 10), snapshot(t2, 20), snapshot(NOW, 30)],
    )
    expect(result).toMatchObject({
      usedTokens: 10_000_000,
      estimatedTotalTokens: 100_000_000,
      observedFrom: t2,
      observedTo: NOW,
      observedPct: 10,
      externalUsageDetected: true,
    })
  })

  it('只有当前快照时，按周期起点到快照的累计值给下限', () => {
    expect(estimate(
      w('week', '每周', { usedPct: 25, resetsAt: RESET }),
      [
        record(CYCLE_START + DAY_MS, 'kimi-k2', 2_000_000),
        record(CYCLE_START - 1, 'kimi-k2', 9_000_000),
        record(NOW + 1, 'kimi-k2', 9_000_000),
      ],
    )).toMatchObject({
      usedPct: 25,
      usedTokens: 2_000_000,
      estimatedTotalTokens: 8_000_000,
      observedFrom: CYCLE_START,
      observedTo: NOW,
      observedTokens: 2_000_000,
      observedPct: 25,
    })
  })

  it('模型专用窗口只统计匹配的调用', () => {
    const opus = estimate(
      w('week-opus', '7 天 · Opus', { usedPct: 5, resetsAt: RESET }),
      [record(NOW - DAY_MS, 'claude-opus-4-1', 2_000_000), record(NOW - DAY_MS, 'claude-sonnet-4-5', 3_000_000)],
    )
    expect(opus).toMatchObject({ modelHint: 'opus', usedTokens: 2_000_000, estimatedTotalTokens: 40_000_000 })
    expect(estimate(
      w('MiniMax-M2.1:week', 'MiniMax-M2.1 · 每周', { usedPct: 10, resetsAt: RESET }),
      [record(NOW - DAY_MS, 'MiniMax-M2.1', 1_000_000), record(NOW - DAY_MS, 'MiniMax-Text-01', 9_000_000)],
    )).toMatchObject({ modelHint: 'MiniMax-M2.1', usedTokens: 1_000_000, estimatedTotalTokens: 10_000_000 })
  })

  it('非周窗口、已重置、百分比为零或没有本机记录时不给估算', () => {
    const records = [record(NOW - DAY_MS, 'm', 1_000_000)]
    expect(estimate(w('5h', '5 小时', { usedPct: 50, resetsAt: NOW + 3_600_000 }), records)).toBeUndefined()
    expect(estimate(w('week', '每周', { usedPct: 50 }), records)).toBeUndefined()
    expect(estimate(w('week', '每周', { usedPct: 50, resetsAt: NOW - 1 }), records)).toBeUndefined()
    expect(estimate(w('week', '每周', { usedPct: 0, resetsAt: RESET }), records)).toBeUndefined()
    expect(estimate(w('week', '每周', { usedPct: 50, resetsAt: RESET }), [])).toBeUndefined()
  })

  it('总览把估算挂到账户上，供卡片和时间轴使用', () => {
    const account: AccountPublic = {
      id: 'acc',
      providerId: 'claude-plan',
      label: 'Claude',
      enabled: true,
      createdAt: 0,
      authMasked: {},
      hasAuth: true,
      options: {},
    }
    const t1 = CYCLE_START + DAY_MS
    const current: QuotaSnapshot = {
      ...snapshot(NOW, 50),
      id: 'snap-current',
    }
    const overview = buildOverview({
      accounts: [account],
      providers: new Map(),
      latest: new Map([['acc:plan', current]]),
      quotaHistory: [snapshot(t1, 20), current],
      usage: [record(t1 - 1, 'claude-sonnet-4-5', 20_000_000), record(NOW - 1, 'claude-sonnet-4-5', 10_000_000)],
      ledger: [],
      sync: { acc: { accountId: 'acc', at: NOW, status: 'ok' } },
      settings: DEFAULT_SETTINGS,
      days: 7,
      now: NOW,
    })
    expect(overview.accounts[0].weeklyQuotaEstimates).toMatchObject([
      { windowKey: 'week', usedTokens: 30_000_000, estimatedTotalTokens: 100_000_000 },
    ])
  })
})
