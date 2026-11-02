import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { ArrowDown, ArrowUpRight, BellPlus, Check, CheckCheck, CircleDot, ExternalLink, Newspaper, RefreshCw, Search, ShieldCheck, X } from 'lucide-react'
import type { NewsCategory, NewsItem, NewsOverview } from '../../core/news/types'
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
const LABELS: Record<NewsCategory, string> = { model: '新模型', pricing: '价格与额度', client: '客户端更新' }

function publicationDate(value: number): string {
  const date = new Date(value)
  return date.toLocaleDateString('zh-CN', { ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), month: 'numeric', day: 'numeric' })
}

export function NewsPage() {
  const { bootstrap } = useApp()
  const toast = useToast()
  const [data, setData] = useState<NewsOverview | null>(null)
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
      const next = await services.getNews(force)
      if (id === request.current) setData(next)
    } catch (caught) {
      if (id === request.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (id === request.current) setBusy(false)
    }
  }
  useEffect(() => { void load(); return () => { request.current++ } }, [])
  useEffect(() => { setLimit(12) }, [category, topicId, query, days, unreadOnly, includePreview])

  const read = useMemo(() => new Set(data?.readIds ?? []), [data?.readIds])
  const followed = data?.topics.filter(topic => data.followedTopicIds.includes(topic.id)) ?? []
  const now = Date.now()
  const eligible = (data?.items ?? []).filter(item => (includePreview || !item.prerelease) && (days === 0 || item.publishedAt >= now - days * 86_400_000))
  const scoped = eligible.filter(item => topicId === 'all' || item.topicId === topicId)
  const matchesView = (item: NewsItem) => (category === 'all' || item.categories.includes(category)) && (!unreadOnly || !read.has(item.id)) && `${item.title} ${item.summary} ${data?.topics.find(topic => topic.id === item.topicId)?.label}`.toLowerCase().includes(query.trim().toLowerCase())
  const filtered = scoped.filter(matchesView)
  const visible = filtered.slice(0, limit)
  const unread = eligible.filter(item => !read.has(item.id)).length
  const failed = data?.sources.filter(source => source.status === 'error') ?? []
  const checkedAt = Math.max(0, ...data?.sources.map(source => source.checkedAt ?? 0) ?? [])
  const previewCount = data?.items.filter(item => item.prerelease && (topicId === 'all' || item.topicId === topicId) && (days === 0 || item.publishedAt >= now - days * 86_400_000) && matchesView(item)).length ?? 0

  const mark = async (ids: string[], value: boolean) => {
    if (!ids.length || reading) return
    setReading(true)
    try {
      setData(await services.updateNewsPreferences(value ? { readIds: ids } : { unreadIds: ids }))
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
      const next = await services.updateNewsPreferences(suggested ? { useSuggested: true } : { followedTopicIds: draft })
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
          <div className="news-kicker"><span className="news-live-dot" /> 官方更新 · 按关注聚合</div>
          <h1>跟上你正在用的 AI</h1>
          <p>模型上新、价格额度、工具更新，一页看清。</p>
          <div className="news-hero-meta"><span>{followed.length} 个关注</span><span>{unread} 条未读</span>{data && data.followingMode !== 'custom' ? <span className="news-auto-label">{data.followingMode === 'accounts' ? '根据账户推荐' : '为你推荐'}</span> : null}</div>
        </div>
        <div className="news-hero-actions">
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" type="button" onClick={manage} disabled={!data}><BellPlus size={14} />管理关注</button>
            <button className="btn" type="button" onClick={() => void load(true)} disabled={busy}>{busy ? <Spinner size={13} /> : <RefreshCw size={13} />}{busy ? '获取动态中' : '刷新动态'}</button>
          </div>
          <span className="text-[10.5px] faint">{checkedAt ? `上次检查 ${formatDateTime(checkedAt)}` : '从官方公告与发布记录获取'}</span>
        </div>
      </section>

      {error ? <div className="news-notice" role="alert"><span>{error}</span><button type="button" className="inline-link shrink-0" onClick={() => void load(true)}>重试</button></div> : null}
      {failed.length ? <div className="news-notice" role="status"><span>{failed.length} 个官方来源暂不可达{failed.some(source => source.itemCount > 0) ? '，正在显示上次获取的动态' : '，其他来源照常展示'}。</span><span className="truncate text-[10.5px]" title={failed.map(source => `${source.label}：${source.error}`).join('\n')}>{failed.map(source => source.label).join(' · ')}</span></div> : null}

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

          <section className="card news-feed" aria-label="AI 动态列表">
            <div className="news-feed-heading"><span className="flex min-w-0 items-center gap-2"><Newspaper size={14} /><strong className="truncate text-[12px]">{topicId === 'all' ? '最新动态' : data?.topics.find(topic => topic.id === topicId)?.label}</strong><span className="text-[10.5px] faint">{filtered.length} 条</span>{topicId !== 'all' ? <button className="inline-link" type="button" aria-label="取消厂商筛选" onClick={() => setTopicId('all')}><X size={12} /></button> : null}</span><button type="button" className="inline-link shrink-0 text-[10.5px]" disabled={reading || !filtered.some(item => !read.has(item.id))} onClick={() => void mark(filtered.filter(item => !read.has(item.id)).map(item => item.id), true)}><CheckCheck size={13} />全部已读</button></div>
            {busy && !data ? <div className="news-loading" role="status"><Spinner size={20} /><span>正在汇集你关注的官方动态…</span><span className="text-[10.5px] faint">首次获取可能需要几秒</span></div> : null}
            {data && visible.length === 0 ? <EmptyState icon={Newspaper} title={followed.length === 0 ? '先关注你在用的厂商和工具' : '没有符合筛选的动态'} description={followed.length === 0 ? '选择关注对象后，这里会自动汇集相关官方更新。' : unreadOnly ? '这个范围内的动态都已读，或暂时没有更新。' : '可以切换分类、扩大时间范围，或调整关注对象。'} action={<button type="button" className="btn btn-sm mt-1" onClick={followed.length === 0 ? manage : () => { setCategory('all'); setTopicId('all'); setDays(0); setQuery(''); setUnreadOnly(false) }}>{followed.length === 0 ? '选择关注对象' : '重置筛选'}</button>} /> : null}
            <div>{visible.map(item => {
              const topic = data!.topics.find(topic => topic.id === item.topicId)!
              const source = data!.sources.find(source => source.id === item.sourceId)
              const isRead = read.has(item.id)
              return <article key={item.id} className={`news-item ${isRead ? 'is-read' : ''}`}>
                <div className="news-item-icon"><BrandIcon providerId={topic.providerId} label={topic.label} size={32} radius={9} /></div>
                <div className="min-w-0 flex-1">
                  <div className="news-item-meta"><span className="news-topic-label">{!isRead ? <i title="未读" /> : null}{topic.label}</span>{item.categories.map(value => <span key={value} className={`news-tag news-tag-${value}`}>{LABELS[value]}</span>)}{item.prerelease ? <span className="news-tag">预览版</span> : null}<time dateTime={new Date(item.publishedAt).toISOString()} title={formatDateTime(item.publishedAt)}>{publicationDate(item.publishedAt)}</time></div>
                  <a className="news-item-title" href={item.url} target="_blank" rel="noopener noreferrer" onClick={event => openArticle(event, item)}>{item.title}<ArrowUpRight size={13} /></a>
                  {item.summary ? <p className="news-item-summary">{item.summary}</p> : null}
                  <div className="news-item-footer"><a className="inline-link" href={item.url} target="_blank" rel="noopener noreferrer" onClick={event => openArticle(event, item)}><ShieldCheck size={11} />{source?.label ?? '官方来源'}<ExternalLink size={10} /></a><button type="button" className="inline-link" disabled={reading} aria-label={`${item.title}：${isRead ? '标为未读' : '标为已读'}`} onClick={() => void mark([item.id], !isRead)}>{isRead ? <Check size={11} /> : null}{isRead ? '已读' : '标为已读'}</button></div>
                </div>
              </article>
            })}</div>
            {filtered.length > visible.length ? <button type="button" className="news-more" onClick={() => setLimit(limit + 12)}>再看 {Math.min(12, filtered.length - visible.length)} 条<ArrowDown size={12} /></button> : null}
            {previewCount > 0 ? <div className="news-preview-note">{includePreview ? '已包含' : '另有'} {previewCount} 条预览版客户端更新<button type="button" className="inline-link" onClick={() => setIncludePreview(!includePreview)}>{includePreview ? '隐藏预览版' : '一并显示'}</button></div> : null}
          </section>
          <p className="news-reading-guide"><ShieldCheck size={11} />直接摘录官方标题与摘要 · 点击标题查看原文</p>
        </div>

        <aside className="news-sidebar">
          <section className="card news-follow-panel"><div className="news-sidebar-heading"><span>我的关注</span><button className="inline-link" type="button" onClick={manage} disabled={!data}>管理<ArrowUpRight size={11} /></button></div><button type="button" className={`news-follow-row ${topicId === 'all' ? 'is-active' : ''}`} onClick={() => setTopicId('all')}><span className="news-all-icon"><Newspaper size={13} /></span><span>全部关注</span><small>{eligible.length}</small></button>{followed.map(topic => <button key={topic.id} type="button" className={`news-follow-row ${topicId === topic.id ? 'is-active' : ''}`} aria-pressed={topicId === topic.id} onClick={() => setTopicId(topic.id)}><BrandIcon providerId={topic.providerId} label={topic.label} size={25} radius={7} /><span>{topic.label}</span><small>{eligible.filter(item => item.topicId === topic.id && !read.has(item.id)).length || '—'}</small></button>)}{followed.length === 0 ? <p className="px-3 pb-3 text-[11px] faint">添加关注后，相关动态会出现在这里。</p> : null}<label className="news-preview-control"><input type="checkbox" checked={includePreview} onChange={event => setIncludePreview(event.target.checked)} />包含预览版更新</label></section>
          <section className="card news-source-panel">
            <div className="news-sidebar-heading"><span><ShieldCheck size={12} />官方来源</span><small>{data?.sources.filter(source => source.status === 'ok').length ?? 0}/{data?.sources.length ?? 0} 可用</small></div>
            {data?.sources.map(source => <div className="news-source-row" key={source.id}>
              <span className={`news-source-dot ${source.status}`} />
              <div className="min-w-0">
                <a href={source.url} className="inline-link" target="_blank" rel="noopener noreferrer" onClick={event => { if (isUtools) { event.preventDefault(); services.openExternal(source.url) } }}>{source.label}<ExternalLink size={10} /></a>
                <p title={source.error}>{source.status === 'error' ? source.updatedAt ? '暂不可达 · 已保留缓存' : '暂不可达 · 刷新可重试' : source.checkedAt ? `收录 ${source.itemCount} 条` : '等待获取'}</p>
              </div>
            </div>)}
          </section>
        </aside>
      </div>

      <Modal open={managing} onClose={() => { if (!saving) setManaging(false) }} title="管理关注" subtitle="选择你想持续了解的厂商和工具，关注偏好保存在本机。" wide footer={<><button className="inline-link mr-auto text-[11px]" type="button" disabled={saving} onClick={() => void saveFollows(true)}>按账户推荐</button><button className="btn" type="button" disabled={saving} onClick={() => setManaging(false)}>取消</button><button className="btn btn-primary" type="button" disabled={saving} onClick={() => void saveFollows()}>{saving ? <Spinner size={12} /> : null}保存关注</button></>}>
        {(['vendor', 'tool'] as const).map(kind => <div key={kind} className="news-topic-section"><h2>{kind === 'vendor' ? '厂商动态' : '工具与客户端'}</h2><div className="news-topic-grid">{data?.topics.filter(topic => topic.kind === kind).map(topic => <label key={topic.id} className={`news-topic-option ${draft.includes(topic.id) ? 'is-selected' : ''}`}><BrandIcon providerId={topic.providerId} label={topic.label} size={30} radius={8} /><span><strong>{topic.label}</strong><small>{topic.description}</small></span><input type="checkbox" checked={draft.includes(topic.id)} onChange={event => setDraft(event.target.checked ? [...draft, topic.id] : draft.filter(id => id !== topic.id))} aria-label={`关注 ${topic.label}`} /></label>)}</div></div>)}
        <p className="mt-4 text-[11px] faint">当前可关注 {data?.topics.length ?? 0} 个厂商与工具，全部使用厂商官网或官方 GitHub 发布记录。{bootstrap.accounts.length > 0 ? '“按账户推荐”会参考已启用的账户和日志工具。' : ''}</p>
      </Modal>
    </div>
  )
}
