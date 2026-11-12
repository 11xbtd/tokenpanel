import { useEffect, useState } from 'react'
import { Download, Search, Table2 } from 'lucide-react'
import type { BillingMode, RecordsPage } from '../../core/types'
import { services } from '../lib/api'
import { useApp } from '../lib/app-context'
import { Badge, EmptyState, Segmented, Spinner } from '../components/Common'
import { useToast } from '../components/Toast'
import { formatDateTime, formatDuration, formatMoney, formatSpeed, formatTokens, ATTRIBUTION_LABELS, SOURCE_LABELS } from '../lib/format'

const PAGE_SIZE = 50

export function RecordsPage() {
  const { bootstrap, overview } = useApp()
  const toast = useToast()
  const [accountId, setAccountId] = useState('')
  const [source, setSource] = useState('')
  const [billingMode, setBillingMode] = useState<BillingMode | 'all'>('all')
  const [modelInput, setModelInput] = useState('')
  const [model, setModel] = useState('')
  const [days, setDays] = useState(30)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<RecordsPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    services
      .getRecords({
        from: days > 0 ? Date.now() - days * 86_400_000 : undefined,
        accountId: accountId || undefined,
        source: source || undefined,
        billingMode,
        model: model || undefined,
        page,
        pageSize: PAGE_SIZE,
      })
      .then((next) => {
        if (!alive) return
        setData(next)
        setError(null)
      })
      .catch((caught) => {
        if (alive) setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [accountId, source, billingMode, model, days, page, overview.generatedAt])

  const exportCsv = async () => {
    try {
      const csv = await services.exportUsageCsv()
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const result = await services.saveFile(`tokenpanel-usage-${stamp}.csv`, csv)
      if (!result.saved && result.error) toast.push(result.error, 'error')
      else if (result.saved) toast.push('已导出 CSV', 'ok')
    } catch (caught) {
      toast.push(`导出失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    }
  }

  const accounts = new Map(bootstrap.accounts.map((account) => [account.id, account]))
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <div>
      <div className="sticky-bar -mb-1 px-3 py-2 md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={days}
            onChange={(value) => {
              setDays(value)
              setPage(1)
            }}
            options={[
              { value: 7, label: '近 7 天' },
              { value: 30, label: '近 30 天' },
              { value: 90, label: '近 90 天' },
              { value: 0, label: '全部' },
            ]}
          />
          <select
            className="input h-8 w-auto min-w-[130px] text-xs"
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value)
              setPage(1)
            }}
          >
            <option value="">全部账户</option>
            {bootstrap.accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.label}</option>
            ))}
          </select>
          <select
            className="input h-8 w-auto min-w-[110px] text-xs"
            value={source}
            onChange={(event) => {
              setSource(event.target.value)
              setPage(1)
            }}
          >
            <option value="">全部来源</option>
            {Object.entries(SOURCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <select
            className="input h-8 w-auto min-w-[100px] text-xs"
            value={billingMode}
            onChange={(event) => {
              setBillingMode(event.target.value as BillingMode | 'all')
              setPage(1)
            }}
          >
            <option value="all">全部计费</option>
            <option value="api">按量 API</option>
            <option value="plan">订阅套餐</option>
          </select>
          <div className="flex min-w-[180px] flex-1 items-center gap-1">
            <input
              className="input h-8 text-xs"
              placeholder="按模型名筛选，如 deepseek"
              value={modelInput}
              onChange={(event) => setModelInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setModel(modelInput.trim())
                  setPage(1)
                }
              }}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setModel(modelInput.trim())
                setPage(1)
              }}
            >
              <Search size={13} />
            </button>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => void exportCsv()}>
            <Download size={13} />
            导出 CSV
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] muted">
          <span>共 {data?.total ?? 0} 条</span>
          <span>Token {formatTokens(data?.sum.tokens ?? 0)}</span>
          <span title="只合计厂商实际账单金额，价目表估算的部分不计入">
            实际计费 {formatMoney(data?.sum.actualUsd ?? 0, 'USD', 4)}
          </span>
          {loading ? <span className="flex items-center gap-1"><Spinner size={11} /> 加载中</span> : null}
        </div>
      </div>
      <div className="space-y-4 p-3 md:p-6">

      {error ? (
        <div className="card p-6 text-center text-xs" style={{ color: 'var(--danger)' }}>{error}</div>
      ) : !data || data.total === 0 ? (
        <div className="card">
          <EmptyState
            icon={Table2}
            title="没有匹配的调用记录"
            description="可以放宽时间范围或清空筛选；消耗记录来自官方用量接口、中转站日志和 CSV 导入。"
          />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="table-wrap max-h-[max(260px,calc(100dvh-330px))] overflow-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>账户</th>
                  <th>模型</th>
                  <th className="text-right" title="普通输入，与缓存读取、缓存写入分列，不重复计数">非缓存输入</th>
                  <th className="text-right">输出</th>
                  <th className="text-right">缓存读</th>
                  <th className="text-right">缓存写</th>
                  <th className="text-right">实际计费</th>
                  <th>时延</th>
                  <th>计费</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((record) => {
                  const accountLabel =
                    accounts.get(record.accountId)?.label ?? (record.accountId ? '账户已删除' : '未归属')
                  return (
                    <tr key={record.id}>
                      <td className="whitespace-nowrap text-[11px] muted">{formatDateTime(record.ts)}</td>
                      <td className="max-w-[140px] truncate" title={accountLabel}>
                        {accountLabel}
                      </td>
                      <td className="max-w-[220px] truncate" title={record.model}>{record.model}</td>
                      <td className="text-right num">{formatTokens(record.inputTokens)}</td>
                      <td className="text-right num">{formatTokens(record.outputTokens)}</td>
                      <td className="text-right num">{formatTokens(record.cacheReadTokens)}</td>
                      <td className="text-right num">{formatTokens(record.cacheWriteTokens)}</td>
                      <td
                        className="whitespace-nowrap text-right num"
                        title={
                          record.billingMode === 'plan'
                            ? '套餐调用不计费'
                            : record.costEstimated
                              ? record.meta?.priceMissing
                                ? '未匹配到价目表，也没拿到厂商账单'
                                : '这条金额是按 LiteLLM 价目估的，厂商没出账就不展示'
                              : record.nativeCost !== undefined
                                ? `原始 ${record.nativeCost} ${record.nativeCurrency}`
                                : undefined
                        }
                      >
                        {record.billingMode === 'plan'
                          ? '订阅内'
                          : record.costEstimated
                            ? '—'
                            : formatMoney(record.costUsdMicros / 1_000_000, 'USD')}
                      </td>
                      <td
                        className="whitespace-nowrap text-[11px] muted"
                        title={
                          record.meta?.durationScope === 'turn'
                            ? '这轮里有多次模型调用，日志只给整轮耗时，拆不出单次速度'
                            : record.meta?.durationScope === 'turn-gap'
                              ? '两次模型调用之间的间隔（已扣掉工具执行），按输出 token 折算'
                              : record.meta?.durationScope === 'task' || record.meta?.durationSource === 'message-gap'
                                ? '速度按回合或消息间隔估算，包含思考与工具等待'
                                : undefined
                        }
                      >
                        {record.ttftMs !== undefined ||
                        record.tokensPerSecond !== undefined ||
                        (record.meta?.durationScope === 'turn' && record.durationMs !== undefined) ? (
                          <>
                            {record.ttftMs !== undefined ? `首字 ${formatDuration(record.ttftMs)}` : ''}
                            {record.ttftMs !== undefined && record.tokensPerSecond !== undefined ? ' · ' : ''}
                            {record.tokensPerSecond !== undefined
                              ? `${record.meta?.durationScope === 'task' || record.meta?.durationScope === 'turn' || record.meta?.durationScope === 'turn-gap' || record.meta?.durationSource === 'message-gap' ? '估速 ' : ''}${formatSpeed(record.tokensPerSecond)} tok/s`
                              : ''}
                            {typeof record.meta?.turnMs === 'number'
                              ? `${record.ttftMs !== undefined || record.tokensPerSecond !== undefined ? ' · ' : ''}轮 ${formatDuration(record.meta.turnMs)}`
                              : ''}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        {record.billingMode === 'plan' ? <Badge tone="warn">订阅</Badge> : <Badge>按量</Badge>}
                      </td>
                      <td className="whitespace-nowrap">
                        <Badge tone={record.source === 'relay-log' || record.source === 'admin-api' || record.source === 'local-log' ? 'accent' : 'default'}>
                          {SOURCE_LABELS[record.source] ?? record.source}
                        </Badge>
                        {record.source === 'local-log' && typeof record.meta?.source === 'string' ? (
                          <div className="mt-0.5 text-[10px] faint">
                            {ATTRIBUTION_LABELS[record.meta.source] ?? record.meta.source}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t px-3 py-2 text-[11px] muted" style={{ borderColor: 'var(--border)' }}>
            <span>第 {data.page} / {totalPages} 页</span>
            <div className="flex items-center gap-1">
              <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                上一页
              </button>
              <button type="button" className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>
                下一页
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
