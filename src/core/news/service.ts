import path from 'node:path'
import { ValidationError } from '../errors'
import { readJson, writeJsonAtomic } from '../storage/files'
import { redact } from '../util/redact'
import { NEWS_SOURCES, NEWS_TOPICS, type NewsSource } from './catalog'
import { officialNewsUrl, parseNews } from './parser'
import { fetchOfficialNews, type NewsFetch } from './transport'
import type { NewsItem, NewsOverview, NewsPreferencesInput, NewsSourceStatus } from './types'

interface Preferences { followedTopicIds?: string[]; readIds: string[] }
interface SourceCache { parserVersion: number; items: NewsItem[]; checkedAt: number; updatedAt?: number; error?: string }
interface Suggested { ids: string[]; mode: 'accounts' | 'recommended' }
const TOPIC_IDS = new Set(NEWS_TOPICS.map(topic => topic.id))
const ITEM_ID = /^[a-f0-9]{24}$/
const PARSER_VERSION = 2

export class NewsService {
  private preferences: Preferences = { readIds: [] }
  private cache: Record<string, SourceCache> = {}
  private initialized?: Promise<void>
  private mutation = Promise.resolve()
  private requests = new Map<string, Promise<void>>()

  constructor(private readonly dataDir: string, private readonly fetchSource: NewsFetch = fetchOfficialNews, private readonly clock = Date.now) {}

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
        if (!entry || entry.parserVersion !== PARSER_VERSION || !Array.isArray(entry.items) || !Number.isFinite(entry.checkedAt)) continue
        this.cache[source.id] = {
          parserVersion: PARSER_VERSION,
          checkedAt: entry.checkedAt,
          updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : undefined,
          error: typeof entry.error === 'string' ? redact(entry.error) : undefined,
          items: entry.items.filter(item => item && item.sourceId === source.id && item.topicId === source.topicId && ITEM_ID.test(item.id) && typeof item.title === 'string' && typeof item.summary === 'string' && Number.isFinite(item.publishedAt) && Array.isArray(item.categories) && item.categories.every(category => ['model', 'pricing', 'client'].includes(category)) && officialNewsUrl(item.url, source)).slice(0, 60),
        }
      }
    })().catch(error => { this.initialized = undefined; throw error })
    return this.initialized
  }

  async get(suggested: Suggested, force = false): Promise<NewsOverview> {
    await this.initialize()
    await this.mutation
    const followed = this.preferences.followedTopicIds ?? suggested.ids
    const sources = NEWS_SOURCES.filter(source => followed.includes(source.topicId))
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(3, sources.length) }, async () => {
      while (cursor < sources.length) await this.refreshSource(sources[cursor++], force)
    }))
    return this.overview(suggested)
  }

  async update(input: NewsPreferencesInput, suggested: Suggested): Promise<NewsOverview> {
    await this.initialize()
    const operation = this.mutation.then(async () => {
      if (!input || typeof input !== 'object') throw new ValidationError('动态偏好格式无效')
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
    return this.overview(suggested)
  }

  private async refreshSource(source: NewsSource, force: boolean): Promise<void> {
    const previous = this.cache[source.id]
    const age = this.clock() - (previous?.checkedAt ?? 0)
    const ttl = force ? 60_000 : previous?.error ? 5 * 60_000 : 60 * 60_000
    if (previous && age >= 0 && age < ttl) return
    const inFlight = this.requests.get(source.id)
    if (inFlight) return inFlight
    const request = (async () => {
      try {
        const body = await this.fetchSource(source)
        if (Buffer.byteLength(body, 'utf8') > 3 * 1024 * 1024) throw new Error('官方订阅内容超过大小限制')
        this.cache[source.id] = { parserVersion: PARSER_VERSION, items: parseNews(body, source, this.clock()), checkedAt: this.clock(), updatedAt: this.clock() }
      } catch (error) {
        this.cache[source.id] = { parserVersion: PARSER_VERSION, items: previous?.items ?? [], updatedAt: previous?.updatedAt, checkedAt: this.clock(), error: redact(error) }
      }
      await writeJsonAtomic(path.join(this.dataDir, 'news-cache.json'), this.cache)
    })().finally(() => this.requests.delete(source.id))
    this.requests.set(source.id, request)
    return request
  }

  private overview(suggested: Suggested): NewsOverview {
    const followedTopicIds = this.preferences.followedTopicIds ?? suggested.ids
    const sources: NewsSourceStatus[] = NEWS_SOURCES.filter(source => followedTopicIds.includes(source.topicId)).map(source => {
      const entry = this.cache[source.id]
      return { id: source.id, topicId: source.topicId, label: source.label, url: source.website, status: !entry ? 'idle' : entry.error ? 'error' : 'ok', checkedAt: entry?.checkedAt, updatedAt: entry?.updatedAt, itemCount: entry?.items.length ?? 0, error: entry?.error }
    })
    const items = new Map<string, NewsItem>()
    for (const source of sources) for (const item of this.cache[source.id]?.items ?? []) if (!items.has(item.id)) items.set(item.id, item)
    return {
      topics: NEWS_TOPICS,
      followedTopicIds,
      followingMode: this.preferences.followedTopicIds ? 'custom' : suggested.mode,
      readIds: this.preferences.readIds,
      items: [...items.values()].sort((a, b) => b.publishedAt - a.publishedAt || a.id.localeCompare(b.id)),
      sources,
    }
  }
}
