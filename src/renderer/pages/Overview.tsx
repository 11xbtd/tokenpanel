import { useMemo, useState } from 'react'
import { ArrowRight, BookOpen, Database, Plus, RotateCcw, Wallet } from 'lucide-react'
import { quotaColorThresholds, windowUsedPct } from '../../core/util/quota'
import { services } from '../lib/api'
import { useApp } from '../lib/app-context'
import { RANGE_OPTIONS, TokenBlocks, rangeLabelOf } from '../components/ConsumeBlocks'
import { AccountCards } from '../components/AccountCards'
import { QuotaTimeline } from '../components/QuotaTimeline'
import { SetupGuide } from '../components/SetupGuide'
import { EmptyState, Section, Segmented, Spinner, Stat, StatRow, StatusDot } from '../components/Common'
import { useToast } from '../components/Toast'
import { formatDateTime, formatDuration, formatMoney, formatPct, formatSpeed, formatTokens, remainingTone } from '../lib/format'

type Tab = 'api' | 'plan'

function QuotaLegend() {
  const { bootstrap, navigate } = useApp()
  const { warningPct, dangerPct } = quotaColorThresholds(bootstrap.settings.quotaColors)
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <span className="text-[10.5px] muted">进度条表示剩余额度</span>
      <div className="quota-legend" aria-label="额度状态颜色说明">
        <span title="余量充足时使用厂商品牌色"><i style={{ background: 'linear-gradient(90deg, #e2167e 0 33%, #707070 33% 66%, #10a37f 66%)' }} />厂商色</span>
        <span title={`窗口剩余不超过 ${warningPct}% 时提示偏低`}><i style={{ background: 'var(--meter-warn)' }} />偏低 ≤{warningPct}%</span>
        <span title={`窗口剩余不超过 ${dangerPct}% 时提示将耗尽；余额用尽也使用红色`}><i style={{ background: 'var(--meter-danger)' }} />将耗尽 ≤{dangerPct}%</span>
        <button type="button" className="inline-link" onClick={() => navigate('settings')}>调整阈值<ArrowRight size={10} /></button>
      </div>
    </div>
  )
}

export function OverviewPage() {
  const { bootstrap, overview, openAccountModal, reload, refreshing, navigate, days, setDays } = useApp()
  const toast = useToast()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [tab, setTab] = useState<Tab>(() =>
    overview.accounts.some((account) => account.billingMode !== 'plan') ? 'api' : 'plan',
  )

  const accounts = useMemo(() => new Map(bootstrap.accounts.map((account) => [account.id, account])), [bootstrap.accounts])
  const displayCurrency = overview.totals.displayCurrency
  const thresholds = quotaColorThresholds(bootstrap.settings.quotaColors)
  const shortDay = (ts?: number) =>
    ts ? new Date(ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : ''

  const apiAccounts = overview.accounts.filter((account) => account.billingMode !== 'plan')
  const planAccounts = overview.accounts.filter(
    (account) =>
      account.billingMode === 'plan' ||
      account.billingMode === 'mixed' ||
      (account.windows?.length ?? 0) > 0,
  )

  const tightest = useMemo(() => {
    let best: { label: string; window: string; pct: number } | null = null
    for (const account of planAccounts) {
      if (!account.enabled) continue
      for (const window of account.windows ?? []) {
        const used = windowUsedPct(window)
        if (used === undefined || !Number.isFinite(used)) continue
        const pct = Math.min(100, Math.max(0, 100 - used))
        if (!best || pct < best.pct) {
          best = {
            label: account.label,
            window: window.label,
            pct,
          }
        }
      }
    }
    return best
  }, [planAccounts])

  const guide = (
    <SetupGuide
      hasAccounts={bootstrap.accounts.length > 0}
      hasUsage={overview.totals.monthTokens > 0 || overview.planTotals.allTokens > 0}
      onAdd={() => openAccountModal()}
      onSources={() => navigate('settings')}
      onAnalysis={() => navigate('usage')}
      onClose={bootstrap.accounts.length > 0 ? () => setGuideOpen(false) : undefined}
    />
  )

  const logSources = bootstrap.logSources.filter((source) => source.supported)
  const detectedSources = logSources.filter((source) => source.available)
  const unadaptedSources = bootstrap.logSources.filter((source) => !source.supported)

  const refreshOne = async (id: string) => {
    setBusyId(id)
    try {
      const result = await services.refreshAccount(id)
      await reload()
      toast.push(
        result.status === 'ok' ? '账户已刷新' : `刷新失败：${result.message ?? '未知错误'}`,
        result.status === 'ok' ? 'ok' : 'error',
      )
    } catch (error) {
      toast.push(`刷新失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const scanLogs = async () => {
    setScanning(true)
    try {
      const result = await services.scanLogs()
      await reload()
      toast.push(
        `日志扫描：新增 ${result.imported} 条${result.updated ? `，补齐 ${result.updated} 条计时数据` : ''}${result.unattributed > 0 ? `，${result.unattributed} 条没匹配上归属（未入库）` : ''}`,
        result.imported > 0 || (result.updated ?? 0) > 0 ? 'ok' : 'info',
      )
    } catch (error) {
      toast.push(`日志扫描失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setScanning(false)
    }
  }

  const enableSource = async (id: string, fallbackAccountId?: string) => {
    try {
      const existing = bootstrap.settings.logSources.find((source) => source.id === id)
      const logSources = existing
        ? bootstrap.settings.logSources.map((source) =>
            source.id === id
              ? {
                  ...source,
                  enabled: true,
                  bindings: source.bindings.length > 0 || !fallbackAccountId ? source.bindings : [{ accountId: fallbackAccountId }],
                }
              : source,
          )
        : [...bootstrap.settings.logSources, { id, enabled: true, bindings: fallbackAccountId ? [{ accountId: fallbackAccountId }] : [] }]
      await services.updateSettings({ logSources })
      const result = await services.scanLogs()
      await reload()
      toast.push(`已启用并导入 ${result.imported} 条${result.unattributed > 0 ? `，${result.unattributed} 条没匹配上归属（未入库）` : ''}`, result.imported > 0 ? 'ok' : 'info')
    } catch (error) {
      toast.push(`启用失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  /** 重建本机日志统计：清掉旧记录后按当前归属规则重扫。 */
  const rebuildLogs = async () => {
    if (!window.confirm('重建会删除已导入的本机日志记录，然后按当前归属规则重新扫描。继续？')) return
    setScanning(true)
    try {
      const result = await services.rebuildLogStats()
      await reload()
      toast.push(
        `已重建：清理 ${result.rebuilt} 条旧记录，重新导入 ${result.imported} 条${result.unattributed > 0 ? `，${result.unattributed} 条没匹配上归属（未入库）` : ''}`,
        'ok',
      )
    } catch (error) {
      toast.push(`重建失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setScanning(false)
    }
  }

  if (bootstrap.accounts.length === 0) {
    return (
      <div className="mx-auto max-w-[900px] space-y-4 p-3 md:p-5">
        <div className="card">
          <EmptyState
            icon={Wallet}
            title="把 AI 余额与用量，放在一个看板里"
            description="连接你的厂商账户，集中查看可用余额、套餐额度和 token 消耗。先添加一个账户，后续随时补齐用量明细。"
            action={
              <button type="button" className="btn btn-primary" onClick={() => openAccountModal()}>
                <Plus size={14} />
                添加第一个账户
              </button>
            }
          />
        </div>
        {guide}
        <div className="card px-4 py-3 text-[11.5px] muted" style={{ background: 'var(--surface-2)' }}>
          已内置 DeepSeek、Kimi、MiniMax、智谱、OpenRouter、OpenAI、Anthropic、New API 等配置，以及 Claude Code、Codex、Kimi CLI、OpenCode、Qoder、ZCode、DeepSeek Harness 等 11 类本机日志源。
        </div>
      </div>
    )
  }

  const rangeLabel = rangeLabelOf(days)
  const apiDates = overview.trend.map((item) => item.date)
  const planDates = overview.planTrend.map((item) => item.date)
  const apiBalanceSub =
    Object.keys(overview.totals.balanceByCurrency).length > 0
      ? Object.entries(overview.totals.balanceByCurrency)
          .map(([currency, amount]) => formatMoney(amount, currency))
          .join(' · ')
      : '暂无余额数据'


  return (
    <div>
      <div className="sticky-bar flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2 md:gap-y-2 md:px-5 md:py-2.5">
        <Segmented
          className="overview-tabs"
          ariaLabel="账户计费类型"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'api', label: `按量 API ${apiAccounts.length}` },
            { value: 'plan', label: `订阅套餐 ${planAccounts.length}` },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2" title="切换后，本页的卡片和走势一起按这个范围统计">
            <span className="hidden text-[10.5px] muted sm:inline">统计范围</span>
            <Segmented value={days} onChange={setDays} options={RANGE_OPTIONS} />
          </div>
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={guideOpen} aria-controls="overview-guide" onClick={() => setGuideOpen(!guideOpen)}>
            <BookOpen size={13} />接入指引
          </button>
        </div>
      </div>
      <div key={`${tab}-${days}`} className="fade-in space-y-3.5 p-3 md:p-5">
      <div id="overview-guide" hidden={!guideOpen}>{guideOpen ? guide : null}</div>

      {tab === 'api' ? (
        <>
          <StatRow>
            <Stat
              primary
              label="总余额"
              value={formatMoney(overview.totals.balanceDisplay, displayCurrency)}
              sub={apiBalanceSub}
            />
            <Stat
              label="今日 token"
              value={formatTokens(overview.totals.todayTokens)}
              sub={`总输入 ${formatTokens(overview.totals.todayInput + overview.totals.todayCacheRead + overview.totals.todayCacheWrite)} · 输出 ${formatTokens(overview.totals.todayOutput)}`}
            />
            <Stat
              label="本月 token"
              value={formatTokens(overview.totals.monthTokens)}
              sub={
                overview.totals.monthActualUsd > 0
                  ? `其中实际计费 ${formatMoney(overview.totals.monthActualDisplay, displayCurrency)}`
                  : '厂商未出账，金额不展示'
              }
            />
            <Stat
              label="今日缓存命中"
              value={formatPct(overview.totals.cacheHitRate, 1)}
              sub={`缓存读 ${formatTokens(overview.totals.todayCacheRead)} · 写 ${formatTokens(overview.totals.todayCacheWrite)}`}
            />
          </StatRow>

          {planAccounts.length > 0 ? (
            <div className="flex items-center justify-between gap-3 px-1 text-[12px]">
              <span className="truncate muted">
                另有 {planAccounts.length} 个订阅套餐
                {tightest ? `，最紧 ${tightest.label} · ${tightest.window} 剩 ${tightest.pct.toFixed(0)}%` : ''}
              </span>
              <button
                type="button"
                className="flex shrink-0 items-center gap-1 font-medium"
                style={{ color: 'var(--accent)' }}
                onClick={() => setTab('plan')}
              >
                查看套餐 <ArrowRight size={12} />
              </button>
            </div>
          ) : null}

          <QuotaTimeline accounts={planAccounts} refreshingId={busyId} refreshing={refreshing} onRefresh={refreshOne} onEdit={id => { const account = accounts.get(id); if (account) openAccountModal(account) }} />

          <Section
            title="账户额度"
            bodyClassName="p-3"
            extra={
              <div className="flex items-center gap-2">
                <span className="hidden text-[11px] faint sm:inline">{apiAccounts.length} 个按量账户</span>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => openAccountModal()}>
                  <Plus size={13} />
                  添加账户
                </button>
              </div>
            }
          >
            {apiAccounts.length === 0 ? (
              <div className="py-10 text-center text-xs muted">没有按量 API 账户，去「订阅套餐」看套餐明细。</div>
            ) : (
              <>
              <QuotaLegend />
              <AccountCards
                accounts={apiAccounts}
                accountMap={accounts}
                statsSource="api"
                onRefresh={(id) => void refreshOne(id)}
                onEdit={(account) => openAccountModal(account)}
                refreshingId={busyId}
                refreshing={refreshing}
              />
              </>
            )}
          </Section>

          <TokenBlocks
            days={days}
            groups={overview.apiTrendByModel}
            dates={apiDates}
            hourly={overview.today.api}
            rows={overview.byModel}
            trendExtra="按量 API / 中转 / 导入"
            trendEmptyText="这段时间没有按量消耗记录"
            topEmptyText="暂时没有按量消耗记录"
          />
        </>
      ) : (
        <>
          <StatRow>
            <Stat
              primary
              tone={tightest ? remainingTone(tightest.pct, thresholds) : undefined}
              label="最紧窗口剩余"
              value={tightest ? formatPct(tightest.pct, 0) : '—'}
              sub={tightest ? `${tightest.label} · ${tightest.window}` : '没有可读的套餐窗口'}
            />
            <Stat
              label={`${rangeLabel} token`}
              value={formatTokens(overview.planTotals.rangeTokens)}
              sub={`${overview.planTotals.calls} 次调用${
                overview.planTotals.credits > 0 ? ` · credits ${overview.planTotals.credits.toFixed(2)}` : ''
              }`}
            />
            <Stat
              label="本机日志累计"
              value={formatTokens(overview.planTotals.allTokens)}
              sub={
                overview.planTotals.firstTs
                  ? `本月 ${formatTokens(overview.planTotals.monthTokens)} · ${shortDay(overview.planTotals.firstTs)}–${shortDay(overview.planTotals.lastTs)}`
                  : '还没导入本机日志'
              }
            />
            <Stat
              label={`${rangeLabel}缓存命中`}
              value={overview.planTotals.calls > 0 ? formatPct(overview.planTotals.cacheHitRate, 1) : '—'}
              sub={
                overview.planTotals.calls > 0
                  ? `首字 p50 ${formatDuration(overview.planTotals.ttftP50)} · ${overview.planTotals.speedEstimated ? '估速' : '输出'} ${overview.planTotals.speedP50 !== undefined ? `${formatSpeed(overview.planTotals.speedP50)} tok/s` : '—'}`
                  : '导入本机日志后显示'
              }
            />
          </StatRow>

          {apiAccounts.length > 0 || overview.totals.balanceDisplay > 0 || overview.totals.monthTokens > 0 ? (
            <div className="flex items-center justify-between gap-3 px-1 text-[12px]">
              <span className="truncate muted">
                按量 API 余额 {formatMoney(overview.totals.balanceDisplay, displayCurrency)}，本月{' '}
                {formatTokens(overview.totals.monthTokens)} tokens
              </span>
              <button
                type="button"
                className="flex shrink-0 items-center gap-1 font-medium"
                style={{ color: 'var(--accent)' }}
                onClick={() => setTab('api')}
              >
                返回按量 <ArrowRight size={12} />
              </button>
            </div>
          ) : null}

          <QuotaTimeline accounts={planAccounts} refreshingId={busyId} refreshing={refreshing} onRefresh={refreshOne} onEdit={id => { const account = accounts.get(id); if (account) openAccountModal(account) }} />

          <Section
            title="套餐额度"
            bodyClassName="p-3"
            extra={
              <div className="flex items-center gap-2">
                <span className="hidden text-[11px] faint sm:inline">{planAccounts.length} 个套餐账户</span>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => openAccountModal()}>
                  <Plus size={13} />
                  添加账户
                </button>
              </div>
            }
          >
            {planAccounts.length === 0 ? (
              <EmptyState
                icon={Wallet}
                title="还没有套餐账户"
                description="GLM Coding Plan、MiniMax Token / Coding Plan、Kimi Code、Claude、ChatGPT/Codex 等预设都在账户页；额度百分比来自厂商接口，token 明细来自本机日志。"
                action={
                  <button type="button" className="btn btn-primary" onClick={() => openAccountModal()}>
                    <Plus size={14} />
                    添加套餐账户
                  </button>
                }
              />
            ) : (
              <>
              <QuotaLegend />
              <AccountCards
                accounts={planAccounts}
                accountMap={accounts}
                statsSource="plan"
                onRefresh={(id) => void refreshOne(id)}
                onEdit={(account) => openAccountModal(account)}
                refreshingId={busyId}
                refreshing={refreshing}
              />
              </>
            )}
          </Section>

          <TokenBlocks
            days={days}
            groups={overview.planTrendByModel}
            dates={planDates}
            hourly={overview.today.plan}
            rows={overview.planByModel}
            trendExtra="来自本机客户端日志"
            trendEmptyText={`这段时间没有套餐日志，可在下方「本机日志源」扫描（累计已导入 ${formatTokens(overview.planTotals.allTokens)}）`}
            topEmptyText="导入本机日志后出现"
          />

        </>
      )}

          <Section
            title="本机日志源"
            extra={
              <div className="flex items-center gap-2">
                <button type="button" className="btn btn-sm" disabled={scanning} onClick={() => void scanLogs()}>
                  {scanning ? <Spinner size={12} /> : <Database size={12} />}
                  扫描
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={scanning}
                  title="删除已导入的本机日志记录并按当前归属规则重扫"
                  onClick={() => void rebuildLogs()}
                >
                  {scanning ? <Spinner size={12} /> : <RotateCcw size={12} />}
                  重建
                </button>
                <button type="button" className="btn btn-sm" onClick={() => navigate('settings')}>管理</button>
              </div>
            }
          >
            {detectedSources.length === 0 ? (
              <div className="py-6 text-center text-xs muted">
                没检测到本机日志源。装好 Claude Code、Codex、Kimi CLI、OpenCode、Qoder、ZCode、DeepSeek Harness 等任一客户端并跑过一轮，这里会出现。
              </div>
            ) : (
              <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {detectedSources.map((source) => {
                  const boundLabels = source.bindings
                    .map((binding) => {
                      const label = accounts.get(binding.accountId ?? '')?.label
                      if (!label) return undefined
                      return binding.modelPattern ? `${label}←${binding.modelPattern}` : label
                    })
                    .filter((label): label is string => label !== undefined)
                  const firstAccountId = source.bindings.find((binding) => binding.accountId)?.accountId
                  return (
                    <div key={source.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <StatusDot status={source.enabled ? 'ok' : 'never'} title={source.enabled ? '已启用' : '未启用'} />
                        <span className="truncate text-[12.5px] font-medium">{source.name}</span>
                        {source.capabilities.ttft ? (
                          <span className="shrink-0 text-[10.5px] faint" title="该日志能算出首字延迟">
                            首字
                          </span>
                        ) : null}
                      </div>
                      <span
                        className="hidden min-w-0 flex-1 truncate text-[11px] faint sm:block"
                        title={`${source.paths.join('\n')}\n${boundLabels.join('\n')}`}
                      >
                        {boundLabels.length > 0 ? `归到 ${boundLabels.join('、')}` : '未绑定，按模型名判归属'}
                        {source.unattributed > 0 ? ` · 上次 ${source.unattributed} 条未入库` : ''}
                      </span>
                      <span className="w-[112px] shrink-0 text-right text-[11.5px] num">
                        {source.imported} 条 · {formatTokens(source.importedTokens)}
                      </span>
                      <span className="hidden w-[92px] shrink-0 text-right text-[11px] faint lg:block">
                        {source.lastScanAt ? formatDateTime(source.lastScanAt) : '未扫描'}
                      </span>
                      {!source.enabled ? (
                        <button
                          type="button"
                          className="btn btn-sm shrink-0"
                          onClick={() => void enableSource(source.id, firstAccountId)}
                        >
                          启用
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
            {unadaptedSources.length > 0 ? (
              <div className="mt-3 text-[11.5px] faint">
                发现但未适配：{unadaptedSources.map((source) => source.name).join('、')}
              </div>
            ) : null}
            <div className="mt-2.5 text-[11px] faint">
              日志只读，只留模型、时间、token 和耗时，不保存对话内容；只覆盖经过本机客户端的调用。
            </div>
          </Section>
      </div>
    </div>
  )
}
