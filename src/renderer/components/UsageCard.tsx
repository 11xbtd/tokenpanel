import { useState, type CSSProperties } from 'react'
import { AlertCircle, ArrowRight, CalendarClock, ChevronDown, GripVertical, Pencil, RefreshCw } from 'lucide-react'
import type { AccountPublic, AccountSummary, QuotaColorThresholds, QuotaWindow, WeeklyQuotaEstimate } from '../../core/types'
import type { CardDragBinding } from '../lib/card-order'
import { quotaColorThresholds, sortQuotaWindows, windowUsedPct } from '../../core/util/quota'
import { formatCountdown, formatDateTime, formatDuration, formatMoney, formatSpeed, formatTokens, planExpiry, remainingTone } from '../lib/format'
import { providerColor, providerInkColor } from '../lib/provider-brand'
import { useDark } from '../lib/theme'
import { useApp } from '../lib/app-context'
import { rangeLabelOf } from './ConsumeBlocks'
import { Badge, Spinner, StatusDot } from './Common'
import { BrandIcon } from './BrandIcon'
import { Sparkline } from './Sparkline'

const WINDOW_ROW_LIMIT = 3
const STATUS_LABELS = { ok: '已同步', error: '刷新失败', never: '待刷新', disabled: '已停用' }

function Metric({ label, value, title, detail }: { label: string; value: string; title?: string; detail?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[10.5px] muted">{label}</div>
      <div className="mt-0.5 truncate text-[12px] font-medium num">{value}</div>
      {detail ? <div className="mt-0.5 truncate text-[10px] faint">{detail}</div> : null}
    </div>
  )
}

/** 条长和数字都表示剩余比例；颜色表示额度的紧张程度。 */
function WindowMeter({ window, thresholds, estimate }: { window: QuotaWindow; thresholds: QuotaColorThresholds; estimate?: WeeklyQuotaEstimate }) {
  const usedPct = Math.min(100, Math.max(0, windowUsedPct(window) ?? 0))
  const remaining = 100 - usedPct
  const tone = remainingTone(remaining, thresholds)
  const detail = `${window.label}：已用 ${usedPct.toFixed(0)}%，剩余 ${remaining.toFixed(0)}%${
    window.total && window.unit ? `，总量 ${window.total} ${window.unit}` : ''
  }，颜色提示：≤${thresholds.warningPct}% 偏低，≤${thresholds.dangerPct}% 将耗尽${window.resetsAt ? `，${formatDateTime(window.resetsAt)}重置` : ''}`
  const estimateTitle = estimate
    ? `按同一周期内相邻快照估算：${formatDateTime(estimate.observedFrom)}–${formatDateTime(estimate.observedTo)} 本机记录 ${formatTokens(estimate.observedTokens)} token，额度上涨 ${estimate.observedPct.toFixed(1)} 个百分点，折算 100% 约为 ${formatTokens(estimate.estimatedTotalTokens)} token。这是下限：其他电脑或未接入日志的客户端用掉的额度不会计入，真实周额度只会更高；厂商按缓存/模型权重计费时也会与纯 token 口径有偏差。${estimate.externalUsageDetected ? '检测到额度上涨但本机没有记录的区间，可能还有其他设备在使用，或部分日志未被导入。' : ''}`
    : undefined
  return (
    <div className="quota-window" title={detail}>
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[10.5px]">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium">{window.label}</span>
          {window.resetsAt ? <span className="truncate faint">{formatCountdown(window.resetsAt)}后重置</span> : null}
        </span>
        <span className="shrink-0 font-medium num" style={{ color: tone === 'ok' ? 'var(--brand-ink)' : `var(--${tone})` }}>{tone === 'warn' ? '偏低 · ' : tone === 'danger' ? '将耗尽 · ' : ''}剩余 {remaining.toFixed(0)}%</span>
      </div>
      <div className="meter" role="progressbar" aria-label={`${window.label}剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remaining)} aria-valuetext={detail}>
        <div className="meter-track" />
        <div className="meter-fill" data-tone={tone} style={{ width: `${remaining}%` }} />
      </div>
      {estimate ? (
        <div className="mt-1 flex items-center justify-between gap-2 text-[10px] faint" title={estimateTitle}>
          <span className="min-w-0 truncate">
            本机记录 {formatTokens(estimate.usedTokens)}
            {estimate.externalUsageDetected ? <span style={{ color: 'var(--warn)' }}> · 可能漏记</span> : null}
          </span>
          <span className="shrink-0">周额度 ≥ {formatTokens(estimate.estimatedTotalTokens)}</span>
        </div>
      ) : null}
    </div>
  )
}

/** 钱只出现在余额与实际计费上；消耗指标跟随页面所选时间范围。 */
export function UsageCard({ summary, account, statsSource, onRefresh, onEdit, refreshing, drag }: {
  summary: AccountSummary
  account?: AccountPublic
  statsSource: 'api' | 'plan'
  onRefresh: (id: string) => void
  onEdit: (account: AccountPublic) => void
  refreshing: boolean
  /** 只在需要排序时传入：卡片本体接收指针事件，把手只是视觉提示。 */
  drag?: CardDragBinding
}) {
  const { bootstrap, overview, days, navigate } = useApp()
  const [expanded, setExpanded] = useState(false)
  const dark = useDark()
  const color = providerColor(summary.providerId, dark)
  const inkColor = providerInkColor(summary.providerId, dark)
  const displayCurrency = overview.totals.displayCurrency
  const fx = bootstrap.settings.fxUsdCny
  const money = (usd: number) => formatMoney(usd * (displayCurrency === 'CNY' ? fx : 1), displayCurrency)
  const rangeLabel = rangeLabelOf(days)
  const stats = statsSource === 'plan' ? summary.planStats : summary.apiStats
  const sparkline = statsSource === 'plan' ? summary.planTokenSparkline : summary.apiTokenSparkline
  const hasTrend = sparkline.some((value) => Number.isFinite(value) && value > 0)
  const credits = statsSource === 'plan' ? (summary.planStats?.credits ?? 0) : 0
  const windows = sortQuotaWindows(summary.windows ?? []).filter((window) => Number.isFinite(windowUsedPct(window)))
  const weeklyEstimates = new Map((summary.weeklyQuotaEstimates ?? []).map((estimate) => [estimate.windowKey, estimate]))
  const worstUsedPct = windows.length ? Math.max(...windows.map((window) => windowUsedPct(window) ?? 0)) : undefined
  const remaining = worstUsedPct !== undefined ? Math.min(100, Math.max(0, 100 - worstUsedPct)) : undefined
  const thresholds = quotaColorThresholds(bootstrap.settings.quotaColors)
  const balanceThreshold = account?.options.thresholds?.balanceBelow ?? bootstrap.settings.alerts.balanceBelowDefault
  const balanceTone = summary.balance !== undefined && summary.balance <= 0
    ? 'danger'
    : summary.balance !== undefined && balanceThreshold !== undefined && balanceThreshold > 0 && summary.balance < balanceThreshold
      ? 'warn'
      : 'ok'
  // 套餐页优先显示窗口；混合账户在按量页显示余额。
  const showQuotaHero = remaining !== undefined && (statsSource === 'plan' || summary.balance === undefined)
  const heroTone = showQuotaHero ? remainingTone(remaining, thresholds) : summary.balance !== undefined ? balanceTone : undefined
  const disabled = !summary.enabled
  const expiry = planExpiry(summary.planExpiresAt ?? account?.options.planExpiresAt)
  const hasRangeData = stats !== undefined && stats.rangeCalls > 0
  const hasHistory = stats !== undefined && (stats.allTokens > 0 || stats.rangeCalls > 0 || credits > 0)
  const cachedInput = (stats?.rangeCacheRead ?? 0) + (stats?.rangeCacheWrite ?? 0)
  const totalInput = (stats?.rangeInput ?? 0) + cachedInput
  const codexSource = bootstrap.logSources?.find((source) => source.id === 'codex')
  const oldCodexBackend = summary.providerId === 'codex-plan' && codexSource?.enabled === true && (codexSource.parserVersion ?? 1) < 2
  const timingRestart = bootstrap.mode === 'utools' ? '完全退出并重启 uTools，然后刷新面板；仅重新打开插件不能更新后台解析器' : '重启本地 TokenPanel 服务，然后刷新页面'
  const speedTitle = oldCodexBackend && stats?.speedP50 === undefined
    ? `后台仍使用旧版 Codex 日志解析器，无法补齐计时。请${timingRestart}`
    : stats?.speedEstimated
    ? `所选区间 ${stats.speedSamples ?? 0} 条记录的回合/消息间隔估速中位数；包含思考和工具等待，不是纯解码速度`
    : stats?.speedP50 !== undefined ? '所选区间输出速度中位数（tok/s）' : '所选区间没有可用的耗时；Codex 在回合完成后读取计时字段，扫描日志可补齐历史记录'
  const speedDetail = !hasRangeData ? undefined
    : stats.speedP50 !== undefined ? stats.speedEstimated ? '含思考/等待' : undefined
    : oldCodexBackend ? bootstrap.mode === 'utools' ? '需重启 uTools' : '需重启服务'
    : '缺少耗时'
  const hero = showQuotaHero
    ? { value: `${remaining?.toFixed(0)}%`, caption: `最紧窗口剩余${heroTone === 'warn' ? ' · 偏低' : heroTone === 'danger' ? ' · 将耗尽' : ''}` }
    : summary.balance !== undefined
      ? { value: formatMoney(summary.balance, summary.currency ?? 'USD'), caption: `${summary.currency ?? 'USD'} 可用余额` }
      : hasRangeData
        ? { value: formatTokens(stats.rangeTokens), caption: `${rangeLabel} token` }
        : { value: '—', caption: hasHistory ? '当前区间无调用' : '等待接入用量' }

  const subParts = [
    stats ? `今日 ${formatTokens(stats.todayTokens)}` : undefined,
    stats ? `本月 ${formatTokens(stats.monthTokens)}` : undefined,
    stats ? `累计 ${formatTokens(stats.allTokens)}` : undefined,
    credits > 0 ? `credits ${credits.toFixed(2)}` : undefined,
    summary.monthActualUsd > 0 ? `实际计费 ${money(summary.monthActualUsd)}` : undefined,
    summary.daysLeft !== undefined ? `约可用 ${Math.floor(summary.daysLeft)} 天` : undefined,
  ].filter((part): part is string => part !== undefined)

  return (
    <article
      className="card account-card flex flex-col"
      aria-label={`${summary.label}额度与用量`}
      aria-busy={refreshing}
      data-disabled={disabled || undefined}
      data-card-id={drag?.id}
      data-dragging={drag?.dragging || undefined}
      style={{ '--brand': color, '--brand-ink': inkColor } as CSSProperties}
      onPointerDown={drag?.onPointerDown}
    >
      <div className="card-heading flex items-center gap-2 px-3 pb-2 pt-2.5">
        {drag ? (
          <span className="card-drag-handle" aria-hidden="true" title="拖动卡片调整顺序">
            <GripVertical size={12} />
          </span>
        ) : null}
        <BrandIcon providerId={summary.providerId} label={summary.label} size={28} radius={8} />
        <div className="min-w-0 flex-1">
          <button type="button" className="account-name block max-w-full truncate text-left text-[13px] font-semibold" title={account ? `${summary.label} · 点击编辑账户` : summary.label} disabled={!account} onClick={() => account && onEdit(account)}>
            {summary.label}
          </button>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] muted">
            <span className="truncate" title={summary.providerName}>{summary.planLabel ?? (statsSource === 'plan' ? '订阅套餐' : '按量 API')}{summary.billingMode === 'mixed' ? ' · 混合账户' : ''}</span>
            {expiry ? (
              <span className="plan-expiry" data-tone={expiry.tone} title={`套餐到期：${formatDateTime(account?.options.planExpiresAt)}${expiry.tone === 'danger' ? '（已到期，请续费）' : ''}`}>
                <CalendarClock size={9} />{expiry.label}
              </span>
            ) : null}
          </div>
        </div>
        {disabled ? <Badge>停用</Badge> : null}
        <div className="card-actions flex shrink-0 gap-0.5">
          <button type="button" className="btn btn-ghost h-7 w-7 p-0" title={`刷新 ${summary.label}`} aria-label={`刷新 ${summary.label}`} disabled={refreshing || disabled} onClick={() => onRefresh(summary.accountId)}>
            {refreshing ? <Spinner size={13} /> : <RefreshCw size={13} />}
          </button>
          <button type="button" className="btn btn-ghost h-7 w-7 p-0" title={`编辑 ${summary.label}`} aria-label={`编辑 ${summary.label}`} disabled={!account} onClick={() => account && onEdit(account)}>
            <Pencil size={13} />
          </button>
        </div>
      </div>

      {summary.status === 'error' && summary.error ? (
        <button type="button" className="card-error mx-3 mt-2 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[10.5px]" title={`${summary.error}；点击检查账户配置`} disabled={!account} onClick={() => account && onEdit(account)}>
          <AlertCircle size={12} className="shrink-0" /><span className="truncate">{summary.error}</span><ArrowRight size={11} className="ml-auto shrink-0" />
        </button>
      ) : null}

      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
            <span className="truncate font-semibold leading-none num" style={{ fontSize: 'var(--fs-hero)', color: heroTone === 'ok' && showQuotaHero ? inkColor : heroTone && heroTone !== 'ok' ? `var(--${heroTone})` : undefined }}>{hero.value}</span>
            <span className="text-[10.5px] muted">{hero.caption}</span>
          </div>
        </div>
        <div className="shrink-0 text-right" title={hasTrend ? '近 7 天 token 用量走势' : '近 7 天暂无可展示的用量记录'}>
          {hasTrend ? (
            <Sparkline values={sparkline} color={inkColor} width={64} height={23} />
          ) : (
            <div className="flex h-[23px] w-16 items-center" aria-hidden="true">
              <span className="w-full border-t border-dashed" style={{ borderColor: 'var(--border-strong)' }} />
            </div>
          )}
          <div className="mt-1 text-[10px] faint">{hasTrend ? '近 7 天 token' : '暂无走势'}</div>
        </div>
      </div>

      <div className="mx-3 mb-2 flex min-h-5 min-w-0 items-center gap-1.5 text-[11px] muted">
        {summary.balance !== undefined && !showQuotaHero ? (
          <span className="balance-health inline-flex shrink-0 items-center gap-1 text-[10.5px]" data-tone={balanceTone} title={`${balanceThreshold !== undefined && balanceThreshold > 0 ? `预警线 ${formatMoney(balanceThreshold, summary.currency ?? 'USD')}` : '未设置余额预警线'}；可在编辑账户中修改`}>
            <span className="h-1 w-1 rounded-full bg-current" />{balanceTone === 'danger' ? '余额用尽' : balanceTone === 'warn' ? '余额偏低' : '余额可用'}
          </span>
        ) : null}
        {hasHistory && subParts.length > 0 ? <span className="min-w-0 truncate" title={subParts.join(' · ')}>{subParts.join(' · ')}</span> : <button type="button" className="inline-link min-w-0" onClick={() => navigate('settings')} title="前往设置，启用本机日志或导入账单"><span className="truncate">接入日志，补齐 token 明细</span><ArrowRight size={10} className="shrink-0" /></button>}
      </div>

      {windows.length > 0 ? (
        <div className="card-windows space-y-2.5 border-t px-3 py-2.5">
          {(expanded ? windows : windows.slice(0, WINDOW_ROW_LIMIT)).map((window) => <WindowMeter key={window.key} window={window} thresholds={thresholds} estimate={weeklyEstimates.get(window.key)} />)}
          {windows.length > WINDOW_ROW_LIMIT ? <button type="button" className="inline-link text-[10px]" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起额外窗口' : `展开另外 ${windows.length - WINDOW_ROW_LIMIT} 个窗口`}<ChevronDown size={11} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} /></button> : null}
        </div>
      ) : null}

      <div className="card-metrics mt-auto border-t px-3 py-2">
        <div className="mb-1.5 flex items-center justify-between text-[11px] faint">
          <span title="此处总量、总输入、输出和缓存按同一时间区间统计">{rangeLabel}{hasRangeData ? ` · 总量 ${formatTokens(stats.rangeTokens)}` : ''}</span>
          <button type="button" className="inline-link" onClick={() => navigate('records')} title="查看调用明细，可按账户筛选">{hasRangeData ? `${stats.rangeCalls} 次调用` : hasHistory ? '该区间无调用' : '暂无调用记录'}<ArrowRight size={10} /></button>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          <Metric
            label="总输入"
            value={hasRangeData ? formatTokens(totalInput) : '—'}
            detail={hasRangeData && cachedInput > 0 ? `缓存 ${formatTokens(cachedInput)}` : undefined}
            title={`总输入含缓存：普通输入 ${formatTokens(stats?.rangeInput ?? 0)} + 缓存读取 ${formatTokens(stats?.rangeCacheRead ?? 0)} + 缓存写入 ${formatTokens(stats?.rangeCacheWrite ?? 0)}；总输入 + 输出 = 此区间总 token`}
          />
          <Metric label="输出" value={hasRangeData ? formatTokens(stats.rangeOutput) : '—'} title="输出 token" />
          <Metric label="缓存命中" value={hasRangeData && stats.rangeCacheHitRate !== undefined ? `${stats.rangeCacheHitRate.toFixed(0)}%` : '—'} title="缓存命中率 = 缓存读取 ÷ (非缓存输入 + 缓存读取)，缓存写入不算命中" />
          <Metric
            label={stats?.speedEstimated ? '估速 tok/s' : '速度 tok/s'}
            value={hasRangeData ? formatSpeed(stats.speedP50) : '—'}
            detail={speedDetail}
            title={speedTitle}
          />
        </div>
      </div>

      <div className="card-footer flex items-center justify-between gap-2 border-t px-3 py-1.5 text-[10.5px] faint">
        <span className="flex min-w-0 items-center gap-1.5" title={summary.error ?? `${STATUS_LABELS[summary.status]}${stats?.lastModel ? ` · ${stats.lastModel} · ${formatDateTime(stats.lastAt)}${stats.lastDurationMs !== undefined ? ` · ${formatDuration(stats.lastDurationMs)}` : ''}` : ''}`}>
          <StatusDot status={summary.status} /><span className="truncate">{refreshing ? '正在同步…' : stats?.lastModel ? `上轮 ${stats.lastModel}` : STATUS_LABELS[summary.status]}</span>
        </span>
        <span className="shrink-0" title="最近一次刷新时间">{hasRangeData && stats.ttftP50 !== undefined ? `首字 ${formatDuration(stats.ttftP50)} · ` : ''}{summary.lastAt ? formatDateTime(summary.lastAt) : '点击刷新'}</span>
      </div>
    </article>
  )
}
