import { useEffect, useState, type CSSProperties } from 'react'
import { ChevronDown, Clock3, RefreshCw } from 'lucide-react'
import type { AccountSummary, QuotaDepletionForecast, QuotaWindow, WeeklyQuotaEstimate } from '../../core/types'
import { quotaColorThresholds, windowUsedPct } from '../../core/util/quota'
import { DAY_MS, dateKey } from '../../core/util/time'
import { useApp } from '../lib/app-context'
import { formatDateTime, formatTokens, remainingTone } from '../lib/format'
import { providerInkColor } from '../lib/provider-brand'
import { useDark } from '../lib/theme'
import { BrandIcon } from './BrandIcon'
import { Section, Segmented, Spinner } from './Common'

type Range = 'day' | 'week' | 'all'
interface Entry {
  id: string
  account: AccountSummary
  window: QuotaWindow
  reset?: number
  remaining?: number
  forecast?: QuotaDepletionForecast
  estimate?: WeeklyQuotaEstimate
  stale: boolean
}

/** 折叠时显示的行数：行高压缩后 6 行仍比原来的 4 行矮。 */
const VISIBLE_ROWS = 6
const TICKS = [0, 0.25, 0.5, 0.75, 1]
const RANGE_OPTIONS: Array<{ value: Range; label: string }> = [
  { value: 'day', label: '24 小时' },
  { value: 'week', label: '7 天' },
  { value: 'all', label: '全部' },
]

const pad = (value: number) => String(value).padStart(2, '0')

/** 行内只放时刻，年份和星期留给悬停提示。 */
function clockLabel(at: number, now: number): string {
  const date = new Date(at)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return dateKey(at) === dateKey(now) ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`
}

/** 倒计时只保留最有信息量的两个单位，避免把行撑开。 */
function shortCountdown(at: number, now: number): string {
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 0)} 分`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时${minutes % 60 > 0 ? ` ${minutes % 60} 分` : ''}`
  const days = Math.floor(hours / 24)
  return `${days} 天${hours % 24 > 0 ? ` ${hours % 24} 小时` : ''}`
}

function rulerLabels(range: Range, horizon: number, now: number): string[] {
  return TICKS.map((tick) => {
    if (tick === 0) return '现在'
    if (range === 'day') return `+${Math.round(tick * 24)}h`
    if (range === 'week') return `+${Math.round(tick * 7)}天`
    const date = new Date(now + tick * horizon)
    return `${date.getMonth() + 1}/${date.getDate()}`
  })
}

export function QuotaTimeline({ accounts, refreshingId, refreshing, onRefresh, onEdit }: {
  accounts: AccountSummary[]
  refreshingId: string | null
  refreshing: boolean
  onRefresh: (id: string) => Promise<void>
  onEdit: (id: string) => void
}) {
  const { bootstrap } = useApp()
  const dark = useDark()
  const thresholds = quotaColorThresholds(bootstrap.settings.quotaColors)
  const [range, setRange] = useState<Range>('day')
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const staleAfter = Math.max(30 * 60_000, bootstrap.settings.refreshTtlMin * 2 * 60_000)
  const entries: Entry[] = accounts.filter(account => account.enabled).flatMap(account =>
    (account.windows ?? []).map(window => {
      const used = windowUsedPct(window)
      const reset = window.resetsAt && Number.isFinite(new Date(window.resetsAt).getTime()) && window.resetsAt > 0 ? window.resetsAt : undefined
      const stale = account.status === 'error' || (account.quotaUpdatedAt !== undefined && now - account.quotaUpdatedAt > staleAfter)
      const forecast = account.quotaForecasts?.find(item => item.windowKey === window.key)
      return {
        id: `${account.accountId}:${window.key}`, account, window, reset, stale,
        remaining: used !== undefined && Number.isFinite(used) ? Math.min(100, Math.max(0, 100 - used)) : undefined,
        forecast: !stale && forecast && now - forecast.observedTo <= staleAfter && reset && reset > now ? forecast : undefined,
        estimate: account.weeklyQuotaEstimates?.find(item => item.windowKey === window.key),
      }
    }),
  )
  if (entries.length === 0) return null
  const known = entries.filter((entry): entry is Entry & { reset: number } => entry.reset !== undefined).sort((a, b) => a.reset - b.reset || a.id.localeCompare(b.id))
  const unknown = entries.filter(entry => entry.reset === undefined)
  const horizon = range === 'day' ? DAY_MS : range === 'week' ? 7 * DAY_MS : Math.max(DAY_MS, ...known.map(entry => entry.reset - now))
  const within = known.filter(entry => entry.reset <= now + horizon)
  const later = known.length - within.length
  const pending = within.filter(entry => entry.reset <= now)
  const upcoming = within.filter(entry => entry.reset > now)
  const visible = expanded ? within : within.slice(0, VISIBLE_ROWS)
  const next = known.find(entry => entry.reset > now)
  const risks = upcoming.filter(entry => entry.forecast && entry.forecast.depletesAt < entry.reset)
  const rangeLabel = range === 'day' ? '24 小时' : range === 'week' ? '7 天' : '全部'
  const labels = rulerLabels(range, horizon, now)
  const hasMore = within.length > VISIBLE_ROWS || later > 0 || unknown.length > 0

  return (
    <Section
      className="quota-timeline"
      title={<span className="flex items-center gap-1.5"><Clock3 size={13} />额度时间轴</span>}
      extra={<Segmented ariaLabel="额度时间轴范围" value={range} onChange={value => { setRange(value); setExpanded(false) }} options={RANGE_OPTIONS} />}
      bodyClassName="quota-timeline-body"
    >
      <div className="quota-timeline-meta">
        <span className="min-w-0 flex-1 truncate">
          {range === 'all' ? `全部 ${upcoming.length} 个窗口待重置` : `${rangeLabel}内 ${upcoming.length} 个窗口待重置`}
          {pending.length > 0 ? <span style={{ color: 'var(--warn)' }}> · {pending.length} 个待刷新</span> : null}
          {risks.length > 0 ? <span style={{ color: 'var(--warn)' }}> · {risks.length} 个可能提前用尽</span> : null}
          {next ? <span className="faint"> · 最近 {next.account.label} {next.window.label} {clockLabel(next.reset, now)}</span> : null}
        </span>
        <span className="quota-timeline-legend">
          <span><i className="quota-legend-reset" />重置时间</span>
          <span><i className="quota-legend-depletion" />预计提前耗尽</span>
        </span>
      </div>

      {within.length > 0 ? (
        <>
          <div className="quota-timeline-ruler" aria-hidden="true">
            <span />
            <span />
            <span className="quota-ruler-scale">
              {labels.map((label, index) => <span key={TICKS[index]} style={{ left: `${TICKS[index] * 100}%` }}>{label}</span>)}
            </span>
            <span />
            <span />
          </div>
          <ul className="quota-timeline-list">
            {visible.map(entry => {
              const { account, window, reset, remaining, forecast, estimate, stale } = entry
              const expired = reset <= now
              const tone = remainingTone(remaining, thresholds)
              const toneColor = remaining === undefined ? 'var(--text-faint)' : tone === 'ok' ? providerInkColor(account.providerId, dark) : `var(--${tone})`
              const open = selected === entry.id
              const resetPosition = Math.max(0, Math.min(100, (reset - now) / horizon * 100))
              const exhaustionPosition = forecast ? (forecast.depletesAt - now) / horizon * 100 : undefined
              const shortfall = forecast !== undefined && forecast.depletesAt < reset
              const busy = refreshing || refreshingId === account.accountId
              const forecastText = expired ? '重置时间已到，请刷新确认新额度。'
                : stale ? '当前为上次额度数据，刷新后再查看预估。'
                : remaining === 0 ? '当前窗口额度已用尽，等待重置。'
                : forecast ? shortfall
                  ? forecast.depletesAt <= now ? '按近期节奏，预估耗尽时间已到，请刷新确认。' : `按近期节奏，预估 ${clockLabel(forecast.depletesAt, now)} 用尽，早于本次重置。`
                  : '按近期节奏，预计余量可覆盖至本次重置。'
                : '近期有效快照不足或余量变化较小，暂不预估耗尽时间。'
              return (
                <li key={entry.id} style={{ '--quota-brand': providerInkColor(account.providerId, dark) } as CSSProperties}>
                  <div className="quota-timeline-row">
                    <button
                      type="button"
                      className="quota-timeline-main"
                      aria-expanded={open}
                      aria-controls={`quota-detail-${entry.id}`}
                      onClick={() => setSelected(open ? null : entry.id)}
                      title={`${account.label} · ${window.label}；${forecastText}${expired ? '' : `；${formatDateTime(reset)} 重置`}`}
                    >
                      <span className="quota-timeline-identity">
                        <BrandIcon providerId={account.providerId} label={account.label} size={18} radius={5} />
                        <span className="truncate text-[11.5px] font-medium">{account.label}</span>
                        <span className="truncate text-[10px] faint">{window.label}</span>
                        {stale ? <span className="quota-timeline-stale">上次数据</span> : null}
                      </span>
                      <span className="quota-timeline-left">
                        <span className="faint">剩 </span>
                        <span style={{ color: toneColor }}>{remaining !== undefined ? `${remaining.toFixed(0)}%` : '—'}</span>
                      </span>
                      <span className="quota-time-lane" aria-hidden="true">
                        {TICKS.map(tick => <i key={tick} className="quota-time-grid" style={{ left: `${tick * 100}%` }} />)}
                        <i className="quota-time-track" />
                        <i className="quota-time-line" style={{ width: `${resetPosition}%` }} />
                        <i className="quota-reset-marker" data-expired={expired || undefined} style={{ left: `${resetPosition}%` }} />
                        {shortfall && exhaustionPosition !== undefined && exhaustionPosition >= 0 && exhaustionPosition <= 100 ? <i className="quota-depletion-marker" style={{ left: `${exhaustionPosition}%` }} /> : null}
                      </span>
                      <span className="quota-timeline-when" style={expired ? { color: 'var(--warn)' } : undefined}>
                        <span className="num">{expired ? '已到期' : clockLabel(reset, now)}</span>
                        <span className="faint quota-when-count"> · {expired ? '待刷新' : shortCountdown(reset, now)}</span>
                      </span>
                      <ChevronDown size={12} className={`quota-row-chevron ${open ? 'rotate-180' : ''}`} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost quota-row-refresh"
                      disabled={busy}
                      aria-label={`刷新时间轴中的${account.label} ${window.label}`}
                      title={`刷新 ${account.label} 的全部窗口`}
                      onClick={() => void onRefresh(account.accountId)}
                    >
                      {busy ? <Spinner size={11} /> : <RefreshCw size={11} />}
                    </button>
                  </div>
                  {open ? (
                    <div id={`quota-detail-${entry.id}`} className="quota-window-detail">
                      <p style={{ color: shortfall || expired ? 'var(--warn)' : 'var(--text-muted)' }}>{forecastText}</p>
                      {forecast ? <p className="mt-0.5 faint">依据 {forecast.sampleCount} 次快照（{formatDateTime(forecast.observedFrom)}–{formatDateTime(forecast.observedTo)}），每小时约 {forecast.remainingPctPerHour.toFixed(1)} 个百分点。</p> : null}
                      {estimate ? <p className="mt-0.5 faint">当前额度已用 {estimate.usedPct.toFixed(1)}%，本机在周期内记录 {formatTokens(estimate.usedTokens)} token。按相邻快照增量估算，周额度 ≥ {formatTokens(estimate.estimatedTotalTokens)} token（{formatDateTime(estimate.observedFrom)}–{formatDateTime(estimate.observedTo)}：{formatTokens(estimate.observedTokens)} token / {estimate.observedPct.toFixed(1)} 个百分点）。{estimate.externalUsageDetected ? '有区间额度上涨但本机无记录，可能来自其他设备或未导入的日志，真实额度会更高。' : '其他设备或未接入日志的用量会让真实额度更高。'}</p> : null}
                      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 faint">
                        <span>
                          {expired ? `原定 ${formatDateTime(reset)}` : `${formatDateTime(reset)} 重置`}
                          {account.quotaUpdatedAt ? ` · 额度更新于 ${formatDateTime(account.quotaUpdatedAt)}` : ''}
                        </span>
                        <button type="button" className="inline-link" onClick={() => onEdit(account.accountId)}>账户设置</button>
                      </div>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </>
      ) : (
        <div className="quota-timeline-empty">{known.length > 0 ? `${rangeLabel}内没有待重置的窗口。` : '账户尚未提供可用的重置时间。'}</div>
      )}

      {hasMore ? (
        <div className="quota-timeline-more">
          {within.length > VISIBLE_ROWS ? <button type="button" className="inline-link" onClick={() => setExpanded(!expanded)}>{expanded ? '收起窗口' : `展开另外 ${within.length - VISIBLE_ROWS} 个窗口`}</button> : null}
          {later > 0 ? <button type="button" className="inline-link" onClick={() => { setRange(range === 'day' ? 'week' : 'all'); setExpanded(false) }}>另有 {later} 个更晚的窗口</button> : null}
          {unknown.length > 0 ? <span title={unknown.map(entry => `${entry.account.label} · ${entry.window.label}`).join('\n')}>{unknown.length} 个窗口未提供重置时间</span> : null}
        </div>
      ) : null}
    </Section>
  )
}
