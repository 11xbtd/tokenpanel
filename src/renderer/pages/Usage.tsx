import { useMemo } from 'react'
import { BarChart3 } from 'lucide-react'
import { useApp } from '../lib/app-context'
import { useDark } from '../lib/theme'
import { axisColors, Chart } from '../components/Chart'
import { RANGE_OPTIONS, rangeLabelOf } from '../components/ConsumeBlocks'
import { EmptyState, Segmented, Section, Stat, StatRow } from '../components/Common'
import { chartColors, formatMoney, formatPct, formatTokens, shortDate } from '../lib/format'
import { providerInkColor } from '../lib/provider-brand'

export function UsagePage() {
  const { bootstrap, overview: data, days, setDays } = useApp()
  const dark = useDark()

  const currency = data.totals.displayCurrency
  const fx = bootstrap.settings.fxUsdCny
  const toDisplay = (usd: number) => usd * (currency === 'CNY' ? fx : 1)
  const money = (usd: number, maxFrac?: number) => formatMoney(toDisplay(usd), currency, maxFrac)
  const colors = axisColors(dark)
  const palette = chartColors(dark)
  const accountColors = useMemo(() => new Map(bootstrap.accounts.map((account, index) => [
    account.id,
    providerInkColor(account.providerId, dark, palette[index % palette.length]),
  ])), [bootstrap.accounts, dark, palette])

  const summary = useMemo(() => {
    const cost = data.trend.reduce((total, item) => total + item.costUsd, 0)
    const actualCost = data.trend.reduce((total, item) => total + item.actualUsd, 0)
    const tokens = data.trend.reduce((total, item) => total + item.tokens, 0)
    const calls = data.byModel.reduce((total, item) => total + item.calls, 0)
    const input = data.trend.reduce((total, item) => total + item.input, 0)
    const output = data.trend.reduce((total, item) => total + item.output, 0)
    const cacheRead = data.trend.reduce((total, item) => total + item.cacheRead, 0)
    const cacheWrite = data.trend.reduce((total, item) => total + item.cacheWrite, 0)
    return {
      cost,
      actualCost,
      tokens,
      calls,
      input,
      output,
      cacheRead,
      cacheWrite,
      cacheHit: input + cacheRead > 0 ? (cacheRead / (input + cacheRead)) * 100 : 0,
    }
  }, [data])

  const stacked = useMemo(() => {
    const dates = data.trend.map((item) => item.date)
    const top = data.byAccount.slice(0, 6)
    const index = new Map<string, Map<string, number>>()
    for (const row of data.trendByAccount) {
      const map = index.get(row.accountId) ?? new Map<string, number>()
      map.set(row.date, (map.get(row.date) ?? 0) + row.tokens)
      index.set(row.accountId, map)
    }
    const series = top.map((account, i) => ({
      name: account.label,
      type: 'bar',
      stack: 'total',
      barMaxWidth: 18,
      itemStyle: { color: accountColors.get(account.accountId) ?? palette[i % palette.length] },
      data: dates.map((date) => index.get(account.accountId)?.get(date) ?? 0),
    }))
    if (data.byAccount.length > 6) {
      const rest = data.byAccount.slice(6).map((item) => item.accountId)
      series.push({
        name: '其他',
        type: 'bar',
        stack: 'total',
        barMaxWidth: 18,
        itemStyle: { color: palette[7] },
        data: dates.map((date) => rest.reduce((total, id) => total + (index.get(id)?.get(date) ?? 0), 0)),
      })
    }
    return {
      grid: { left: 6, right: 10, top: 34, bottom: 6, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: colors.tooltipBg,
        borderColor: colors.tooltipBorder,
        textStyle: { color: colors.tooltipText, fontSize: 11 },
        valueFormatter: (value: unknown) => `${formatTokens(Number(value))} tokens`,
      },
      legend: {
        type: 'scroll', top: 0, icon: 'roundRect',
        textStyle: { color: colors.text, fontSize: 11 },
        pageTextStyle: { color: colors.text },
        itemWidth: 10, itemHeight: 8,
      },
      xAxis: {
        type: 'category',
        data: dates.map(shortDate),
        axisLine: { lineStyle: { color: colors.split } },
        axisTick: { show: false },
        axisLabel: { color: colors.text, fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: colors.split } },
        axisLabel: { color: colors.text, fontSize: 10, formatter: (value: number) => formatTokens(value) },
      },
      series,
    }
  }, [data, colors, accountColors, palette])

  const donut = useMemo(() => {
    const items = [
      { name: '非缓存输入', value: summary.input, color: palette[0] },
      { name: '输出', value: summary.output, color: palette[1] },
      { name: '缓存读', value: summary.cacheRead, color: palette[3] },
      { name: '缓存写', value: summary.cacheWrite, color: palette[2] },
    ]
    return {
      tooltip: {
        trigger: 'item',
        backgroundColor: colors.tooltipBg,
        borderColor: colors.tooltipBorder,
        textStyle: { color: colors.tooltipText, fontSize: 11 },
        valueFormatter: (value: unknown) => formatTokens(Number(value)),
      },
      legend: { bottom: 0, textStyle: { color: colors.text, fontSize: 11 }, itemWidth: 10, itemHeight: 8 },
      series: [
        {
          type: 'pie',
          radius: ['52%', '72%'],
          center: ['50%', '44%'],
          avoidLabelOverlap: true,
          label: { show: false },
          data: items.map((item) => ({ name: item.name, value: item.value, itemStyle: { color: item.color } })),
        },
      ],
    }
  }, [summary, colors, palette])

  const empty = summary.tokens === 0 && summary.cost === 0
  const rangeLabel = rangeLabelOf(days)

  return (
    <div>
      <div className="sticky-bar flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2.5 md:px-6">
        <div className="flex items-center gap-2.5">
          <span className="eyebrow">统计范围</span>
          <Segmented value={days} onChange={setDays} options={RANGE_OPTIONS} />
        </div>
        <div className="text-[11.5px] faint">只统计按量 API / 中转 / 导入，套餐在「总览 → 订阅套餐」</div>
      </div>
      <div key={days} className="fade-in space-y-4 p-3 md:p-6">

      {empty ? (
        <div className="card">
          <EmptyState
            icon={BarChart3}
            title="这段时间还没有消耗记录"
            description="接入官方用量接口、中转站日志，或在设置里导入 CSV 账单后，这里会出现按天与按模型的拆解。"
          />
        </div>
      ) : (
        <>
          <StatRow>
            <Stat
              primary
              label={`${rangeLabel} token`}
              value={formatTokens(summary.tokens)}
              sub={`日均 ${formatTokens(summary.tokens / days)} · ${summary.calls} 次调用`}
            />
            <Stat
              label="总输入 / 输出"
              value={`${formatTokens(summary.input + summary.cacheRead + summary.cacheWrite)} / ${formatTokens(summary.output)}`}
              sub={`缓存写 ${formatTokens(summary.cacheWrite)}`}
            />
            <Stat label="缓存命中率" value={formatPct(summary.cacheHit, 1)} sub={`缓存读 ${formatTokens(summary.cacheRead)}`} />
            <Stat
              label="实际计费"
              value={summary.actualCost > 0 ? money(summary.actualCost, 2) : '—'}
              sub={summary.actualCost > 0 ? '来自官方账单 / 中转日志 / CSV 导入' : '这些厂商只给余额'}
            />
          </StatRow>

          <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
            <Section title="每日 token（按账户）" extra={<span className="text-[11px] faint">tokens</span>}>
              {stacked ? <Chart option={stacked} height={280} /> : null}
            </Section>
            <Section title="Token 构成">
              {donut ? <Chart option={donut} height={280} /> : null}
            </Section>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Section title="按账户" bodyClassName="p-0">
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>账户</th>
                      <th className="text-right">Token</th>
                      <th className="text-right">实际计费</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byAccount.map((account) => (
                      <tr key={account.accountId}>
                        <td className="max-w-[220px]" title={account.label}>
                          <div className="flex items-center gap-2">
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full" aria-hidden="true" style={{ background: accountColors.get(account.accountId) ?? palette[7] }} />
                            <span className="truncate">{account.label}</span>
                          </div>
                        </td>
                        <td className="text-right num">{formatTokens(account.tokens)}</td>
                        <td className="text-right num" title={account.actualUsd <= 0 ? '厂商未返回实际账单金额，估算值不展示' : undefined}>
                          {account.actualUsd > 0 ? money(account.actualUsd, 2) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
            <Section title="按模型" bodyClassName="p-0">
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th className="text-right">Token</th>
                      <th className="text-right">调用</th>
                      <th className="text-right">实际计费</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byModel.map((model) => (
                      <tr key={model.model}>
                        <td className="max-w-[240px] truncate" title={model.model}>{model.model}</td>
                        <td className="text-right num">{formatTokens(model.tokens)}</td>
                        <td className="text-right num">{model.calls}</td>
                        <td className="text-right num" title={model.actualUsd <= 0 ? '厂商未返回实际账单金额，估算值不展示' : undefined}>
                          {model.actualUsd > 0 ? money(model.actualUsd, 2) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          </div>
        </>
      )}
      </div>
    </div>
  )
}
