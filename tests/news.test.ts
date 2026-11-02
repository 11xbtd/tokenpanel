import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NEWS_SOURCES, suggestedNewsTopics } from '../src/core/news/catalog'
import { newsCategories, officialNewsUrl, parseNews } from '../src/core/news/parser'
import { NewsService } from '../src/core/news/service'
import { TokenPanelApp } from '../src/core/services/app'
import type { AccountPublic } from '../src/core/types'

const now = Date.parse('2026-10-30T12:00:00+08:00')
const source = (id: string) => NEWS_SOURCES.find(source => source.id === id)!
const rss = (suffix = 'release', title = 'Introducing GPT-5', description = 'New model with lower API pricing.') => `<?xml version="1.0"?><rss version="2.0"><channel><title>Official news</title><item><title><![CDATA[${title}]]></title><link>https://openai.com/index/${suffix}</link><pubDate>Thu, 29 Oct 2026 08:00:00 GMT</pubDate><description><![CDATA[${description}]]></description></item></channel></rss>`

describe('官方资讯解析', () => {
  it('读取 RSS 标题、原文日期和摘要，多分类并清理脚本', () => {
    const [item] = parseNews(rss('release', 'Introducing GPT-5', '<p>New model &amp; lower API pricing.</p><script>steal()</script>'), source('openai-news'), now)
    expect(item.title).toBe('Introducing GPT-5')
    expect(item.summary).toBe('New model & lower API pricing.')
    expect(item.categories).toEqual(['pricing', 'model'])
    expect(item.publishedAt).toBe(Date.parse('2026-10-29T08:00:00Z'))
    expect(item.url).toBe('https://openai.com/index/release')
  })

  it('拒绝非官方域名、脚本地址、凭据和无效日期，去掉追踪参数并去重', () => {
    const entry = '<item><title>Introducing GPT-5</title><pubDate>Thu, 29 Oct 2026 08:00:00 GMT</pubDate>'
    const xml = `<rss><channel>${entry}<link>https://evil.example/news</link></item>${entry}<link>javascript:alert(1)</link></item>${entry}<link>https://openai.com/index/new?utm_source=rss</link></item>${entry}<link>https://openai.com/index/new</link></item>${entry}<link>https://openai.com/index/bad</link><pubDate>invalid</pubDate></item></channel></rss>`
    const items = parseNews(xml, source('openai-news'), now)
    expect(items.filter(item => item.url.includes('/index/new'))).toHaveLength(1)
    expect(items.every(item => item.url.startsWith('https://openai.com/'))).toBe(true)
    expect(officialNewsUrl('https://user:secret@openai.com/a', source('openai-news'))).toBeUndefined()
    expect(officialNewsUrl('', source('openai-news'))).toBeUndefined()
    expect(parseNews(rss().replace('Thu, 29 Oct 2026 08:00:00 GMT', 'invalid'), source('openai-news'), now)).toEqual([])
    expect(parseNews(rss().replace('Thu, 29 Oct 2026 08:00:00 GMT', 'Thu, 29 Oct 2030 08:00:00 GMT'), source('openai-news'), now)).toEqual([])
  })

  it('解析 Atom 客户端发布，限制仓库路径并标记预览版本', () => {
    const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>0.166.0-alpha.1</title><updated>2026-10-29T08:00:00Z</updated><link rel="alternate" href="https://github.com/openai/codex/releases/tag/rust-v0.166.0-alpha.1"/><content type="html">&lt;ul&gt;&lt;li&gt;Added a feature&lt;/li&gt;&lt;/ul&gt;</content></entry></feed>'
    const [item] = parseNews(atom, source('codex'), now)
    expect(item.title).toBe('Codex 0.166.0-alpha.1')
    expect(item.categories).toEqual(['client'])
    expect(item.prerelease).toBe(true)
    expect(item.summary).toBe('Added a feature')
    expect(parseNews(atom.replace('Added a feature', '#4553 9140ea0 Thanks @RealKai42! - Added a feature'), source('codex'), now)[0].summary).toBe('Added a feature')
    expect(parseNews(atom.replace('/openai/codex/releases/tag/', '/someone/repo/releases/tag/'), source('codex'), now)).toEqual([])
  })

  it('读取 MiniMax、Kimi 和 Anthropic 的官方公告卡片，合并重复卡片', () => {
    const minimax = '<a href="/blog/model"><article><h2>MiniMax M3.1 Flash</h2><time datetime="2026-10-19T00:00:00Z">2026-10-19</time></article></a>'
    expect(parseNews(minimax, source('minimax-news'), now)[0].categories).toEqual(['model'])
    const kimi = '<div class="menu-card"><a href="/en/blog/kimi-k3-1"></a><h4 class="card-title">Kimi K3.1 Pro</h4><p class="card-date">2026-10-24</p></div>'
    expect(parseNews(kimi + kimi, source('kimi-news'), now)).toHaveLength(1)
    const anthropic = '<main><article><header><time>Oct 7, 2026</time></header><a href="/claude-haiku"><h3>Introducing Claude Haiku 5.5</h3><p>A new model.</p></a></article></main>'
    expect(parseNews(anthropic, source('anthropic-news'), now)[0].url).toBe('https://www.anthropic.com/claude-haiku')
  })

  it('DeepSeek 更新按日期和小节拆分，原文锚点不会互相覆盖', () => {
    const html = '<article><h2 id="date">Date: 2026-10-17</h2><h3 id="model">DeepSeek-V4.1 Update</h3><p>New model.</p><h3 id="pricing">API pricing update</h3><p>New pricing and quota.</p></article>'
    const items = parseNews(html, source('deepseek-news'), now)
    expect(items).toHaveLength(2)
    expect(new Set(items.map(item => item.id)).size).toBe(2)
    expect(items.some(item => item.categories.includes('pricing'))).toBe(true)
  })

  it('不把客户案例、安全报告和企业新闻误当作新模型发布', () => {
    expect(newsCategories('Retell uses OpenAI models to power calls', 'GPT-6 leads benchmarks.')).toEqual([])
    expect(newsCategories('GPT-6 helps a customer improve code review', '')).toEqual([])
    expect(newsCategories('An updated Model Spec', 'New models.')).toEqual([])
    expect(newsCategories('MiniMax Speech 2.8', '')).toEqual(['model'])
    expect(newsCategories('Introducing Codex desktop', '')).toEqual(['client'])
    expect(newsCategories('Introducing GPT‑5.6', '')).toEqual(['model'])
    expect(newsCategories('Benefit Street Partners answers questions faster with Codex', 'Compare loan valuations and credit agreements.')).toEqual([])
    expect(newsCategories('LegalOn halves Codex costs while maintaining speed', '')).toEqual([])
    expect(newsCategories('DeepSeek-V4.1 Update', 'The API calling method and pricing remain unchanged.')).toEqual(['model'])
  })
})

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenpanel-news-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('资讯关注、缓存和失败恢复', () => {
  const suggested = { ids: ['openai'], mode: 'accounts' as const }

  it('首次仅获取关注的官方源，缓存有效时不重复请求，已读状态和关注可持久化', async () => {
    const called: string[] = []
    const service = new NewsService(dir, async source => { called.push(source.id); return rss() }, () => now)
    const data = await service.get(suggested)
    expect(called).toEqual(['openai-news'])
    await service.get(suggested)
    expect(called).toHaveLength(1)
    await service.update({ followedTopicIds: ['openai'], readIds: [data.items[0].id] }, suggested)
    const reopened = new NewsService(dir, async () => { throw new Error('should use cache') }, () => now)
    const cached = await reopened.get({ ids: ['kimi'], mode: 'accounts' })
    expect(cached.followingMode).toBe('custom')
    expect(cached.followedTopicIds).toEqual(['openai'])
    expect(cached.readIds).toEqual([data.items[0].id])
    expect((await reopened.update({ unreadIds: cached.readIds }, suggested)).readIds).toEqual([])
  })

  it('网络失败保留上一批动态与原更新时间，不将抓取时间冒充发布时间', async () => {
    let clock = now
    let failing = false
    const service = new NewsService(dir, async () => { if (failing) throw new Error('network unavailable'); return rss() }, () => clock)
    const first = await service.get(suggested)
    clock += 3_600_001
    failing = true
    const stale = await service.get(suggested)
    expect(stale.items).toEqual(first.items)
    expect(stale.sources[0]).toMatchObject({ status: 'error', updatedAt: now, checkedAt: clock })
    expect(stale.items[0].publishedAt).toBeLessThan(now)
  })

  it('允许取消全部关注并恢复账户推荐，拒绝无效关注和任意已读内容', async () => {
    const service = new NewsService(dir, async () => rss(), () => now)
    await service.update({ followedTopicIds: [] }, suggested)
    expect((await service.get(suggested)).sources).toEqual([])
    expect((await service.update({ useSuggested: true }, suggested)).followedTopicIds).toEqual(['openai'])
    await expect(service.update({ followedTopicIds: ['evil.example'] }, suggested)).rejects.toThrow('未支持')
    await expect(service.update({ readIds: ['not-an-id'] }, suggested)).rejects.toThrow('格式无效')
  })

  it('并发首次读取会共用每个来源的网络请求', async () => {
    let calls = 0
    const service = new NewsService(dir, async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return rss() }, () => now)
    const [a, b] = await Promise.all([service.get(suggested), service.get(suggested)])
    expect(calls).toBe(1)
    expect(a.items).toEqual(b.items)
  })

  it('账户和已启用日志可推导关注，未打开动态页时不请求任何资讯来源', async () => {
    const accounts = ['minimax-plan', 'kimi-code-plan', 'codex-plan'].map(providerId => ({ providerId, enabled: true } as AccountPublic))
    expect(suggestedNewsTopics(accounts, [{ id: 'claude-code', enabled: true, bindings: [] }]).ids).toEqual(expect.arrayContaining(['minimax', 'kimi', 'kimi-code', 'openai', 'codex', 'claude-code']))
    let calls = 0
    const app = await TokenPanelApp.create({ dataDir: dir, mode: 'utools', version: 'test', enableLocalLogs: false, fetchImpl: async () => new Response('{}', { status: 503 }), newsFetchImpl: async () => { calls++; return rss() } })
    await app.getBootstrap()
    expect(calls).toBe(0)
    await app.updateNewsPreferences({ followedTopicIds: ['openai'] })
    expect((await app.getNews()).items).toHaveLength(1)
    expect(calls).toBe(1)
  })
})
