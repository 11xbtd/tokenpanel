import path from 'node:path'
import { ValidationError } from '../errors'
import { readJson, writeJsonAtomic } from '../storage/files'
import { redact } from '../util/redact'
import { NEWS_SOURCES, NEWS_TOPICS, type NewsSource } from './catalog'
import { officialNewsUrl, parseNews } from './parser'
import { extractArticle } from './article'
import { fetchNewsArticle, fetchOfficialNews, type NewsArticleFetch, type NewsFetch } from './transport'
import { checkPricePage, type PriceBaseline } from './monitor'
import type { NewsArticle, NewsItem, NewsOverview, NewsPreferencesInput, NewsSourceStatus, NewsStream } from './types'

interface Preferences { followedTopicIds?: string[]; readIds: string[] }
interface SourceCache { parserVersion: number; items: NewsItem[]; checkedAt: number; updatedAt?: number; error?: string; baseline?: PriceBaseline }
interface Suggested { ids: string[]; mode: 'accounts' | 'recommended' }
const TOPIC_IDS = new Set(NEWS_TOPICS.map(topic => topic.id))
const ITEM_ID = /^[a-f0-9]{24}$/
// 媒体报道开始按 AI 相关性取舍并带正文，旧缓存里的条目规则不同，直接作废重取。
const PARSER_VERSION = 4
const STREAMS = ['official', 'media']
const MAX_ITEMS = 100
/** 订阅内容超过这个长度才认为是正文，否则回源抓原文页面。 */
const FEED_BODY_MIN = 120

export class NewsService {
  private preferences: Preferences = { readIds: [] }
  private cache: Record<string, SourceCache> = {}
  private initialized?: Promise<void>
  private mutation = Promise.resolve()
  private persistence = Promise.resolve()
  private requests = new Map<string, Promise<void>>()

  constructor(private readonly dataDir: string, private readonly fetchSource: NewsFetch = fetchOfficialNews, private readonly clock = Date.now, private readonly fetchArticle: NewsArticleFetch = fetchNewsArticle) {}

  private initialize(): Promise<void> {
    if (!this.initialized) this.initialized = (async () => {
      const preferences = await readJson<Preferences>(path.join(this.dataDir, 'news-preferences.json'), { readIds: [] })
      this.preferences = {
        ...(Array.isArray(preferences.followedTopicIds) ? { followedTopicIds: [...new Set(preferences.followedTopicIds.filter(id => TOPIC_IDS.has(id)))] } : {}),
        readIds: Array.isArray(preferences.readIds) ? preferences.readIds.filter(id => ITEM_ID.test(id)).slice(-2000) : [],
      }
      const cache: Record<string, SourceCache> = await readJson<Record<string, SourceCache>>(path.join(this.dataDir, 'news-cache.json'), {}).catch(() => ({}))
      for (const source of NEWS_SOURCES) {
        const entry = cache?.[source.id]
        if (!entry || ![2, PARSER_VERSION].includes(entry.parserVersion) || !Array.isArray(entry.items) || !Number.isFinite(entry.checkedAt)) continue
        const stream = source.stream ?? 'official'
        const baseline = entry.baseline
        const validBaseline = baseline && /^[a-f0-9]{64}$/.test(baseline.hash) && Number.isFinite(baseline.initializedAt) && Array.isArray(baseline.lines) && baseline.lines.length < 4000 && baseline.lines.every(line => typeof line === 'string' && line.length <= 100_000)
        this.cache[source.id] = {
          parserVersion: PARSER_VERSION,
          checkedAt: entry.checkedAt,
          updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : undefined,
          error: typeof entry.error === 'string' ? redact(entry.error) : undefined,
          baseline: validBaseline ? baseline : undefined,
          items: entry.items.filter(item => item && item.sourceId === source.id && (source.topicId === 'all' ? item.topicId === undefined || TOPIC_IDS.has(item.topicId) : item.topicId === source.topicId) && ITEM_ID.test(item.id) && typeof item.title === 'string' && typeof item.summary === 'string' && Number.isFinite(item.publishedAt) && Array.isArray(item.categories) && item.categories.length > 0 && item.categories.every(category => ['model', 'pricing', 'client', 'related'].includes(category)) && officialNewsUrl(item.url, source))
            .map(item => ({ ...item, stream, content: typeof item.content === 'string' ? item.content.slice(0, 20_000) : undefined, relatedTopicIds: Array.isArray(item.relatedTopicIds) ? item.relatedTopicIds.filter(id => TOPIC_IDS.has(id)) : item.topicId ? [item.topicId] : [] }))
            .slice(0, MAX_ITEMS),
        }
      }
    })().catch(error => { this.initialized = undefined; throw error })
    return this.initialized
  }

  async get(suggested: Suggested, force = false, stream: NewsStream = 'official', cachedOnly = false): Promise<NewsOverview> {
    if (!STREAMS.includes(stream)) throw new ValidationError('不支持的动态来源类型')
    await this.initialize()
    await this.mutation
    const followed = this.preferences.followedTopicIds ?? suggested.ids
    if (cachedOnly) return this.overview(suggested, stream)
    const sources = this.sourcesFor(followed, stream)
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
      while (cursor < sources.length) await this.refreshSource(sources[cursor++], force)
    }))
    return this.overview(suggested, stream)
  }

  async update(input: NewsPreferencesInput, suggested: Suggested): Promise<NewsOverview> {
    await this.initialize()
    const operation = this.mutation.then(async () => {
      if (!input || typeof input !== 'object') throw new ValidationError('动态偏好格式无效')
      if (input.stream !== undefined && !STREAMS.includes(input.stream)) throw new ValidationError('不支持的动态来源类型')
      if (input.followedTopicIds !== undefined && (!Array.isArray(input.followedTopicIds) || input.followedTopicIds.some(id => !TOPIC_IDS.has(id)))) throw new ValidationError('包含未支持的关注对象')
      for (const values of [input.readIds, input.unreadIds]) if (values !== undefined && (!Array.isArray(values) || values.length > 2000 || values.some(id => typeof id !== 'string' || !ITEM_ID.test(id)))) throw new ValidationError('动态记录格式无效')
      const read = new Set(this.preferences.readIds)
      input.readIds?.forEach(id => read.add(id))
      input.unreadIds?.forEach(id => read.delete(id))
      const followedTopicIds = input.useSuggested ? undefined : input.followedTopicIds !== undefined ? [...new Set(input.followedTopicIds)] : this.preferences.followedTopicIds
      const next: Preferences = { ...(followedTopicIds ? { followedTopicIds } : {}), readIds: [...read].slice(-2000) }
      await writeJsonAtomic(path.join(this.dataDir, 'news-preferences.json'), next)
      this.preferences = next
    })
    this.mutation = operation.catch(() => undefined)
    await operation
    return this.overview(suggested, input.stream ?? 'official')
  }

  /** 读媒体报道全文：订阅内容自带正文时直接用，否则回源抓原文页面。 */
  async article(url: string): Promise<NewsArticle> {
    await this.initialize()
    if (!url || typeof url !== 'string') throw new ValidationError('原文地址无效')
    let host = ''
    try { host = new URL(url).hostname } catch { throw new ValidationError('原文地址无效') }
    const source = NEWS_SOURCES.find(entry => (entry.stream ?? 'official') === 'media' && entry.allowedHosts.includes(host))
    if (!source) throw new ValidationError('不支持的原文地址')
    const target = officialNewsUrl(url, source)
    if (!target) throw new ValidationError('不支持的原文地址')
    const cached = this.cache[source.id]?.items.find(item => item.url === target)
    if (cached?.content && cached.content.length >= FEED_BODY_MIN) return { title: cached.title, content: cached.content, url: target }
    const html = await this.fetchArticle(source, target)
    const article = extractArticle(html, source)
    if (!article.content) throw new Error('原文页面没有可读的正文，可能被站点临时拦截，稍后重试')
    return { title: article.title || cached?.title || '', content: article.content, url: target }
  }

  private async refreshSource(source: NewsSource, force: boolean): Promise<void> {
    const previous = this.cache[source.id]
    const age = this.clock() - (previous?.checkedAt ?? 0)
    const ttl = force ? 60_000 : previous?.error ? 5 * 60_000 : source.watch ? 6 * 60 * 60_000 : 60 * 60_000
    if (previous && age >= 0 && age < ttl) return
    const inFlight = this.requests.get(source.id)
    if (inFlight) return inFlight
    const request = (async () => {
      try {
        const body = await this.fetchSource(source)
        if (Buffer.byteLength(body, 'utf8') > 3 * 1024 * 1024) throw new Error('资讯内容超过大小限制')
        const checkedAt = this.clock()
        const result = source.watch ? checkPricePage(body, source, previous?.baseline, checkedAt) : undefined
        const incoming = source.watch ? result?.item ? [result.item] : [] : parseNews(body, source, checkedAt)
        const items = new Map((previous?.items ?? []).map(item => [item.id, item]))
        for (const item of incoming) items.set(item.id, item)
        this.cache[source.id] = { parserVersion: PARSER_VERSION, items: [...items.values()].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, MAX_ITEMS), baseline: result?.baseline, checkedAt, updatedAt: checkedAt }
      } catch (error) {
        this.cache[source.id] = { parserVersion: PARSER_VERSION, items: previous?.items ?? [], baseline: previous?.baseline, updatedAt: previous?.updatedAt, checkedAt: this.clock(), error: redact(error) }
      }
      const persist = this.persistence.then(() => writeJsonAtomic(path.join(this.dataDir, 'news-cache.json'), this.cache))
      this.persistence = persist.catch(() => undefined)
      await persist
    })().finally(() => this.requests.delete(source.id))
    this.requests.set(source.id, request)
    return request
  }

  private sourcesFor(followed: string[], stream: NewsStream): NewsSource[] {
    return NEWS_SOURCES.filter(source => (source.stream ?? 'official') === stream && (source.topicId === 'all' || followed.includes(source.topicId)))
  }

  private overview(suggested: Suggested, stream: NewsStream): NewsOverview {
    const followedTopicIds = this.preferences.followedTopicIds ?? suggested.ids
    const sources: NewsSourceStatus[] = this.sourcesFor(followedTopicIds, stream).map(source => {
      const entry = this.cache[source.id]
      return { id: source.id, topicId: source.topicId, stream, label: source.label, url: source.website, status: !entry ? 'idle' : entry.error ? 'error' : 'ok', checkedAt: entry?.checkedAt, updatedAt: entry?.updatedAt, itemCount: entry?.items.filter(item => stream === 'media' || item.relatedTopicIds.some(id => followedTopicIds.includes(id))).length ?? 0, error: entry?.error, isMonitor: Boolean(source.watch), note: source.watch?.note, monitor: entry?.baseline ? { initializedAt: entry.baseline.initializedAt, changedAt: entry.baseline.changedAt } : undefined }
    })
    const items = new Map<string, NewsItem>()
    for (const source of sources) for (const item of this.cache[source.id]?.items ?? []) {
      if (stream === 'official' && !item.relatedTopicIds.some(id => followedTopicIds.includes(id))) continue
      const existing = items.get(item.id)
      const relatedTopicIds = [...new Set([...(existing?.relatedTopicIds ?? []), ...item.relatedTopicIds])]
      const topicId = relatedTopicIds.find(id => followedTopicIds.includes(id) && NEWS_TOPICS.find(topic => topic.id === id)?.kind === 'tool')
        ?? relatedTopicIds.find(id => followedTopicIds.includes(id))
        ?? existing?.topicId
        ?? item.topicId
      // 正文全文只留在本机缓存，列表接口不返回，避免响应体膨胀。
      const { content: _content, ...rest } = existing ?? item
      items.set(item.id, { ...rest, relatedTopicIds, topicId })
    }
    return {
      stream,
      topics: NEWS_TOPICS,
      followedTopicIds,
      followingMode: this.preferences.followedTopicIds ? 'custom' : suggested.mode,
      readIds: this.preferences.readIds,
      items: [...items.values()].sort((a, b) => b.publishedAt - a.publishedAt || a.id.localeCompare(b.id)),
      sources,
    }
  }
}
