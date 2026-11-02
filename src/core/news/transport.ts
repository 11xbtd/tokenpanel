import https from 'node:https'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { NewsSource } from './catalog'

export type NewsFetch = (source: NewsSource) => Promise<string>

/** Node HTTPS avoids relying on a renderer's cross-origin fetch permissions. */
export const fetchOfficialNews: NewsFetch = source => {
  const read = (value: string, redirects = 0): Promise<string> => new Promise((resolve, reject) => {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !source.allowedHosts.includes(url.hostname) || redirects > 3) {
      reject(new Error('官方来源返回了不支持的跳转'))
      return
    }
    const request = https.get(url, { headers: {
      'User-Agent': 'TokenPanel/0.1.0 (official-news-reader)',
      Accept: 'application/atom+xml, application/rss+xml, text/xml, application/xml, text/html',
      'Accept-Encoding': 'gzip, br, deflate',
    } }, response => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        read(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error(`官方来源暂不可达（HTTP ${status}）`))
        return
      }
      const encoding = response.headers['content-encoding']
      const stream = encoding === 'gzip' ? response.pipe(createGunzip()) : encoding === 'br' ? response.pipe(createBrotliDecompress()) : encoding === 'deflate' ? response.pipe(createInflate()) : response
      const chunks: Buffer[] = []
      let size = 0
      response.on('error', reject)
      stream.on('error', reject)
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 3 * 1024 * 1024) {
          stream.destroy()
          request.destroy(new Error('官方订阅内容超过大小限制'))
          return
        }
        chunks.push(chunk)
      })
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    const timer = setTimeout(() => request.destroy(new Error('官方来源连接超时，请稍后重试')), 15_000)
    request.once('close', () => clearTimeout(timer))
    request.on('error', reject)
  })
  return read(source.url)
}
