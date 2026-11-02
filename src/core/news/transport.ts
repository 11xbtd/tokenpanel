import type { NewsSource } from './catalog'
import { VERSION } from '../storage/defaults'

export type NewsFetch = (source: NewsSource) => Promise<string>

/** Runs in Node/preload so feeds do not depend on renderer CORS permissions. */
export const fetchOfficialNews: NewsFetch = async source => {
  const signal = AbortSignal.timeout(15_000)
  const read = async (value: string, redirects = 0): Promise<string> => {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || !source.allowedHosts.includes(url.hostname) || redirects > 3) throw new Error('资讯来源返回了不支持的跳转')
    const response = await fetch(url, { redirect: 'manual', signal, headers: {
      'User-Agent': `TokenPanel/${VERSION} (news-reader)`,
      Accept: 'application/atom+xml, application/rss+xml, application/json, text/xml, application/xml, text/html',
    } })
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel()
      return read(new URL(response.headers.get('location')!, url).href, redirects + 1)
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel()
      throw new Error(`资讯来源暂不可达（HTTP ${response.status}）`)
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        size += chunk.byteLength
        if (size > 3 * 1024 * 1024) {
          await reader.cancel()
          throw new Error('资讯内容超过大小限制')
        }
        chunks.push(chunk)
      }
    } finally { reader.releaseLock() }
    return Buffer.concat(chunks).toString('utf8')
  }
  try {
    if (source.parser === 'feed' && source.feedPages && source.feedPages > 1) {
      const pages = await Promise.all(Array.from({ length: Math.min(source.feedPages, 4) }, (_, index) => {
        const url = new URL(source.url)
        if (index > 0) url.searchParams.set('paged', String(index + 1))
        return read(url.href)
      }))
      return `<feed-pages>${pages.map(page => page.replace(/<\?xml[^?]*\?>/g, '')).join('\n')}</feed-pages>`
    }
    return await read(source.url)
  } catch (error) {
    if (signal.aborted) throw new Error('资讯来源连接超时，请稍后重试')
    throw error
  }
}
