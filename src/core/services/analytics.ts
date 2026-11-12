import type {
  AccountPublic,
  BillingMode,
  LedgerEntry,
  ModelUsageRow,
  Overview,
  ProviderPreset,
  QuotaSnapshot,
  Settings,
  SyncState,
  TokenStats,
  UsageRecord,
} from '../types'
import { convertCurrency } from '../util/money'
import { numberValue } from '../util/json'
import { accountBillingMode } from '../logs/attribution'
import { DAY_MS, dateKey, lastNDates, startOfDay, startOfMonth } from '../util/time'
import { manualBalanceOf, manualWindowsOf } from './manual'
import { estimateQuotaDepletion } from './quota-timeline'
import { estimateWeeklyQuota } from './weekly-quota'

interface OverviewArgs {
  accounts: AccountPublic[]
  providers: Map<string, ProviderPreset>
  latest: Map<string, QuotaSnapshot>
  quotaHistory?: QuotaSnapshot[]
  usage: UsageRecord[]
  ledger: LedgerEntry[]
  sync: Record<string, SyncState>
  settings: Settings
  days: number
  now?: number
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function estimatedSpeed(record: UsageRecord): boolean {
  const scope = record.meta?.durationScope
  return scope === 'task' || scope === 'turn' || scope === 'turn-gap' || record.meta?.durationSource === 'message-gap'
}

/**
 * 单个账户的 token 统计。today/month/all 是日历窗口；带 range 前缀的跟着
 * 所选区间（近一周/一月/一年），卡片上的输入/输出/缓存/速度/首字就是这个口径。
 */
interface TokenStatInput {
  todayTokens: number
  monthTokens: number
  allTokens: number
  rangeTokens: number
  rangeCalls: number
  rangeInput: number
  rangeOutput: number
  rangeCacheRead: number
  rangeCacheWrite: number
  ttft: number[]
  speed: number[]
  speedEstimated?: boolean
  last?: { ts: number; model: string; durationMs?: number }
}

function tokenStatsOf(stat: TokenStatInput): TokenStats | undefined {
  if (stat.allTokens === 0 && stat.rangeCalls === 0) return undefined
  const cacheBase = stat.rangeInput + stat.rangeCacheRead
  return {
    todayTokens: stat.todayTokens,
    monthTokens: stat.monthTokens,
    allTokens: stat.allTokens,
    rangeTokens: stat.rangeTokens,
    rangeCalls: stat.rangeCalls,
    rangeInput: stat.rangeInput,
    rangeOutput: stat.rangeOutput,
    rangeCacheRead: stat.rangeCacheRead,
    rangeCacheWrite: stat.rangeCacheWrite,
    rangeCacheHitRate: cacheBase > 0 ? (stat.rangeCacheRead / cacheBase) * 100 : undefined,
    ttftP50: median(stat.ttft),
    speedP50: median(stat.speed),
    speedEstimated: stat.speedEstimated || undefined,
    speedSamples: stat.speed.length,
    lastModel: stat.last?.model,
    lastAt: stat.last?.ts,
    lastDurationMs: stat.last?.durationMs,
  }
}

interface PlanAccountStat extends TokenStatInput {
  credits: number
  spark: number[]
}

interface ApiAccountStat extends TokenStatInput {
  todayUsd: number
  monthUsd: number
  /** 近 7 天里厂商实际计费的部分，估算不计。 */
  sevenActualUsd: number
  monthEstimated: number
  /** 近 7 天 token，spark 用。 */
  tokenSpark: number[]
}

export function buildOverview(args: OverviewArgs): Overview {
  const now = args.now ?? Date.now()
  const todayStart = startOfDay(now)
  const monthStart = startOfMonth(now)
  const sevenStart = todayStart - 6 * DAY_MS
  const rangeStart = todayStart - (args.days - 1) * DAY_MS
  const fx = args.settings.fxUsdCny
  const displayCurrency = args.settings.displayCurrency

  const accountByKey = new Map<string, AccountPublic>()
  const summaryModes = new Map<string, BillingMode | 'mixed'>()
  for (const account of args.accounts) {
    accountByKey.set(account.id, account)
    accountByKey.set(account.label.toLowerCase(), account)
    summaryModes.set(account.id, accountBillingMode(account))
  }

  const apiUsage: UsageRecord[] = []
  const planUsage: UsageRecord[] = []
  for (const record of args.usage) {
    const accountMode = summaryModes.get(record.accountId)
    const isPlan = accountMode === 'plan' || record.billingMode === 'plan'
    if (isPlan) planUsage.push(record)
    else apiUsage.push(record)
  }

  const perAccount = new Map<string, ApiAccountStat>()
  const planPerAccount = new Map<string, PlanAccountStat>()
  for (const account of args.accounts) {
    perAccount.set(account.id, {
      todayUsd: 0,
      monthUsd: 0,
      sevenActualUsd: 0,
      todayTokens: 0,
      monthTokens: 0,
      monthEstimated: 0,
      allTokens: 0,
      rangeTokens: 0,
      rangeCalls: 0,
      rangeInput: 0,
      rangeOutput: 0,
      rangeCacheRead: 0,
      rangeCacheWrite: 0,
      tokenSpark: Array(7).fill(0),
      ttft: [],
      speed: [],
    })
    planPerAccount.set(account.id, {
      todayTokens: 0,
      monthTokens: 0,
      allTokens: 0,
      rangeTokens: 0,
      rangeCalls: 0,
      rangeInput: 0,
      rangeOutput: 0,
      rangeCacheRead: 0,
      rangeCacheWrite: 0,
      credits: 0,
      ttft: [],
      speed: [],
      spark: Array(7).fill(0),
    })
  }

  const dates = lastNDates(args.days, now)
  const sparkDates = lastNDates(7, now)
  const sparkIndex = new Map(sparkDates.map((date, index) => [date, index]))
  const emptyDay = () => ({ costUsd: 0, actualUsd: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  const trendMap = new Map(dates.map((date) => [date, { date, ...emptyDay() }]))
  const modelMap = new Map<
    string,
    {
      costUsd: number
      actualUsd: number
      tokens: number
      calls: number
      estimated: number
      cacheRead: number
      cacheWrite: number
      ttft: number[]
      speed: number[]
      speedEstimated: boolean
      providers: Set<string>
    }
  >()
  /** model → date → tokens，用于把按量走势也按模型拆成多条线。 */
  const apiModelDayMap = new Map<string, Map<string, number>>()
  const accountRange = new Map<string, { costUsd: number; actualUsd: number; tokens: number }>()
  const trendAccountMap = new Map<string, { date: string; accountId: string; costUsd: number; tokens: number }>()

  let todayUsd = 0
  let monthUsd = 0
  let todayActualUsd = 0
  let monthActualUsd = 0
  let todayTokens = 0
  /** 今日 24 小时的 token 分布（按模型拆开），「今日」区间用来画堆叠柱状图。 */
  const hourApiByModel = new Map<string, number[]>()
  const hourPlanByModel = new Map<string, number[]>()
  /** 把一条记录记进「模型 × 小时」的桶。 */
  const addHourly = (map: Map<string, number[]>, model: string, ts: number, tokens: number) => {
    const series = map.get(model) ?? Array(24).fill(0)
    series[new Date(ts).getHours()] += tokens
    map.set(model, series)
  }
  let monthTokens = 0
  let todayInput = 0
  let todayOutput = 0
  let todayCacheRead = 0
  let todayCacheWrite = 0
  let monthEstimated = 0

  for (const record of apiUsage) {
    const tokens =
      record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens
    const usd = record.costUsdMicros / 1_000_000
    const stat = perAccount.get(record.accountId)
    if (stat) {
      stat.allTokens += tokens
      if (!stat.last || record.ts >= stat.last.ts) {
        stat.last = { ts: record.ts, model: record.model, durationMs: record.durationMs }
      }
      if (record.ts >= sevenStart) {
        const sparkIdx = sparkIndex.get(dateKey(record.ts))
        if (sparkIdx !== undefined) stat.tokenSpark[sparkIdx] += tokens
      }
      // 区间口径：卡片上的输入/输出/缓存/速度/首字只算所选区间。
      if (record.ts >= rangeStart) {
        stat.rangeTokens += tokens
        stat.rangeCalls += 1
        stat.rangeInput += record.inputTokens
        stat.rangeOutput += record.outputTokens
        stat.rangeCacheRead += record.cacheReadTokens
        stat.rangeCacheWrite += record.cacheWriteTokens
        if (record.ttftMs !== undefined) stat.ttft.push(record.ttftMs)
        if (record.tokensPerSecond !== undefined) {
          stat.speed.push(record.tokensPerSecond)
          stat.speedEstimated ||= estimatedSpeed(record)
        }
      }
    }
    if (record.ts < rangeStart && record.ts < monthStart) continue
    const isToday = record.ts >= todayStart
    const isMonth = record.ts >= monthStart
    const isSeven = record.ts >= sevenStart
    if (isToday) {
      todayUsd += usd
      todayTokens += tokens
      addHourly(hourApiByModel, record.model, record.ts, tokens)
      todayInput += record.inputTokens
      todayOutput += record.outputTokens
      todayCacheRead += record.cacheReadTokens
      todayCacheWrite += record.cacheWriteTokens
    }
    if (isMonth) {
      monthUsd += usd
      monthTokens += tokens
      if (record.costEstimated) monthEstimated += usd
    }
    if (!record.costEstimated) {
      if (isToday) todayActualUsd += usd
      if (isMonth) monthActualUsd += usd
    }
    if (stat) {
      if (isToday) {
        stat.todayUsd += usd
        stat.todayTokens += tokens
      }
      if (isMonth) {
        stat.monthUsd += usd
        stat.monthTokens += tokens
        if (record.costEstimated) stat.monthEstimated += usd
      }
      if (isSeven && !record.costEstimated) stat.sevenActualUsd += usd
    }
    if (record.ts >= rangeStart) {
      const bucket = trendMap.get(dateKey(record.ts))
      if (bucket) {
        bucket.costUsd += usd
        if (!record.costEstimated) bucket.actualUsd += usd
        bucket.tokens += tokens
        bucket.input += record.inputTokens
        bucket.output += record.outputTokens
        bucket.cacheRead += record.cacheReadTokens
        bucket.cacheWrite += record.cacheWriteTokens
      }
      const model =
        modelMap.get(record.model) ??
        {
          costUsd: 0,
          actualUsd: 0,
          tokens: 0,
          calls: 0,
          estimated: 0,
          cacheRead: 0,
          cacheWrite: 0,
          ttft: [] as number[],
          speed: [] as number[],
          speedEstimated: false,
          providers: new Set<string>(),
        }
      model.costUsd += usd
      model.tokens += tokens
      model.calls += 1
      model.cacheRead += record.cacheReadTokens
      model.cacheWrite += record.cacheWriteTokens
      if (record.ttftMs !== undefined) model.ttft.push(record.ttftMs)
      if (record.tokensPerSecond !== undefined) {
        model.speed.push(record.tokensPerSecond)
        model.speedEstimated ||= estimatedSpeed(record)
      }
      const modelProviderHint = record.meta?.provider
      if (typeof modelProviderHint === 'string' && modelProviderHint) model.providers.add(modelProviderHint)
      if (record.costEstimated) model.estimated += usd
      else model.actualUsd += usd
      modelMap.set(record.model, model)
      const modelDay = apiModelDayMap.get(record.model) ?? new Map<string, number>()
      modelDay.set(dateKey(record.ts), (modelDay.get(dateKey(record.ts)) ?? 0) + tokens)
      apiModelDayMap.set(record.model, modelDay)
      const acc = accountRange.get(record.accountId) ?? { costUsd: 0, actualUsd: 0, tokens: 0 }
      acc.costUsd += usd
      if (!record.costEstimated) acc.actualUsd += usd
      acc.tokens += tokens
      accountRange.set(record.accountId, acc)
      const dayKey = dateKey(record.ts)
      const trendAccountKey = `${dayKey}|${record.accountId}`
      const trendAccount = trendAccountMap.get(trendAccountKey) ?? {
        date: dayKey,
        accountId: record.accountId,
        costUsd: 0,
        tokens: 0,
      }
      trendAccount.costUsd += usd
      trendAccount.tokens += tokens
      trendAccountMap.set(trendAccountKey, trendAccount)
    }
  }

  const planTrendMap = new Map<
    string,
    { date: string; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number }
  >()
  /** model → date → tokens，用于把走势图按模型拆成多条线。 */
  const planModelDayMap = new Map<string, Map<string, number>>()
  const planModelMap = new Map<
    string,
    {
      tokens: number
      calls: number
      cacheRead: number
      cacheWrite: number
      ttft: number[]
      speed: number[]
      speedEstimated: boolean
      providers: Set<string>
    }
  >()
  let planTodayTokens = 0
  let planMonthTokens = 0
  let planRangeTokens = 0
  let planRangeCalls = 0
  let planAllTokens = 0
  let planAllCalls = 0
  let planCredits = 0
  let planFirstTs: number | undefined
  let planLastTs: number | undefined
  let planInput = 0
  let planOutput = 0
  let planCacheRead = 0
  let planCacheWrite = 0
  const planTtft: number[] = []
  const planSpeed: number[] = []
  let planSpeedEstimated = false

  for (const record of planUsage) {
    const tokens =
      record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens
    const isToday = record.ts >= todayStart
    const isMonth = record.ts >= monthStart
    if (isToday) {
      planTodayTokens += tokens
      addHourly(hourPlanByModel, record.model, record.ts, tokens)
    }
    if (isMonth) planMonthTokens += tokens
    planAllTokens += tokens
    planAllCalls += 1
    planCredits += numberValue(record.meta?.credits)
    planFirstTs = planFirstTs === undefined ? record.ts : Math.min(planFirstTs, record.ts)
    planLastTs = planLastTs === undefined ? record.ts : Math.max(planLastTs, record.ts)

    const day = dateKey(record.ts)
    // 走势、模型 Top 与"缓存命中/首字"这组指标都跟着所选区间；累计口径仍是全历史。
    if (record.ts >= rangeStart) {
      planRangeTokens += tokens
      planRangeCalls += 1
      planInput += record.inputTokens
      planOutput += record.outputTokens
      planCacheRead += record.cacheReadTokens
      planCacheWrite += record.cacheWriteTokens
      if (record.ttftMs !== undefined) planTtft.push(record.ttftMs)
      if (record.tokensPerSecond !== undefined) {
        planSpeed.push(record.tokensPerSecond)
        planSpeedEstimated ||= estimatedSpeed(record)
      }

      const bucket = planTrendMap.get(day) ?? {
        date: day,
        tokens: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }
      bucket.tokens += tokens
      bucket.input += record.inputTokens
      bucket.output += record.outputTokens
      bucket.cacheRead += record.cacheReadTokens
      bucket.cacheWrite += record.cacheWriteTokens
      planTrendMap.set(day, bucket)

      const modelDay = planModelDayMap.get(record.model) ?? new Map<string, number>()
      modelDay.set(day, (modelDay.get(day) ?? 0) + tokens)
      planModelDayMap.set(record.model, modelDay)
    }

    const stat = planPerAccount.get(record.accountId)
    if (stat) {
      if (isToday) stat.todayTokens += tokens
      if (isMonth) stat.monthTokens += tokens
      stat.allTokens += tokens
      stat.credits += numberValue(record.meta?.credits)
      if (record.ts >= sevenStart) {
        const sparkIdx = sparkIndex.get(day)
        if (sparkIdx !== undefined) stat.spark[sparkIdx] += tokens
      }
      if (!stat.last || record.ts >= stat.last.ts) {
        stat.last = { ts: record.ts, model: record.model, durationMs: record.durationMs }
      }
      if (record.ts >= rangeStart) {
        stat.rangeTokens += tokens
        stat.rangeCalls += 1
        stat.rangeInput += record.inputTokens
        stat.rangeOutput += record.outputTokens
        stat.rangeCacheRead += record.cacheReadTokens
        stat.rangeCacheWrite += record.cacheWriteTokens
        if (record.ttftMs !== undefined) stat.ttft.push(record.ttftMs)
        if (record.tokensPerSecond !== undefined) {
          stat.speed.push(record.tokensPerSecond)
          stat.speedEstimated ||= estimatedSpeed(record)
        }
      }
    }

    if (record.ts >= rangeStart) {
      const model = planModelMap.get(record.model) ?? {
        tokens: 0,
        calls: 0,
        cacheRead: 0,
        cacheWrite: 0,
        ttft: [] as number[],
        speed: [] as number[],
        speedEstimated: false,
        providers: new Set<string>(),
      }
      model.tokens += tokens
      model.calls += 1
      model.cacheRead += record.cacheReadTokens
      model.cacheWrite += record.cacheWriteTokens
      if (record.ttftMs !== undefined) model.ttft.push(record.ttftMs)
      if (record.tokensPerSecond !== undefined) {
        model.speed.push(record.tokensPerSecond)
        model.speedEstimated ||= estimatedSpeed(record)
      }
      const providerHint = record.meta?.provider
      if (typeof providerHint === 'string' && providerHint) model.providers.add(providerHint)
      planModelMap.set(record.model, model)
    }
  }

  // 周额度反推要按账户取当前周期内的套餐日志；循环结束后一次分桶，避免逐账户重复扫全量记录。
  const planUsageByAccount = new Map<string, UsageRecord[]>()
  for (const record of planUsage) {
    const list = planUsageByAccount.get(record.accountId)
    if (list) list.push(record)
    else planUsageByAccount.set(record.accountId, [record])
  }

  let balanceDisplay = 0
  const balanceByCurrency: Record<string, number> = {}
  const accountSummaries = args.accounts.map((account) => {
    const preset = args.providers.get(account.providerId)
    const stat = perAccount.get(account.id)!
    const planStat = planPerAccount.get(account.id)!
    const balanceSnapshot = args.latest.get(`${account.id}:balance`) ?? args.latest.get(`${account.id}:relay`)
    const planSnapshot = args.latest.get(`${account.id}:plan`)
    const isManual = preset?.category === 'manual'
    const manualBalance = isManual ? manualBalanceOf(account, args.ledger) : null
    const manualWindows = isManual ? manualWindowsOf(account) : []
    const balance = manualBalance?.amount ?? balanceSnapshot?.balance
    const currency = manualBalance?.currency ?? balanceSnapshot?.currency
    const windows = manualWindows.length ? manualWindows : planSnapshot?.windows ?? balanceSnapshot?.windows
    const quotaSnapshot = manualWindows.length ? undefined : planSnapshot?.windows ? planSnapshot : balanceSnapshot
    const quotaHistory = (args.quotaHistory ?? []).filter(snapshot => snapshot.accountId === account.id && snapshot.kind === quotaSnapshot?.kind)
    const quotaForecasts = account.enabled && args.sync[account.id]?.status !== 'error' && quotaSnapshot
      ? (windows ?? []).flatMap(window => {
          const forecast = estimateQuotaDepletion(window, quotaHistory, now, Math.max(30 * 60_000, args.settings.refreshTtlMin * 2 * 60_000))
          return forecast ? [forecast] : []
        })
      : []
    const weeklyQuotaEstimates = account.enabled && quotaSnapshot
      ? (windows ?? []).flatMap(window => {
          const estimate = estimateWeeklyQuota(window, planUsageByAccount.get(account.id) ?? [], quotaHistory, quotaSnapshot.at, now)
          return estimate ? [estimate] : []
        })
      : []
    if (balance !== undefined && currency) {
      balanceByCurrency[currency] = (balanceByCurrency[currency] ?? 0) + balance
      balanceDisplay += convertCurrency(balance, currency, displayCurrency, fx)
    }
    const sync = args.sync[account.id]
    const status: 'ok' | 'error' | 'never' | 'disabled' = !account.enabled
      ? 'disabled'
      : sync?.status === 'error'
        ? 'error'
        : sync?.at
          ? 'ok'
          : 'never'
    const burn7Actual = stat.sevenActualUsd / 7
    const balanceUsd = balance !== undefined && currency ? convertCurrency(balance, currency, 'USD', fx) : undefined
    // 可用天数只按实际计费的花费推算；只有价目估算时不猜还能撑多久。
    const daysLeft = burn7Actual > 0.000001 && balanceUsd !== undefined ? Math.max(0, balanceUsd / burn7Actual) : undefined
    const apiStats = tokenStatsOf(stat)
    const planStats = tokenStatsOf(planStat)
    return {
      accountId: account.id,
      providerId: account.providerId,
      providerName: preset?.name ?? account.providerId,
      label: account.label,
      enabled: account.enabled,
      category: preset?.category ?? 'manual',
      stability: preset?.stability ?? 'manual',
      status,
      lastAt: sync?.at,
      error: sync?.message,
      billingMode: summaryModes.get(account.id) ?? 'api',
      kind: (planSnapshot?.kind ?? balanceSnapshot?.kind) as AccountSummaryKind,
      balance,
      currency,
      balanceDisplay: balance !== undefined && currency ? convertCurrency(balance, currency, displayCurrency, fx) : undefined,
      windows,
      quotaUpdatedAt: quotaSnapshot?.at ?? (manualWindows.length ? sync?.at : undefined),
      quotaForecasts,
      weeklyQuotaEstimates: weeklyQuotaEstimates.length > 0 ? weeklyQuotaEstimates : undefined,
      planLabel: manualWindows.length ? account.options.manualPlan?.planLabel : planSnapshot?.planLabel ?? balanceSnapshot?.planLabel,
      planExpiresAt: typeof planSnapshot?.extras?.subscriptionEndTime === 'number' ? planSnapshot.extras.subscriptionEndTime : account.options.planExpiresAt,
      todayUsd: stat.todayUsd,
      monthUsd: stat.monthUsd,
      /** 本月厂商实际计费的部分（本月合计 − 估算部分）。 */
      monthActualUsd: Math.max(0, stat.monthUsd - stat.monthEstimated),
      todayTokens: stat.todayTokens,
      monthTokens: stat.monthTokens,
      daysLeft,
      apiStats,
      planStats: planStats ? { ...planStats, credits: planStat.credits } : undefined,
      planTokenSparkline: planStat.spark,
      apiTokenSparkline: stat.tokenSpark,
    }
  })

  /** 走势拆线：Top N 模型各一条线，其余合并成「其他 N 个模型」，日期轴固定用所选区间。 */
  const TREND_MODEL_LIMIT = 4
  const splitTrendByModel = (
    dayMap: Map<string, Map<string, number>>,
    axis: string[],
  ): Array<{ model: string; points: Array<{ date: string; tokens: number }> }> => {
    const ranked = [...dayMap.entries()]
      .map(([model, days]) => ({ model, total: [...days.values()].reduce((sum, value) => sum + value, 0) }))
      .sort((a, b) => b.total - a.total)
    const top = ranked.slice(0, TREND_MODEL_LIMIT)
    const rest = ranked.slice(TREND_MODEL_LIMIT)
    if (axis.length === 0) return []
    return [
      ...top.map((item) => ({
        model: item.model,
        points: axis.map((date) => ({ date, tokens: dayMap.get(item.model)?.get(date) ?? 0 })),
      })),
      ...(rest.length > 0
        ? [
            {
              model: `其他 ${rest.length} 个模型`,
              points: axis.map((date) => ({
                date,
                tokens: rest.reduce((sum, item) => sum + (dayMap.get(item.model)?.get(date) ?? 0), 0),
              })),
            },
          ]
        : []),
    ]
  }

  /** 今日 24 小时按模型拆分：Top N 模型各一组，其余合并成「其他 N 个模型」。 */
  const splitHourlyByModel = (
    modelHourMap: Map<string, number[]>,
  ): Array<{ model: string; points: number[] }> => {
    const ranked = [...modelHourMap.entries()]
      .map(([model, points]) => ({ model, total: points.reduce((sum, value) => sum + value, 0) }))
      .sort((a, b) => b.total - a.total)
    const top = ranked.slice(0, TREND_MODEL_LIMIT)
    const rest = ranked.slice(TREND_MODEL_LIMIT)
    return [
      ...top.map((item) => ({ model: item.model, points: modelHourMap.get(item.model)! })),
      ...(rest.length > 0
        ? [
            {
              model: `其他 ${rest.length} 个模型`,
              points: Array.from({ length: 24 }, (_, hour) =>
                rest.reduce((sum, item) => sum + (modelHourMap.get(item.model)?.[hour] ?? 0), 0),
              ),
            },
          ]
        : []),
    ]
  }

  const byModel: ModelUsageRow[] = [...modelMap.entries()]
    .map(([model, value]) => ({
      model,
      tokens: value.tokens,
      calls: value.calls,
      cacheRead: value.cacheRead,
      cacheWrite: value.cacheWrite,
      ttftP50: median(value.ttft),
      speedP50: median(value.speed),
      speedEstimated: value.speedEstimated || undefined,
      providers: [...value.providers].slice(0, 3),
      costUsd: value.costUsd,
      actualUsd: value.actualUsd,
      estimatedShare: value.costUsd > 0 ? (value.estimated / value.costUsd) * 100 : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens || b.costUsd - a.costUsd)
    .slice(0, 12)

  const byAccount = [...accountRange.entries()]
    .map(([accountId, value]) => ({
      accountId,
      label: accountByKey.get(accountId)?.label ?? accountId,
      costUsd: value.costUsd,
      actualUsd: value.actualUsd,
      tokens: value.tokens,
    }))
    .sort((a, b) => b.tokens - a.tokens)

  const planByModel: ModelUsageRow[] = [...planModelMap.entries()]
    .map(([model, value]) => ({
      model,
      tokens: value.tokens,
      calls: value.calls,
      cacheRead: value.cacheRead,
      cacheWrite: value.cacheWrite,
      ttftP50: median(value.ttft),
      speedP50: median(value.speed),
      speedEstimated: value.speedEstimated || undefined,
      providers: [...value.providers].slice(0, 3),
      costUsd: 0,
      actualUsd: 0,
      estimatedShare: 0,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 12)

  // 两个 Tab 的走势共用所选区间的日期轴，切换范围时轴线一致。
  const planDates = dates
  const planTrendByModel = splitTrendByModel(planModelDayMap, planDates)
  const apiTrendByModel = splitTrendByModel(apiModelDayMap, planDates)

  return {
    generatedAt: now,
    totals: {
      balanceDisplay,
      displayCurrency,
      balanceByCurrency,
      todayUsd,
      todayDisplay: convertCurrency(todayUsd, 'USD', displayCurrency, fx),
      todayActualUsd,
      todayActualDisplay: convertCurrency(todayActualUsd, 'USD', displayCurrency, fx),
      monthUsd,
      monthDisplay: convertCurrency(monthUsd, 'USD', displayCurrency, fx),
      monthActualUsd,
      monthActualDisplay: convertCurrency(monthActualUsd, 'USD', displayCurrency, fx),
      todayTokens,
      monthTokens,
      todayInput,
      todayOutput,
      todayCacheRead,
      todayCacheWrite,
      cacheHitRate: todayInput + todayCacheRead > 0 ? (todayCacheRead / (todayInput + todayCacheRead)) * 100 : 0,
    },
    accounts: accountSummaries,
    trend: dates.map((date) => trendMap.get(date)!),
    byModel,
    byAccount,
    trendByAccount: [...trendAccountMap.values()]
      .map((item) => ({ ...item, label: accountByKey.get(item.accountId)?.label ?? item.accountId }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.accountId.localeCompare(b.accountId)),
    planTotals: {
      todayTokens: planTodayTokens,
      monthTokens: planMonthTokens,
      rangeTokens: planRangeTokens,
      allTokens: planAllTokens,
      allCalls: planAllCalls,
      firstTs: planFirstTs,
      lastTs: planLastTs,
      // 以下都是所选区间口径，和卡片上的指标同一条时间线。
      calls: planRangeCalls,
      input: planInput,
      output: planOutput,
      cacheRead: planCacheRead,
      cacheWrite: planCacheWrite,
      cacheHitRate: planInput + planCacheRead > 0 ? (planCacheRead / (planInput + planCacheRead)) * 100 : 0,
      credits: planCredits,
      ttftP50: median(planTtft),
      speedP50: median(planSpeed),
      speedEstimated: planSpeedEstimated || undefined,
    },
    today: { api: splitHourlyByModel(hourApiByModel), plan: splitHourlyByModel(hourPlanByModel) },
    planByModel,
    planTrend: planDates.map(
      (date) => planTrendMap.get(date) ?? { date, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ),
    planTrendByModel,
    apiTrendByModel,
  }
}

type AccountSummaryKind = 'balance' | 'plan' | 'usage' | 'relay' | 'manual' | undefined
