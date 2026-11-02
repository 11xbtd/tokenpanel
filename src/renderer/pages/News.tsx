import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { ArrowDown, ArrowUpRight, BellPlus, Check, CheckCheck, CircleDot, ExternalLink, Newspaper, RefreshCw, Search, ShieldCheck, X } from 'lucide-react'
import type { NewsCategory, NewsItem, NewsOverview, NewsStream } from '../../core/news/types'
import { isUtools, services } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { useApp } from '../lib/app-context'
import { BrandIcon } from '../components/BrandIcon'
import { EmptyState, Spinner } from '../components/Common'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'

const CATEGORIES: Array<{ value: 'all' | NewsCategory; label: string }> = [
  { value: 'all', label: '全部动态' }, { value: 'model', label: '新模型' },
  { value: 'pricing', label: '价格与额度' }, { value: 'client', label: '客户端更新' },
]
const LABELS: Record<NewsCategory, string> = { model: '新模型', pricing: '价格与额度', client: '客户端更新', related: '周边动态' }
const STREAMS: Array<{ value: NewsStream; label: string; description: string; icon: typeof Newspaper }> = [
  { value: 'official', label: '官方动态', description: '厂商公告、官方发布记录与规则页变更，优先看一手消息。', icon: ShieldCheck },
  { value: 'media', label: '相关报道', description: '来自量子位的相关报道，补充行业观察与周边新闻。', icon: Newspaper },
]

function publicationDate(value: number): string {
  const date = new Date(value)
  return date.toLocaleDateString('zh-CN', { ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), month: 'numeric', day: 'numeric' })
}

export function NewsPage() {
  const { bootstrap } = useApp()
  const toast = useToast()
  const [stored, setData] = useState<NewsOverview | null>(null)
  const [stream, setStream] = useState<NewsStream>('official')
  const data = stored?.stream === stream ? stored : null
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<'all' | NewsCategory>('all')
  const [topicId, setTopicId] = useState('all')
  const [query, setQuery] = useState('')
  const [days, setDays] = useState(30)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [includePreview, setIncludePreview] = useState(false)
  const [limit, setLimit] = useState(12)
  const [managing, setManaging] = useState(false)
  const [draft, setDraft] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [reading, setReading] = useState(false)
  const request = useRef(0)

  const load = async (force = false) => {
    const id = ++request.current
    setBusy(true)
    setError(null)
    try {
      if (typeof services.getNews !== 'function') throw new Error('当前插件后台还没有 AI 动态功能，请重新加载插件后再打开。')
      const cached = await services.getNews(false, stream, true)
      if (id === request.current) setData(cached)
      const next = await services.getNews(force, stream)
      if (id === request.current) setData(next)
    } catch (caught) {
      if (id === request.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (id === request.current) setBusy(false)
    }
  }
  useEffect(() => { setData(current => current?.stream === stream ? current : null); void load(); return () => { request.current++ } }, [stream])
  useEffect(() => { setLimit(12) }, [category, topicId, query, days, unreadOnly, includePreview])

  const read = useMemo(() => new Set(data?.readIds ?? []), [data?.readIds])
  const followed = stored?.topics.filter(topic => stored.followedTopicIds.includes(topic.id)) ?? []
  const now = Date.now()
  const eligible = (data?.items ?? []).filter(item => (includePreview || !item.prerelease) && (days === 0 || item.publishedAt >= now - days * 86_400_000))
  const inTopic = (item: NewsItem) => topicId === 'all' || item.relatedTopicIds.includes(topicId)
  const scoped = eligible.filter(inTopic)
  const matchesView = (item: NewsItem) => (category === 'all' || item.categories.includes(category)) && (!unreadOnly || !read.has(item.id)) && `${item.title} ${item.summary} ${data?.topics.find(topic => topic.id === item.topicId)?.label}`.toLowerCase().includes(query.trim().toLowerCase())
  const filtered = scoped.filter(matchesView)
  const visible = filtered.slice(0, limit)
  const unread = eligible.filter(item => !read.has(item.id)).length
  const failed = data?.sources.filter(source => source.status === 'error') ?? []
  const checkedAt = Math.max(0, ...data?.sources.map(source => source.checkedAt ?? 0) ?? [])
  const previewCount = data?.items.filter(item => item.prerelease && inTopic(item) && (days === 0 || item.publishedAt >= now - days * 86_400_000) && matchesView(item)).length ?? 0
  const historyCount = data?.items.filter(item => !item.prerelease && inTopic(item) && matchesView(item)).length ?? 0
  const monitors = data?.sources.filter(source => source.isMonitor && (topicId === 'all' || source.topicId === topicId)) ?? []
  const currentStream = STREAMS.find(option => option.value === stream)!

  const mark = async (ids: string[], value: boolean) => {
    if (!ids.length || reading) return
    setReading(true)
    try {
      const next = await services.updateNewsPreferences({ stream, ...(value ? { readIds: ids } : { unreadIds: ids }) })
      setData(current => current?.stream === next.stream ? next : current)
    } catch (caught) { toast.push(`已读状态保存失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error') }
    finally { setReading(false) }
  }
  const openArticle = (event: MouseEvent<HTMLAnchorElement>, item: NewsItem) => {
    if (!read.has(item.id)) void mark([item.id], true)
    if (isUtools) { event.preventDefault(); services.openExternal(item.url) }
  }
  const manage = () => { setDraft([...(data?.followedTopicIds ?? [])]); setManaging(true) }
  const saveFollows = async (suggested = false) => {
    setSaving(true)
    try {
      const next = await services.updateNewsPreferences({ stream, ...(suggested ? { useSuggested: true } : { followedTopicIds: draft }) })
      setData(next)
      setManaging(false)
      setTopicId('all')
      await load()
    } catch (caught) { toast.push(`关注保存失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error') }
    finally { setSaving(false) }
  }

  return (
    <div className="news-page fade-in">
      <section className="news-hero card">
        <div className="news-hero-copy">
          <div className="news-kicker"><span className="news-live-dot" /> 按关注聚合 · 官方来源优先</div>
          <h1>跟上你正在用的 AI</h1>
          <p>模型上新、价格额度、工具更新，一页看清。</p>
          <div className="news-hero-meta"><span>{followed.length} 个关注</span><span>{unread} 条未读</span>{data && data.followingMode !== 'custom' ? <span className="news-auto-label">{data.followingMode === 'accounts' ? '根据账户推荐' : '为你推荐'}</span> : null}</div>
        </div>
        <div className="news-hero-actions">
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" type="button" onClick={manage} disabled={!data}><BellPlus size={14} />管理关注</button>
            <button className="btn" type="button" onClick={() => void load(true)} disabled={busy}>{busy ? <Spinner size={13} /> : <RefreshCw size={13} />}{busy ? '获取动态中' : '刷新动态'}</button>
          </div>
          <span className="text-[10.5px] faint">{checkedAt ? `上次检查 ${formatDateTime(checkedAt)}` : '打开对应入口时获取，保留本机缓存'}</span>
        </div>
      </section>

      <div className="news-stream-bar"><div className="news-stream-tabs" role="group" aria-label="动态来源">{STREAMS.map(option => <button type="button" key={option.value} aria-pressed={stream === option.value} onClick={() => { if (stream !== option.value) setBusy(true); setStream(option.value); setCategory('all'); setLimit(12) }}><option.icon size={14} />{option.label}</button>)}</div><p>{currentStream.description}</p></div>

      {error ? <div className="news-notice" role="alert"><span>{error}</span><button type="button" className="inline-link shrink-0" onClick={() => void load(true)}>重试</button></div> : null}
      {failed.length ? <div className="news-notice" role="status"><span>{failed.length} 个来源暂不可达{failed.some(source => source.itemCount > 0) ? '，正在显示上次获取的动态' : '，其他来源照常展示'}。</span><span className="truncate text-[10.5px]" title={failed.map(source => `${source.label}：${source.error}`).join('\n')}>{failed.map(source => source.label).join(' · ')}</span></div> : null}

      <div className="news-layout">
        <div className="min-w-0">
          <div className="news-filters card">
            <div className="news-category-tabs" role="group" aria-label="动态分类">{CATEGORIES.map(option => {
              const count = option.value === 'all' ? scoped.length : scoped.filter(item => item.categories.includes(option.value as NewsCategory)).length
              return <button key={option.value} type="button" aria-pressed={category === option.value} onClick={() => setCategory(option.value)}>{option.label}<span>{count}</span></button>
            })}</div>
            <div className="news-filter-controls">
              <label className="news-search"><Search size={13} /><input aria-label="搜索 AI 动态" placeholder="搜索模型、工具或关键词" value={query} onChange={event => setQuery(event.target.value)} />{query ? <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={12} /></button> : null}</label>
              <select className="input news-period" aria-label="动态时间范围" value={days} onChange={event => setDays(Number(event.target.value))}><option value={7}>近 7 天</option><option value={30}>近 30 天</option><option value={0}>全部时间</option></select>
              <button type="button" className={`news-unread-filter ${unreadOnly ? 'is-active' : ''}`} aria-pressed={unreadOnly} onClick={() => setUnreadOnly(!unreadOnly)}><CircleDot size={12} />只看未读</button>
            </div>
            <select className="input news-mobile-topics" aria-label="筛选关注对象" value={topicId} onChange={event => setTopicId(event.target.value)}><option value="all">全部关注</option>{followed.map(topic => <option key={topic.id} value={topic.id}>{topic.label}</option>)}</select>
          </div>

          {stream === 'official' && category === 'pricing' && monitors.length > 0 ? <section className="card news-monitors" aria-label="官方价格额度页检查"><div className="news-monitor-intro"><ShieldCheck size={17} /><div><strong>官方价格与额度页</strong><p>首次检查建立基线，后续变化会单独显示。这里只记录发现时间，不代表官方生效时间。</p></div><span>{monitors.filter(source => source.monitor).length}/{monitors.length} 已建立基线</span></div><div className="news-monitor-links">{monitors.map(source => <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer" onClick={event => { if (isUtools) { event.preventDefault(); services.openExternal(source.url) } }} title={source.error ?? source.note ?? (source.checkedAt ? `上次检查 ${formatDateTime(source.checkedAt)}` : '等待首次检查')}><span className={`news-source-dot ${source.status}`} />{source.label}<small>{source.status === 'error' ? '暂不可达' : source.monitor ? source.monitor.changedAt ? '发现过变更' : source.note ? '说明正文' : '基线已建立' : '待建立基线'}</small><ExternalLink size={10} /></a>)}</div><p className="news-monitor-footnote">打开本页或刷新时检查 · 自动缓存 6 小时 · API 定价与套餐额度分别记录{[...new Set(monitors.flatMap(source => source.note ? [source.note] : []))].map(note => <span className="block mt-1" key={note}>{note}</span>)}</p></section> : null}

          <section className="card news-feed" aria-label="AI 动态列表">
            <div className="news-feed-heading"><span className="flex min-w-0 items-center gap-2"><Newspaper size={14} /><strong className="truncate text-[12px]">{topicId === 'all' ? '最新动态' : data?.topics.find(topic => topic.id === topicId)?.label}</strong><span className="text-[10.5px] faint">{filtered.length} 条</span>{topicId !== 'all' ? <button className="inline-link" type="button" aria-label="取消厂商筛选" onClick={() => setTopicId('all')}><X size={12} /></button> : null}</span><button type="button" className="inline-link shrink-0 text-[10.5px]" disabled={reading || !filtered.some(item => !read.has(item.id))} onClick={() => void mark(filtered.filter(item => !read.has(item.id)).map(item => item.id), true)}><CheckCheck size={13} />全部已读</button></div>
            {busy && !visible.length ? <div className="news-loading" role="status"><Spinner size={20} /><span>正在汇集你关注的{currentStream.label}…</span><span className="text-[10.5px] faint">首次获取可能需要几秒</span></div> : null}
            {data && !busy && visible.length === 0 ? <EmptyState icon={Newspaper} title={followed.length === 0 ? '先关注你在用的厂商和工具' : category === 'pricing' ? '当前范围内暂无价格额度动态' : '没有符合筛选的动态'} description={followed.length === 0 ? '选择关注对象后，这里会自动汇集相关内容。' : historyCount > 0 && days !== 0 ? `更早还有 ${historyCount} 条相关内容，可以扩大时间范围查看。` : category === 'pricing' && stream === 'official' ? '当前来源尚无相关公告。后续检查发现规则页变化时，也会在这里显示。' : unreadOnly ? '这个范围内的动态都已读，或暂时没有更新。' : '当前来源没有匹配内容，可以扩大时间范围或切换资讯入口。'} action={<div className="flex flex-wrap justify-center gap-2"><button type="button" className="btn btn-sm mt-1" onClick={followed.length === 0 ? manage : historyCount > 0 && days !== 0 ? () => setDays(0) : () => { setCategory('all'); setTopicId('all'); setDays(0); setQuery(''); setUnreadOnly(false) }}>{followed.length === 0 ? '选择关注对象' : historyCount > 0 && days !== 0 ? '查看全部历史' : '重置筛选'}</button>{followed.length > 0 && stream === 'official' ? <button type="button" className="btn btn-sm mt-1" onClick={() => { setBusy(true); setStream('media'); setCategory('all') }}>看看相关报道<ArrowUpRight size={12} /></button> : null}</div>} /> : null}
            <div>{visible.map(item => {
              const topic = data!.topics.find(topic => topic.id === item.topicId)!
              const source = data!.sources.find(source => source.id === item.sourceId)
              const isRead = read.has(item.id)
              return <article key={item.id} className={`news-item ${isRead ? 'is-read' : ''}`}>
                <div className="news-item-icon"><BrandIcon providerId={topic.providerId} label={topic.label} size={32} radius={9} /></div>
                <div className="min-w-0 flex-1">
                  <div className="news-item-meta"><span className="news-topic-label">{!isRead ? <i title="未读" /> : null}{topic.label}</span><span className={`news-origin news-origin-${item.stream}`}>{item.stream === 'official' ? '官方' : '媒体报道'}</span>{item.categories.map(value => <span key={value} className={`news-tag news-tag-${value}`}>{LABELS[value]}</span>)}{item.prerelease ? <span className="news-tag">预览版</span> : null}<time dateTime={new Date(item.publishedAt).toISOString()} title={`${item.change ? '发现时间：' : '发布时间：'}${formatDateTime(item.publishedAt)}`}>{item.change ? '发现于 ' : ''}{publicationDate(item.publishedAt)}</time></div>
                  <a className="news-item-title" href={item.url} target="_blank" rel="noopener noreferrer" onClick={event => openArticle(event, item)}>{item.title}<ArrowUpRight size={13} /></a>
                  {item.summary ? <p className="news-item-summary">{item.summary}</p> : null}
                  {item.change ? <details className="news-change"><summary>查看前后变化</summary><div><span>上次</span><p>{item.change.before || '未包含对应内容'}</p></div><div><span>本次</span><p>{item.change.after || '对应内容已移除'}</p></div></details> : null}
                  <div className="news-item-footer"><a className="inline-link" href={item.url} target="_blank" rel="noopener noreferrer" onClick={event => openArticle(event, item)}>{item.stream === 'official' ? <ShieldCheck size={11} /> : <Newspaper size={11} />}{source?.label ?? currentStream.label}<ExternalLink size={10} /></a><button type="button" className="inline-link" disabled={reading} aria-label={`${item.title}：${isRead ? '标为未读' : '标为已读'}`} onClick={() => void mark([item.id], !isRead)}>{isRead ? <Check size={11} /> : null}{isRead ? '已读' : '标为已读'}</button></div>
                </div>
              </article>
            })}</div>
            {filtered.length > visible.length ? <button type="button" className="news-more" onClick={() => setLimit(limit + 12)}>再看 {Math.min(12, filtered.length - visible.length)} 条<ArrowDown size={12} /></button> : null}
            {previewCount > 0 ? <div className="news-preview-note">{includePreview ? '已包含' : '另有'} {previewCount} 条预览版客户端更新<button type="button" className="inline-link" onClick={() => setIncludePreview(!includePreview)}>{includePreview ? '隐藏预览版' : '一并显示'}</button></div> : null}
          </section>
          <p className="news-reading-guide"><currentStream.icon size={11} />{stream === 'official' ? '官方公告与页面变更 · 点击标题核对原文' : '摘录媒体标题与摘要 · 点击标题查看报道'}</p>
        </div>

        <aside className="news-sidebar">
          <section className="card news-follow-panel"><div className="news-sidebar-heading"><span>我的关注</span><button className="inline-link" type="button" onClick={manage} disabled={!data}>管理<ArrowUpRight size={11} /></button></div><button type="button" className={`news-follow-row ${topicId === 'all' ? 'is-active' : ''}`} onClick={() => setTopicId('all')}><span className="news-all-icon"><Newspaper size={13} /></span><span>全部关注</span><small>{eligible.length}</small></button>{followed.map(topic => <button key={topic.id} type="button" className={`news-follow-row ${topicId === topic.id ? 'is-active' : ''}`} aria-pressed={topicId === topic.id} onClick={() => setTopicId(topic.id)}><BrandIcon providerId={topic.providerId} label={topic.label} size={25} radius={7} /><span>{topic.label}</span><small>{eligible.filter(item => item.relatedTopicIds.includes(topic.id) && !read.has(item.id)).length || '—'}</small></button>)}{followed.length === 0 ? <p className="px-3 pb-3 text-[11px] faint">添加关注后，相关动态会出现在这里。</p> : null}<label className="news-preview-control"><input type="checkbox" checked={includePreview} onChange={event => setIncludePreview(event.target.checked)} />包含预览版更新</label></section>
          <section className="card news-source-panel">
            <div className="news-sidebar-heading"><span><currentStream.icon size={12} />{stream === 'official' ? '官方来源' : '资讯来源'}</span><small>{data?.sources.filter(source => source.status === 'ok').length ?? 0}/{data?.sources.length ?? 0} 可用</small></div>
            {data?.sources.map(source => <div className="news-source-row" key={source.id}>
              <span className={`news-source-dot ${source.status}`} />
              <div className="min-w-0">
                <a href={source.url} className="inline-link" target="_blank" rel="noopener noreferrer" onClick={event => { if (isUtools) { event.preventDefault(); services.openExternal(source.url) } }}>{source.label}<ExternalLink size={10} /></a>
                <p title={source.error}>{source.status === 'error' ? source.updatedAt ? '暂不可达 · 已保留缓存' : '暂不可达 · 刷新可重试' : source.isMonitor ? source.monitor ? `${source.itemCount} 次变更 · 基线已建立` : '等待建立基线' : source.checkedAt ? `收录 ${source.itemCount} 条` : '等待获取'}</p>
              </div>
            </div>)}
          </section>
        </aside>
      </div>

      <Modal open={managing} onClose={() => { if (!saving) setManaging(false) }} title="管理关注" subtitle="选择你想持续了解的厂商和工具，关注偏好保存在本机。" wide footer={<><button className="inline-link mr-auto text-[11px]" type="button" disabled={saving} onClick={() => void saveFollows(true)}>按账户推荐</button><button className="btn" type="button" disabled={saving} onClick={() => setManaging(false)}>取消</button><button className="btn btn-primary" type="button" disabled={saving} onClick={() => void saveFollows()}>{saving ? <Spinner size={12} /> : null}保存关注</button></>}>
        {(['vendor', 'tool'] as const).map(kind => <div key={kind} className="news-topic-section"><h2>{kind === 'vendor' ? '厂商动态' : '工具与客户端'}</h2><div className="news-topic-grid">{data?.topics.filter(topic => topic.kind === kind).map(topic => <label key={topic.id} className={`news-topic-option ${draft.includes(topic.id) ? 'is-selected' : ''}`}><BrandIcon providerId={topic.providerId} label={topic.label} size={30} radius={8} /><span><strong>{topic.label}</strong><small>{topic.description}</small></span><input type="checkbox" checked={draft.includes(topic.id)} onChange={event => setDraft(event.target.checked ? [...draft, topic.id] : draft.filter(id => id !== topic.id))} aria-label={`关注 ${topic.label}`} /></label>)}</div></div>)}
        <p className="mt-4 text-[11px] faint">两个入口共用关注列表：官方动态优先使用厂商官网与官方 GitHub，相关报道来自中文科技媒体量子位。{bootstrap.accounts.length > 0 ? '“按账户推荐”会参考已启用的账户和日志工具。' : ''}</p>
      </Modal>
    </div>
  )
}
