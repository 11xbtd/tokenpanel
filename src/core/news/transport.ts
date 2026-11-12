import type { NewsSource } from './catalog'
import { VERSION } from '../storage/defaults'

export type NewsFetch = (source: NewsSource) => Promise<string>
export type NewsArticleFetch = (source: NewsSource, url: string) => Promise<string>

const MAX_BYTES = 3 * 1024 * 1024

/** 只允许白名单域名上的 https 跳转，正文大小受限。 */
async function readHtml(value: string, allowedHosts: string[], signal: AbortSignal, redirects = 0): Promise<string> {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts.includes(url.hostname) || redirects > 3) throw new Error('资讯来源返回了不支持的跳转')
  const response = await fetch(url, { redirect: 'manual', signal, headers: {
    'User-Agent': `TokenPanel/${VERSION} (news-reader)`,
    Accept: 'application/atom+xml, application/rss+xml, application/json, text/xml, application/xml, text/html',
  } })
  if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
    await response.body?.cancel()
    return readHtml(new URL(response.headers.get('location')!, url).href, allowedHosts, signal, redirects + 1)
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
      if (size > MAX_BYTES) {
        await reader.cancel()
        throw new Error('资讯内容超过大小限制')
      }
      chunks.push(chunk)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}

/** Runs in Node/preload so feeds do not depend on renderer CORS permissions. */
export const fetchOfficialNews: NewsFetch = async source => {
  const signal = AbortSignal.timeout(15_000)
  try {
    if (source.parser === 'feed' && source.feedPages && source.feedPages > 1) {
      const pages = await Promise.all(Array.from({ length: Math.min(source.feedPages, 4) }, (_, index) => {
        const url = new URL(source.url)
        if (index > 0) url.searchParams.set('paged', String(index + 1))
        return readHtml(url.href, source.allowedHosts, signal)
      }))
      return `<feed-pages>${pages.map(page => page.replace(/<\?xml[^?]*\?>/g, '')).join('\n')}</feed-pages>`
    }
    return await readHtml(source.url, source.allowedHosts, signal)
  } catch (error) {
    if (signal.aborted) throw new Error('资讯来源连接超时，请稍后重试')
    throw error
  }
}

/** 抓原文页面正文；地址必须落在该来源的域名白名单内。 */
export const fetchNewsArticle: NewsArticleFetch = async (source, url) => {
  const signal = AbortSignal.timeout(15_000)
  try {
    return await readHtml(url, source.allowedHosts, signal)
  } catch (error) {
    if (signal.aborted) throw new Error('原文页面连接超时，请稍后重试')
    throw error
  }
}
