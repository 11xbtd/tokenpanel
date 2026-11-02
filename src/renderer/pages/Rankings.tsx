import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { ArrowDown, ArrowDownWideNarrow, ArrowUpRight, Check, ExternalLink, Gauge, Info, KeyRound, Link2, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Trophy, X } from 'lucide-react'
import type { RankedModel, RankingMetric, RankingsOverview } from '../../core/rankings/types'
import { rankedCreatorBrand, rankedCreatorFollowed, sortedRankedModels } from '../../core/rankings/models'
import { isUtools, services } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { BrandIcon } from '../components/BrandIcon'
import { EmptyState, Spinner } from '../components/Common'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'

const AA_HOME = 'https://artificialanalysis.ai'
const AA_KEYS = `${AA_HOME}/api-key-management-redirect`
const AA_DOCS = `${AA_HOME}/data-api/docs`
const AA_METHOD = `${AA_HOME}/methodology/intelligence-benchmarking`
const METRICS: Array<{ value: RankingMetric; label: string; direction: string }> = [
  { value: 'intelligence', label: '智能指数', direction: '越高越好' },
  { value: 'outputSpeed', label: '输出速度', direction: '越高越好' },
  { value: 'costPerTask', label: '每任务成本', direction: '越低越好' },
  { value: 'inputPrice', label: '输入价格', direction: '越低越好' },
  { value: 'outputPrice', label: '输出价格', direction: '越低越好' },
  { value: 'firstAnswerSeconds', label: '首答等待', direction: '越低越好' },
]
const SEARCH_ALIASES: Record<string, string> = { 'kimi-code-plan': '月之暗面 kimi', 'glm-plan': '智谱 glm', 'aliyun-bailian': '阿里 通义 千问 qwen', 'volcengine-ark': '字节 豆包 doubao', 'baidu-qianfan': '百度 文心 ernie', 'tencent-hunyuan': '腾讯 混元 hunyuan', gemini: '谷歌 google gemini', 'claude-plan': 'claude anthropic' }
const metricText = (value: number | null, money = false): string => value === null ? '—' : `${money ? '$' : ''}${new Intl.NumberFormat('zh-CN', money ? { maximumSignificantDigits: 5 } : { maximumFractionDigits: 1 }).format(value)}`
const versionText = (value?: number) => value === undefined ? '—' : `v${Number.isInteger(value) ? value.toFixed(1) : value}`

function SourceLink({ href, children, className = '' }: { href: string; children: React.ReactNode; className?: string }) {
  return <a className={`inline-link ${className}`} href={href} target="_blank" rel="noopener noreferrer" onClick={event => { if (isUtools) { event.preventDefault(); services.openExternal(href) } }}>{children}</a>
}

export function RankingsPage() {
  const toast = useToast()
  const [data, setData] = useState<RankingsOverview | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [metric, setMetric] = useState<RankingMetric>('intelligence')
  const [query, setQuery] = useState('')
  const [creator, setCreator] = useState('all')
  const [followOnly, setFollowOnly] = useState(false)
  const [followed, setFollowed] = useState<string[]>([])
  const [hideMissing, setHideMissing] = useState(true)
  const [limit, setLimit] = useState(30)
  const [connecting, setConnecting] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const request = useRef(0)

  const load = async (force = false) => {
    const id = ++request.current
    setBusy(true)
    setError(null)
    try {
      if (typeof services.getRankings !== 'function') throw new Error('当前后台尚未包含模型排行榜，请重新加载新版插件。')
      const cached = await services.getRankings(false, true)
      if (id === request.current) setData(cached)
      if (cached.configured) {
        const next = await services.getRankings(force)
        if (id === request.current) setData(next)
      }
    } catch (caught) { if (id === request.current) setError(caught instanceof Error ? caught.message : '排行榜读取失败') }
    finally { if (id === request.current) setBusy(false) }
  }
  useEffect(() => {
    let live = true
    void load()
    void services.getNews(false, 'official', true).then(news => { if (live) setFollowed(news.followedTopicIds) }).catch(() => undefined)
    return () => { live = false; request.current++ }
  }, [])
  useEffect(() => { setLimit(30) }, [metric, query, creator, followOnly, hideMissing])

  const models = data?.models ?? []
  const creators = useMemo(() => [...new Set(models.map(model => model.creator))].sort((a, b) => a.localeCompare(b)), [data?.models])
  const scoped = models.filter(model => {
    const brand = rankedCreatorBrand(model.creator)
    if (creator !== 'all' && model.creator !== creator) return false
    if (followOnly && !rankedCreatorFollowed(model.creator, followed)) return false
    return `${model.name} ${model.creator} ${SEARCH_ALIASES[brand.providerId] ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())
  })
  const filtered = sortedRankedModels(scoped.filter(model => !hideMissing || model[metric] !== null), metric)
  const visible = filtered.slice(0, limit)
  const measured = models.filter(model => model.intelligence !== null).length
  const currentMetric = METRICS.find(option => option.value === metric)!
  const retryBlocked = Boolean(data?.retryAt && data.retryAt > Date.now())
  const notice = error ?? data?.error
  const personalKey = data?.keySource === 'personal'
  const sharedKey = data?.keySource === 'shared'
  const needsKey = !data?.configured || data.errorCode === 'rate_limit' || data.errorCode === 'auth'

  useEffect(() => {
    if (!data?.retryAt || data.retryAt <= Date.now()) return
    const timer = setTimeout(() => setData(current => current ? { ...current } : current), data.retryAt - Date.now() + 50)
    return () => clearTimeout(timer)
  }, [data?.retryAt])

  const openConnection = () => { setApiKey(''); setConnectionError(null); setConnecting(true) }
  const closeConnection = () => { if (!saving) { setConnecting(false); setApiKey(''); setConnectionError(null) } }
  const saveConnection = async (removeKey = false) => {
    if (saving) return
    setSaving(true)
    setConnectionError(null)
    try {
      const next = await services.configureRankings(removeKey ? { removeKey: true } : { apiKey: apiKey.trim() })
      setData(next)
      setApiKey('')
      setConnecting(false)
      if (removeKey) toast.push(next.keySource === 'shared' ? '已恢复默认共享 Key' : '已移除本机 AA Key，历史榜单仍保留在本机', 'info')
      if (next.configured) await load(true)
    } catch (caught) { setConnectionError(caught instanceof Error ? caught.message : '连接设置保存失败') }
    finally { setSaving(false) }
  }
  const resetFilters = () => { setQuery(''); setCreator('all'); setFollowOnly(false); setHideMissing(true) }
  const openModel = (event: MouseEvent<HTMLAnchorElement>, model: RankedModel) => {
    if (isUtools) { event.preventDefault(); services.openExternal(`${AA_HOME}/models/${encodeURIComponent(model.slug)}`) }
  }
  const modelLink = (model: RankedModel) => <a className="ranking-model-title" href={`${AA_HOME}/models/${encodeURIComponent(model.slug)}`} target="_blank" rel="noopener noreferrer" onClick={event => openModel(event, model)}>{model.name}<ArrowUpRight size={12} /></a>
  const metricCell = (model: RankedModel, key: RankingMetric, money = false) => <span className={`ranking-value ${key === metric ? 'is-selected' : ''} ${model[key] === null ? 'is-missing' : ''}`}>{metricText(model[key], money)}</span>

  return <div className="rankings-page fade-in">
    <section className="ranking-hero card">
      <div><div className="ranking-kicker"><span className="ranking-aa-mark">AA</span> ARTIFICIAL ANALYSIS <span className="ranking-source-label">独立评测</span></div><h1>选模型，先看数据</h1><p>智能指数、输出速度与 API 价格，放在一起比较。</p><SourceLink href={AA_HOME} className="ranking-attribution">Source: Artificial Analysis<ExternalLink size={10} /></SourceLink></div>
      <div className="ranking-hero-actions">
        <div className="flex flex-wrap gap-2">
          <button className="btn" type="button" onClick={openConnection} disabled={!data}><KeyRound size={13} />{personalKey ? '个人 Key 设置' : '配置个人 Key'}</button>
          <button className="btn btn-primary" type="button" disabled={busy || saving || !data?.configured || retryBlocked} onClick={() => void load(true)}>{busy ? <Spinner size={13} /> : <RefreshCw size={13} />}{busy ? '同步中' : '同步榜单'}</button>
        </div>
        <span className="ranking-sync-state">{data?.configured ? <><i className={data.status === 'error' ? 'has-error' : ''} />{sharedKey ? '默认共享 Key · 免配置' : '个人 Key · 本机加密保存'}</> : '使用自己的 AA Key · 本机加密保存'}</span>
      </div>
    </section>

    {data && (data.configured || models.length > 0) ? <div className="ranking-overview card"><div><span>收录模型</span><strong>{models.length || '—'}</strong><small>{measured ? `${measured} 个已有当前版本评分` : '等待连接数据'}</small></div><div><span>智能指数版本</span><strong>{versionText(data.indexVersion)}</strong><small>同一版本下比较分数</small></div><div><span>上次成功同步</span><strong className="ranking-date">{data.fetchedAt ? formatDateTime(data.fetchedAt) : '尚未同步'}</strong><small>本机缓存 6 小时 · 手动同步可提前检查</small></div></div> : null}

    {notice ? <div className="ranking-notice" role="alert">
      <Info size={14} /><div><p>{notice}</p>{data?.models.length ? <small>正在展示 {formatDateTime(data.fetchedAt)} 成功获取的榜单。</small> : null}{retryBlocked ? <small>预计可重试时间：{formatDateTime(data!.retryAt!)}</small> : null}</div>
      <button className="inline-link" type="button" onClick={needsKey ? openConnection : () => void load(true)} disabled={needsKey ? saving : busy || retryBlocked}>{needsKey ? sharedKey ? '配置自己的 Key' : personalKey ? '更换 API Key' : '配置 API Key' : '重试同步'}</button>
    </div> : null}
    {data && !data.configured && models.length > 0 ? <div className="ranking-cache-note"><Info size={12} />当前显示本机历史榜单。重新连接 AA 后可同步新数据。</div> : null}

    {busy && !data ? <div className="card ranking-loading"><Spinner size={20} /><span>正在读取模型排行榜…</span></div> : null}
    {data && !data.configured && models.length === 0 ? <section className="card ranking-connect-panel"><div className="ranking-connect-copy"><div className="ranking-connect-icon"><Link2 size={22} /></div><h2>连接你的 AA，查看模型表现</h2><p>免费 API Key 即可获取智能指数、价格和实测速度。<br />数据直接从 Artificial Analysis 获取，保存在本机。</p><button className="btn btn-primary" type="button" onClick={openConnection}><KeyRound size={14} />配置 API Key</button></div><div className="ranking-steps"><div><span>01</span><div><strong>获取 AA Key</strong><p>登录 Artificial Analysis，创建自己的 API Key。</p><SourceLink href={AA_KEYS}>打开 Key 管理<ArrowUpRight size={11} /></SourceLink></div></div><div><span>02</span><div><strong>在本机连接</strong><p>粘贴 Key 后保存，同步完整模型列表。</p></div></div><div><span>03</span><div><strong>找到适合的模型</strong><p>切换指标，按厂商或已关注对象筛选。</p></div></div></div></section> : null}

    {data && (data.configured || models.length > 0) ? <>
      <section className="ranking-controls card"><div className="ranking-sort-bar"><div className="ranking-metric-tabs" role="group" aria-label="排行榜主要指标">{([{ value: 'intelligence', label: '能力', icon: Trophy }, { value: 'outputSpeed', label: '速度', icon: Gauge }, { value: 'costPerTask', label: '任务成本', icon: SlidersHorizontal }] as const).map(option => <button type="button" aria-pressed={metric === option.value} key={option.value} onClick={() => setMetric(option.value)}><option.icon size={13} />{option.label}</button>)}</div><label className="ranking-sort-label"><ArrowDownWideNarrow size={13} /><select aria-label="排行榜排序指标" value={metric} onChange={event => setMetric(event.target.value as RankingMetric)}>{METRICS.map(option => <option key={option.value} value={option.value}>{option.label} · {option.direction}</option>)}</select></label></div><div className="ranking-filter-bar"><label className="ranking-search"><Search size={13} /><input aria-label="搜索模型或厂商" placeholder="搜索模型或厂商，支持中文名称" value={query} onChange={event => setQuery(event.target.value)} />{query ? <button type="button" aria-label="清除排行榜搜索" onClick={() => setQuery('')}><X size={12} /></button> : null}</label><select className="input ranking-creator" aria-label="筛选模型厂商" value={creator} onChange={event => setCreator(event.target.value)}><option value="all">全部厂商</option>{creators.map(value => <option key={value} value={value}>{value}</option>)}</select><button type="button" className={`ranking-follow-filter ${followOnly ? 'is-active' : ''}`} aria-pressed={followOnly} onClick={() => setFollowOnly(!followOnly)}><Check size={12} />只看关注</button></div></section>

      <section className="card ranking-results" aria-label="模型排行榜"><div className="ranking-results-heading"><div><strong>{currentMetric.label}排行</strong><span>{currentMetric.direction} · {filtered.length} 个模型</span>{busy ? <Spinner size={12} /> : null}</div><label><input type="checkbox" checked={hideMissing} onChange={event => setHideMissing(event.target.checked)} />隐藏缺测</label></div>
        {busy && models.length === 0 ? <div className="ranking-loading"><Spinner size={20} /><span>正在从 AA 同步模型数据…</span><small>首次同步可能需要几秒</small></div> : null}
        {!busy && !visible.length ? <EmptyState icon={Search} title={models.length ? '没有符合筛选的模型' : '尚未获取到模型数据'} description={models.length ? hideMissing ? '可以调整搜索、厂商，或取消“隐藏缺测”查看尚无该指标的模型。' : '试试其他关键词或切换厂商。' : data.error ? '请检查连接设置，更新 Key 后重新同步。' : '点击同步榜单获取最新数据。'} action={<button className="btn btn-sm" type="button" onClick={models.length ? resetFilters : openConnection}>{models.length ? '重置筛选' : '检查连接设置'}</button>} /> : null}
        {visible.length ? <><div className="ranking-table-scroll"><table className="ranking-table"><thead><tr><th>序号</th><th>模型 / 厂商</th><th className={metric === 'intelligence' ? 'is-selected' : ''}>智能指数<small>{versionText(data.indexVersion)}</small></th><th className={metric === 'outputSpeed' ? 'is-selected' : ''} title="AA 对公开 API 的输出速度实测，取服务商中位数，不代表本机客户端速度">输出速度<small>token/s</small></th><th className={metric === 'firstAnswerSeconds' ? 'is-selected' : ''} title="AA 测量的首个答案 token 等待时间，可能包含思考阶段；未提供时显示缺测">首答等待<small>秒</small></th><th className={metric === 'inputPrice' ? 'is-selected' : ''}>输入价格<small>美元 / 百万 token</small></th><th className={metric === 'outputPrice' ? 'is-selected' : ''}>输出价格<small>美元 / 百万 token</small></th><th className={metric === 'costPerTask' ? 'is-selected' : ''} title="AA 官方计算的智能指数评测平均每任务成本；不是输入输出价格的简单加权">任务成本<small>美元 / 次</small></th></tr></thead><tbody>{visible.map((model, index) => <tr key={model.id}><td className="ranking-position">{model[metric] === null ? '—' : String(index + 1).padStart(2, '0')}</td><td><div className="ranking-model"><BrandIcon providerId={rankedCreatorBrand(model.creator).providerId} label={model.creator} size={30} radius={8} /><div>{modelLink(model)}<p>{model.creator}{model.releasedAt ? <span> · {model.releasedAt}</span> : null}</p></div></div></td><td>{metricCell(model, 'intelligence')}</td><td>{metricCell(model, 'outputSpeed')}</td><td>{metricCell(model, 'firstAnswerSeconds')}</td><td>{metricCell(model, 'inputPrice', true)}</td><td>{metricCell(model, 'outputPrice', true)}</td><td>{metricCell(model, 'costPerTask', true)}</td></tr>)}</tbody></table></div><div className="ranking-model-cards">{visible.map((model, index) => <article className="ranking-model-card" key={model.id}><div className="ranking-card-title"><span className="ranking-position">{model[metric] === null ? '—' : String(index + 1).padStart(2, '0')}</span><BrandIcon providerId={rankedCreatorBrand(model.creator).providerId} label={model.creator} size={30} radius={8} /><div>{modelLink(model)}<p>{model.creator}</p></div></div><div className="ranking-card-metrics"><div><small>智能指数</small>{metricCell(model, 'intelligence')}</div><div><small>输出速度 · token/s</small>{metricCell(model, 'outputSpeed')}</div><div><small>首答等待 · 秒</small>{metricCell(model, 'firstAnswerSeconds')}</div><div><small>任务成本 · 美元/次</small>{metricCell(model, 'costPerTask', true)}</div></div><div className="ranking-card-prices"><span>输入 {metricText(model.inputPrice, true)}</span><span>输出 {metricText(model.outputPrice, true)}</span><small>/ 百万 token</small></div></article>)}</div></> : null}
        {filtered.length > visible.length ? <button type="button" className="ranking-more" onClick={() => setLimit(limit + 30)}>再看 {Math.min(30, filtered.length - visible.length)} 个模型<ArrowDown size={12} /></button> : null}
        <div className="ranking-table-note"><Info size={12} /><span>按当前筛选结果排序；“—”表示未测或不适用。速度来自 AA 的 API 基准测试，与本机 Codex / Kimi Code 会话 TPS 分开统计。</span></div>
      </section>
    </> : null}

    <footer className="ranking-source-footer"><ShieldCheck size={13} /><p><SourceLink href={AA_HOME}>Source: Artificial Analysis<ExternalLink size={10} /></SourceLink><span>综合能力评测以英语任务为主；各模型的推理配置按 AA 原名保留。</span></p><SourceLink href={AA_METHOD}>评测方法<ArrowUpRight size={11} /></SourceLink><SourceLink href={AA_DOCS}>数据说明<ArrowUpRight size={11} /></SourceLink></footer>

    <Modal open={connecting} onClose={closeConnection} title="AA API Key 设置" subtitle={data?.sharedKeyAvailable ? '默认使用共享 Key。配置个人 Key 后，优先使用你自己的请求额度。' : '使用你自己的 AA API Key，免费 Key 即可获取本页核心指标。'} footer={<>
      {personalKey ? <button type="button" className="inline-link text-[11px] mr-auto" disabled={saving} onClick={() => void saveConnection(true)}>{data?.sharedKeyAvailable ? '恢复默认共享 Key' : '移除本机 Key'}</button> : null}
      <button type="button" className="btn" disabled={saving} onClick={closeConnection}>取消</button><button type="button" className="btn btn-primary" disabled={saving || !apiKey.trim()} onClick={() => void saveConnection()}>{saving ? <Spinner size={12} /> : <Link2 size={12} />}保存并同步</button>
    </>}>
      {sharedKey && data?.errorCode === 'rate_limit' ? <div className="ranking-notice"><Info size={14} /><div><p>共享额度已用尽，填入自己的免费 Key 后即可尝试继续同步。</p><small>无需等待共享额度恢复，已有榜单会继续保留。</small></div></div> : null}
      <div className="ranking-key-guide"><KeyRound size={18} /><div><strong>在 AA 获取 API Key</strong><p>登录后进入 Key 管理。免费 Key 即可查看基础能力、价格与速度，无需 Pro。</p><SourceLink href={AA_KEYS}>打开 AA Key 管理<ExternalLink size={11} /></SourceLink></div></div>
      <label className="ranking-key-label" htmlFor="aa-api-key">个人 AA API Key {personalKey ? <span>已配置，输入新 Key 可替换</span> : null}</label>
      <input id="aa-api-key" className="input w-full" type="password" autoComplete="off" spellCheck={false} placeholder="粘贴你的 Artificial Analysis API Key" value={apiKey} onChange={event => setApiKey(event.target.value)} disabled={saving} />
      {connectionError ? <p className="mt-2 text-[11px]" style={{ color: 'var(--danger)' }} role="alert">{connectionError}</p> : null}
      <p className="ranking-key-note"><ShieldCheck size={12} />个人 Key 加密保存在本机；关闭窗口会清空输入框。</p>
    </Modal>
  </div>
}
