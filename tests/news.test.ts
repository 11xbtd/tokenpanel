import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { matchingNewsTopics, NEWS_SOURCES, suggestedNewsTopics, isAiMediaArticle } from '../src/core/news/catalog'
import { newsCategories, officialNewsUrl, parseNews } from '../src/core/news/parser'
import { NewsService } from '../src/core/news/service'
import { checkPricePage, priceSnapshot } from '../src/core/news/monitor'
import { TokenPanelApp } from '../src/core/services/app'
import type { AccountPublic } from '../src/core/types'

const now = Date.parse('2026-10-30T12:00:00+08:00')
const source = (id: string) => NEWS_SOURCES.find(source => source.id === id)!
const rss = (suffix = 'release', title = 'Introducing GPT-5', description = 'New model with lower API pricing.') => `<?xml version="1.0"?><rss version="2.0"><channel><title>Official news</title><item><title><![CDATA[${title}]]></title><link>https://openai.com/index/${suffix}</link><pubDate>Thu, 29 Oct 2026 08:00:00 GMT</pubDate><description><![CDATA[${description}]]></description></item></channel></rss>`
const priceHtml = (price = '$2.00', extra = '') => `<nav>Navigation ${extra}</nav><article><h1>API Pricing</h1><table><tr><th>Model</th><th>Input price per million tokens</th></tr><tr><td>Example model</td><td>${price}</td></tr></table></article>`
const officialBody = (entry: { watch?: unknown }) => entry.watch ? priceHtml() : rss()

describe('官方资讯解析', () => {
  it('区分同名协议、算法和人名，保留真正的厂商与工具关联', () => {
    expect(matchingNewsTopics('Minimax algorithm for tic-tac-toe')).toEqual([])
    expect(matchingNewsTopics('New Gemini protocol capsule')).toEqual([])
    expect(matchingNewsTopics('Kimi Raikkonen wins a race')).toEqual([])
    expect(matchingNewsTopics('Codex Sinaiticus manuscripts')).toEqual([])
    expect(matchingNewsTopics('MiniMax M3 uses minimax search')).toContain('minimax')
    expect(matchingNewsTopics('Using Codex and Claude Code')).toEqual(expect.arrayContaining(['codex', 'openai', 'claude-code', 'anthropic']))
  })
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

  it('中文媒体源保留没有厂商匹配的报道，并按各自域名限定原文链接', () => {
    const unmatched = '<rss><channel><item><title>某国产 AI 芯片发布新处理器</title><link>https://www.ithome.com/1/025/616.htm</link><pubDate>Thu, 29 Oct 2026 08:00:00 GMT</pubDate><description>与关注厂商无关的报道</description></item><item><title>伪造链接</title><link>https://evil.example/news</link><pubDate>Thu, 29 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>'
    const items = parseNews(unmatched, source('ithome'), now)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ sourceId: 'ithome', stream: 'media', categories: ['related'], url: 'https://www.ithome.com/1/025/616.htm' })
    expect(items[0].topicId).toBeUndefined()
    expect(items[0].relatedTopicIds).toEqual([])
    expect(NEWS_SOURCES.filter(entry => entry.stream === 'media').map(entry => entry.label)).toEqual(['量子位', 'IT之家', '钛媒体', '智东西'])
  })

  it('媒体流只保留与 AI 相关的报道，汽车、耳机、促销等新闻被丢掉', () => {
    const noise = '<rss><channel><item><title>长城汽车法务部：批量账号恶意攻击，将追究法律责任</title><link>https://www.ithome.com/1/025/631.htm</link><pubDate>Thu, 29 Oct 2026 08:00:00 GMT</pubDate><description>车企与水军口水战</description></item></channel></rss>'
    const related = '<rss><channel><item><title>OpenAI 发布 GPT-6.2 模型</title><link>https://www.ithome.com/1/025/616.htm</link><pubDate>Thu, 29 Oct 2026 08:00:00 GMT</pubDate><description>新模型上线</description></item></channel></rss>'
    expect(parseNews(noise, source('ithome'), now)).toEqual([])
    expect(parseNews(related, source('ithome'), now)).toHaveLength(1)
    expect(isAiMediaArticle('苹果 AirPods 京东补贴')).toBe(false)
    expect(isAiMediaArticle('OpenAI 发布 GPT-6.2 模型')).toBe(true)
    expect(isAiMediaArticle('黄仁勋回应出口管制')).toBe(true)
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
    expect(newsCategories('Claude 宣布取消 5 小时限制', '')).toEqual(['pricing'])
    expect(newsCategories('Claude 禁止逆向游戏', '')).toEqual([])
  })
})

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenpanel-news-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('资讯关注、缓存和失败恢复', () => {
  const suggested = { ids: ['openai'], mode: 'accounts' as const }

  it('首次仅获取关注的官方源，缓存有效时不重复请求，已读状态和关注可持久化', async () => {
    const called: string[] = []
    const service = new NewsService(dir, async source => { called.push(source.id); return officialBody(source) }, () => now)
    const data = await service.get(suggested)
    expect(called).toEqual(['openai-news', 'openai-pricing'])
    await service.get(suggested)
    expect(called).toHaveLength(2)
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
    const service = new NewsService(dir, async source => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return officialBody(source) }, () => now)
    const [a, b] = await Promise.all([service.get(suggested), service.get(suggested)])
    expect(calls).toBe(2)
    expect(a.items).toEqual(b.items)
  })

  it('账户和已启用日志可推导关注，未打开动态页时不请求任何资讯来源', async () => {
    const accounts = ['minimax-plan', 'kimi-code-plan', 'codex-plan'].map(providerId => ({ providerId, enabled: true } as AccountPublic))
    expect(suggestedNewsTopics(accounts, [{ id: 'claude-code', enabled: true, bindings: [] }]).ids).toEqual(expect.arrayContaining(['minimax', 'kimi', 'kimi-code', 'openai', 'codex', 'claude-code']))
    let calls = 0
    const app = await TokenPanelApp.create({ dataDir: dir, mode: 'utools', version: 'test', enableLocalLogs: false, fetchImpl: async () => new Response('{}', { status: 503 }), newsFetchImpl: async source => { calls++; return officialBody(source) } })
    await app.getBootstrap()
    expect(calls).toBe(0)
    await app.updateNewsPreferences({ followedTopicIds: ['openai'] })
    expect((await app.getNews()).items).toHaveLength(1)
    expect(calls).toBe(2)
  })

  it('缓存预览无需联网，新增入口按需获取并共用关注与已读偏好', async () => {
    const called: string[] = []
    const media = (host: string) => '<rss><channel><item><title>Codex 使用体验</title><link>https://' + host + '/2026/10/123.html</link><pubDate>2026-10-29T08:00:00Z</pubDate><description>开发工具的周边观察</description></item><item><title>无关的机器人研究</title><link>https://' + host + '/2026/10/124.html</link><pubDate>2026-10-29T08:00:00Z</pubDate></item></channel></rss>'
    const service = new NewsService(dir, async entry => { called.push(entry.id); return entry.stream === 'media' ? media(entry.allowedHosts[0]) : officialBody(entry) }, () => now)
    expect((await service.get(suggested, false, 'official', true)).topics.length).toBeGreaterThan(0)
    expect(called).toEqual([])
    const related = await service.get(suggested, false, 'media')
    expect(called).toEqual(['qbitai', 'ithome', 'tmtpost', 'zhidx'])
    expect(related.items).toHaveLength(8)
    expect(related.items.find(item => item.sourceId === 'qbitai' && item.title === 'Codex 使用体验')).toMatchObject({ stream: 'media', topicId: 'openai', relatedTopicIds: expect.arrayContaining(['codex', 'openai']) })
    const unmatched = related.items.find(item => item.sourceId === 'qbitai' && item.title === '无关的机器人研究')!
    expect(unmatched.topicId).toBeUndefined()
    expect(unmatched.categories).toEqual(['related'])
    const marked = await service.update({ stream: 'media', readIds: [related.items[0].id] }, suggested)
    expect(marked.stream).toBe('media')
    expect(marked.readIds).toContain(related.items[0].id)
    expect((await service.get(suggested, false, 'official', true)).items).toEqual([])
    await service.update({ followedTopicIds: [] }, suggested)
    expect((await service.get(suggested, false, 'official')).sources).toEqual([])
    expect((await service.get(suggested, false, 'media')).sources).toHaveLength(4)
    expect(called).toEqual(['qbitai', 'ithome', 'tmtpost', 'zhidx'])
    await expect(service.get(suggested, false, 'bad' as any)).rejects.toThrow('来源类型')
  })

  it('相关报道不按关注对象过滤，关注为空时仍然返回全部媒体来源', async () => {
    const called: string[] = []
    const media = '<rss><channel><item><title>某国产 AI 芯片发布新处理器</title><link>https://www.ithome.com/1/025/616.htm</link><pubDate>2026-10-29T08:00:00Z</pubDate><description>与关注厂商无关的报道</description></item></channel></rss>'
    const service = new NewsService(dir, async entry => { called.push(entry.id); return entry.stream === 'media' ? media : officialBody(entry) }, () => now)
    const data = await service.get({ ids: ['kimi'], mode: 'accounts' }, false, 'media')
    expect(called).toEqual(['qbitai', 'ithome', 'tmtpost', 'zhidx'])
    expect(data.items).toHaveLength(1)
    expect(data.items[0]).toMatchObject({ sourceId: 'ithome', stream: 'media', categories: ['related'] })
    expect(data.items[0].topicId).toBeUndefined()
    expect(data.sources.find(source => source.id === 'ithome')?.itemCount).toBe(1)
  })

  it('媒体报道全文可以在工具内读取，列表接口不返回正文，外站地址被拒绝', async () => {
    const body = '正文内容'.repeat(40)
    const withBody = `<rss><channel><item><title>OpenAI 发布 GPT-6.2 模型</title><link>https://www.ithome.com/1/025/616.htm</link><pubDate>2026-10-29T08:00:00Z</pubDate><description><p>${body}</p></description></item></channel></rss>`
    const quoteOnly = '<rss><channel><item><title>OpenAI 发布 GPT-6.2 模型</title><link>https://www.tmtpost.com/8201187.html</link><pubDate>2026-10-29T08:00:00Z</pubDate><description>一句话摘要</description></item></channel></rss>'
    const fetched: string[] = []
    const service = new NewsService(
      dir,
      async entry => (entry.id === 'ithome' ? withBody : quoteOnly),
      () => now,
      async (entry, url) => { fetched.push(url); return `<html><body><article><p>原文第一段，钛媒体报道称这家公司刚刚发布了新的产品线，覆盖智能体相关的多个方向。</p><p>原文第二段，报道还提到算力成本与模型调用价格的变化。</p></article></body></html>` },
    )
    const data = await service.get(suggested, false, 'media')
    expect(data.items.find(item => item.sourceId === 'ithome')?.content).toBeUndefined()
    const cached = await service.article('https://www.ithome.com/1/025/616.htm')
    expect(cached.content).toContain('正文内容')
    expect(fetched).toEqual([])
    const remote = await service.article('https://www.tmtpost.com/8201187.html')
    expect(remote.content).toContain('原文第二段')
    expect(fetched).toEqual(['https://www.tmtpost.com/8201187.html'])
    await expect(service.article('https://evil.example/news')).rejects.toThrow('原文地址')
  })

  it('移除社区来源后拒绝旧入口，不加载或获取旧的社区缓存', async () => {
    const old = { ...parseNews(rss(), source('openai-news'), now)[0], sourceId: 'hn-openai', stream: 'community', url: 'https://news.ycombinator.com/item?id=123' }
    await fs.writeFile(path.join(dir, 'news-cache.json'), JSON.stringify({ 'hn-openai': { parserVersion: 3, items: [old], checkedAt: now, updatedAt: now } }))
    const called: string[] = []
    const service = new NewsService(dir, async entry => { called.push(entry.id); return officialBody(entry) }, () => now)
    expect((await service.get(suggested, false, 'official', true)).items).toEqual([])
    await expect(service.get(suggested, false, 'community' as any)).rejects.toThrow('来源类型')
    await expect(service.update({ stream: 'community' as any }, suggested)).rejects.toThrow('来源类型')
    expect(called).toEqual([])
    const data = await service.get(suggested)
    expect(data.items.every(item => item.stream === 'official')).toBe(true)
    expect(called.some(id => id.startsWith('hn-'))).toBe(false)
  })

  it('规则页首次仅建立基线，后续真实变化生成记录，故障保留基线且回改有独立记录', async () => {
    let clock = now
    let price = '$2.00'
    let failing = false
    const service = new NewsService(dir, async entry => { if (entry.watch && failing) throw new Error('network unavailable'); return entry.watch ? priceHtml(price) : rss() }, () => clock)
    const first = await service.get(suggested)
    expect(first.items.some(item => item.change)).toBe(false)
    expect(first.sources.find(entry => entry.id === 'openai-pricing')?.monitor).toEqual({ initializedAt: now, changedAt: undefined })
    price = '$1.00'
    clock += 60_001
    const updated = await service.get(suggested, true)
    const change = updated.items.find(item => item.change)!
    expect(change).toMatchObject({ publishedAt: clock, stream: 'official', categories: ['pricing'] })
    expect(change.change?.before).toContain('$2.00')
    expect(change.change?.after).toContain('$1.00')
    clock += 60_001
    failing = true
    const failed = await service.get(suggested, true)
    expect(failed.items).toEqual(updated.items)
    expect(failed.sources.find(entry => entry.id === 'openai-pricing')).toMatchObject({ status: 'error', monitor: { initializedAt: now, changedAt: change.publishedAt } })
    clock += 60_001
    failing = false
    price = '$2.00'
    const restored = await service.get(suggested, true)
    expect(restored.items.filter(item => item.change)).toHaveLength(2)
    expect(new Set(restored.items.map(item => item.id)).size).toBe(restored.items.length)
    const reopened = new NewsService(dir, async () => { throw new Error('use persisted cache') }, () => clock)
    expect((await reopened.get(suggested)).items).toEqual(restored.items)
  })

  it('升级保留旧官方缓存，滚动 RSS 不会抹掉上次收录的历史', async () => {
    const old = parseNews(rss('old'), source('openai-news'), now)[0]
    const legacy = { ...old } as any
    delete legacy.stream
    delete legacy.relatedTopicIds
    await fs.writeFile(path.join(dir, 'news-cache.json'), JSON.stringify({ 'openai-news': { parserVersion: 2, items: [legacy], checkedAt: now, updatedAt: now } }))
    const service = new NewsService(dir, async entry => entry.watch ? priceHtml() : rss('new'), () => now + 3_600_001)
    const data = await service.get(suggested)
    expect(data.items).toHaveLength(2)
    expect(data.items.find(item => item.id === old.id)).toMatchObject({ stream: 'official', relatedTopicIds: ['openai'] })
  })
})

describe('价格页内容比较', () => {
  it('忽略导航、脚本和排版变化，按价格表行提供可读差异', () => {
    const entry = source('openai-pricing')
    const first = checkPricePage(priceHtml(), entry, undefined, now)
    const cosmetic = priceHtml('$2.00', 'New menu').replace('<td>Example model</td>', '<td> Example   model </td>') + '<script>random()</script>'
    expect(checkPricePage(cosmetic, entry, first.baseline, now + 1).item).toBeUndefined()
    expect(priceSnapshot(priceHtml(), entry).some(line => line.includes('Navigation'))).toBe(false)
    expect(() => checkPricePage('<main>Access denied</main>', entry, first.baseline, now + 2)).toThrow('结构')
    expect(() => checkPricePage('<article>Loading…</article>', entry, first.baseline, now + 2)).toThrow('价格表')
    expect(checkPricePage(priceHtml('$1.00'), { ...entry, watch: { ...entry.watch!, excludeSections: ['unrelated'] } }, first.baseline, now + 3).item).toBeUndefined()
  })

  it('正文模式也检查价目图片，未标具体日期的官方日志不编造发布日期', () => {
    const entry = source('kimi-pricing')
    const body = '<div class="mdx-content"><h2>Model pricing</h2><p>Input and output token prices are shown in the official pricing chart below.</p><img src="https://cdn.example.com/prices-v1.png"/></div>'
    const first = checkPricePage(body, entry, undefined, now)
    expect(checkPricePage(body.replace('prices-v1', 'prices-v2'), entry, first.baseline, now + 1).item?.change?.after).toContain('价目图片已更新')
    const notes = '<div class="mdx-content"><h4 id="oct-19-2026">Oct. 19, 2026</h4><a><h2>MiniMax M3.1 Flash</h2><p>A new model</p></a><h4 id="apr-2026">Apr. 2026</h4><a><h2>MiniMax Music-2.6</h2></a></div>'
    expect(parseNews(notes, source('minimax-notes'), now)).toHaveLength(1)
    expect(parseNews(notes, source('minimax-notes'), now)[0].url).toContain('#oct-19-2026')
  })
})
