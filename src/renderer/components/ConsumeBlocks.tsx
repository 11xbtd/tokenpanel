import { useMemo } from 'react'
import type { ModelUsageRow } from '../../core/types'
import { suggestedProviders } from '../../core/logs/attribution'
import { useApp } from '../lib/app-context'
import { useDark } from '../lib/theme'
import { axisColors, Chart } from './Chart'
import { Badge, Section } from './Common'
import { chartColors, formatDuration, formatSpeed, formatTokens, shortDate } from '../lib/format'

export const RANGE_OPTIONS = [
  { value: 1, label: '今日' },
  { value: 7, label: '近一周' },
  { value: 30, label: '近一月' },
  { value: 365, label: '近一年' },
]

export function rangeLabelOf(days: number): string {
  if (days === 1) return '今日'
  if (days === 7) return '近 7 天'
  if (days === 365) return '近一年'
  return '近 30 天'
}

const HOURS = Array.from({ length: 24 }, (_, hour) => `${hour}时`)

/**
 * 走势图的 ECharts 配置。给了 hourly 就画当天 24 小时堆叠柱状（按模型分段），
 * 否则画按日堆叠面积图（按模型拆线）。
 */
export function buildTrendOption({
  groups,
  dates,
  hourly,
  dark,
}: {
  groups: Array<{ model: string; points: Array<{ date: string; tokens: number }> }>
  dates: string[]
  hourly?: Array<{ model: string; points: number[] }>
  dark: boolean
}) {
  const colors = axisColors(dark)
  const palette = chartColors(dark)
  const tooltip = {
    trigger: 'axis',
    backgroundColor: colors.tooltipBg,
    borderColor: colors.tooltipBorder,
    textStyle: { color: colors.tooltipText, fontSize: 11 },
    valueFormatter: (value: unknown) => `${formatTokens(Number(value))} tokens`,
  }
  const legend = {
    type: 'scroll',
    top: 0,
    right: 0,
    icon: 'roundRect',
    itemWidth: 8,
    itemHeight: 8,
    itemGap: 10,
    textStyle: { color: colors.text, fontSize: 11 },
    pageTextStyle: { color: colors.text },
    pageIconColor: colors.text,
    pageIconInactiveColor: colors.split,
  }
  const axis = (data: string[]) => ({
    type: 'category',
    boundaryGap: Boolean(hourly),
    data,
    axisLine: { lineStyle: { color: colors.split } },
    axisTick: { show: false },
    axisLabel: { color: colors.text, fontSize: 10, hideOverlap: true, interval: 'auto' },
  })
  const valueAxis = {
    type: 'value',
    splitLine: { lineStyle: { color: colors.split } },
    axisLabel: { color: colors.text, fontSize: 10, formatter: (value: number) => formatTokens(value) },
  }
  const grid = { left: 6, right: 10, top: 30, bottom: 6, containLabel: true }

  if (hourly) {
    const series = hourly.map((group, index) => {
      const others = group.model.startsWith('其他 ')
      const color = others ? palette[7] : palette[index % palette.length]
      return {
        name: group.model,
        type: 'bar',
        stack: 'total',
        barMaxWidth: 18,
        data: group.points,
        // 堆叠里最后一段在最上面，只有它做圆角。
        itemStyle: { color, borderRadius: index === hourly.length - 1 ? [2, 2, 0, 0] : 0 },
        emphasis: { focus: 'series' },
      }
    })
    return { grid, legend, tooltip, xAxis: axis(HOURS), yAxis: valueAxis, series }
  }

  const series = groups.map((group, index) => {
    const others = group.model.startsWith('其他 ')
    const color = others ? palette[7] : palette[index % palette.length]
    return {
      name: group.model,
      type: 'line',
      stack: 'total',
      smooth: false,
      symbol: 'none',
      sampling: 'lttb',
      data: group.points.map((point) => point.tokens),
      lineStyle: { width: 1.4, color, opacity: others ? 0.65 : 1 },
      itemStyle: { color },
      areaStyle: { color, opacity: others ? 0.1 : dark ? 0.28 : 0.22 },
      emphasis: { focus: 'series' },
    }
  })
  return {
    color: palette,
    grid,
    legend,
    tooltip,
    xAxis: axis(dates.map(shortDate)),
    yAxis: valueAxis,
    series,
  }
}

/** 按模型分色的 token 走势；选「今日」时改画当天 24 小时堆叠柱状。 */
export function TokenTrend({
  groups,
  dates,
  hourly,
  emptyText,
}: {
  groups: Array<{ model: string; points: Array<{ date: string; tokens: number }> }>
  dates: string[]
  hourly?: Array<{ model: string; points: number[] }>
  emptyText: string
}) {
  const dark = useDark()

  const option = useMemo(
    () => buildTrendOption({ groups, dates, hourly, dark }),
    [groups, dates, hourly, dark],
  )

  if (hourly ? hourly.every((group) => group.points.every((value) => value === 0)) : groups.length === 0) {
    return <div className="py-10 text-center text-xs muted">{emptyText}</div>
  }
  return <Chart option={option} height={230} />
}

/** 模型排行：两个 Tab 用同一套行样式（tokens + 进度条 + 次数/缓存 + 首字/速度）。 */
export function ModelTokenTop({ rows, emptyText }: { rows: ModelUsageRow[]; emptyText: string }) {
  const { bootstrap } = useApp()
  const providerNames = useMemo(
    () => new Map(bootstrap.providers.map((provider) => [provider.id, provider.name])),
    [bootstrap.providers],
  )
  const maxTokens = Math.max(...rows.map((row) => row.tokens), 1)

  if (rows.length === 0) {
    return <div className="py-10 text-center text-xs muted">{emptyText}</div>
  }
  return (
    <div className="space-y-2.5">
      {rows.slice(0, 8).map((row) => {
        const candidates = suggestedProviders(row.model, row.providers?.[0])
        const hasAccount = candidates.some((providerId) =>
          bootstrap.accounts.some((account) => account.providerId === providerId),
        )
        const missingProvider =
          candidates.length > 0 && !hasAccount ? providerNames.get(candidates[0]) ?? candidates[0] : undefined
        return (
          <div key={row.model} className="min-w-0">
            <div className="flex items-center justify-between gap-2 text-[12px]">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate" title={row.model}>{row.model}</span>
                {missingProvider ? (
                  <span title={`模型名或日志里的厂商线索指向「${missingProvider}」，但还没建该账户，所以落到了日志源的默认绑定上`}>
                    <Badge tone="warn">指向 {missingProvider}</Badge>
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 num">{formatTokens(row.tokens)}</span>
            </div>
            <div className="mt-1.5 h-[3px] overflow-hidden rounded-full" style={{ background: 'var(--bg-subtle)' }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(2, (row.tokens / maxTokens) * 100)}%`,
                  background: 'color-mix(in srgb, var(--accent) 55%, var(--surface))',
                }}
              />
            </div>
            <div className="mt-0.5 flex items-center justify-between text-[10.5px] faint">
              <span>{row.calls} 次 · 缓存读 {formatTokens(row.cacheRead)}</span>
              {row.ttftP50 !== undefined || row.speedP50 !== undefined ? (
                <span>
                  首字 {formatDuration(row.ttftP50)}
                  {' · '}
                  {row.speedP50 !== undefined ? `${row.speedEstimated ? '估速 ' : ''}${formatSpeed(row.speedP50)} tok/s` : '速度 —'}
                </span>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * 走势 + 排行两块。时间范围在页面顶部统一控制（会影响卡片），
 * 所以这里不再放重复的切换器，只在标题上标明当前区间。
 */
export function TokenBlocks({
  days,
  groups,
  dates,
  hourly,
  rows,
  trendEmptyText,
  topEmptyText,
  trendExtra,
}: {
  days: number
  groups: Array<{ model: string; points: Array<{ date: string; tokens: number }> }>
  dates: string[]
  hourly: Array<{ model: string; points: number[] }>
  rows: ModelUsageRow[]
  trendEmptyText: string
  topEmptyText: string
  trendExtra: string
}) {
  const label = rangeLabelOf(days)
  return (
    <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
      <Section title={`${label} token 走势`} extra={<span className="eyebrow">{trendExtra}</span>}>
        <TokenTrend groups={groups} dates={dates} hourly={days === 1 ? hourly : undefined} emptyText={trendEmptyText} />
      </Section>
      <Section title={`${label} 模型排行`} extra={<span className="eyebrow">按 token</span>}>
        <ModelTokenTop rows={rows} emptyText={topEmptyText} />
      </Section>
    </div>
  )
}
