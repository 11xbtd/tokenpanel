import { afterEach, describe, expect, it, vi } from 'vitest'
import { NEWS_SOURCES } from '../src/core/news/catalog'
import { parseNews } from '../src/core/news/parser'
import { fetchOfficialNews } from '../src/core/news/transport'

afterEach(() => vi.unstubAllGlobals())

describe('资讯网络边界', () => {
  const source = NEWS_SOURCES.find(source => source.id === 'openai-news')!

  it('不跟随不受信任的域名、明文或带凭据的跳转', async () => {
    for (const target of ['https://example.com/private', 'http://openai.com/news', 'https://user:secret@openai.com/news']) {
      const request = vi.fn(async () => new Response(null, { status: 302, headers: { location: target } }))
      vi.stubGlobal('fetch', request)
      await expect(fetchOfficialNews(source)).rejects.toThrow('不支持的跳转')
      expect(request).toHaveBeenCalledTimes(1)
    }
  })

  it('限制响应体大小，并把 HTTP 错误交由缓存层处理', async () => {
    vi.stubGlobal('fetch', async () => new Response('x'.repeat(3 * 1024 * 1024 + 1)))
    await expect(fetchOfficialNews(source)).rejects.toThrow('大小限制')
    vi.stubGlobal('fetch', async () => new Response('unavailable', { status: 503 }))
    await expect(fetchOfficialNews(source)).rejects.toThrow('HTTP 503')
  })

  it('合并 RSS 分页，重复文章只保留一条且不漏掉较早报道', async () => {
    const pages: string[] = []
    vi.stubGlobal('fetch', async (value: URL) => {
      const page = value.searchParams.get('paged') ?? '1'
      pages.push(page)
      return new Response(`<?xml version="1.0"?><rss><channel><item><title>MiniMax 周边观察 ${page}</title><link>https://www.qbitai.com/2026/10/${page}.html</link><pubDate>2026-10-29T08:00:00Z</pubDate></item><item><title>MiniMax 同一报道</title><link>https://www.qbitai.com/2026/10/shared.html</link><pubDate>2026-10-29T08:00:00Z</pubDate></item></channel></rss>`)
    })
    const media = NEWS_SOURCES.find(source => source.id === 'qbitai')!
    const items = parseNews(await fetchOfficialNews(media), media)
    expect(pages.sort()).toEqual(['1', '2', '3', '4'])
    expect(items).toHaveLength(5)
    expect(items.every(item => item.stream === 'media')).toBe(true)
  })
})
