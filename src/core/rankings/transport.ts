import { request, type RequestOptions } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { createBrotliDecompress, createUnzip } from 'node:zlib'
import type { Readable, Transform } from 'node:stream'
import { AppError } from '../errors'

type HttpsRequest = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest

/** uTools' global fetch belongs to Chromium. Use Node explicitly to avoid renderer CORS. */
export function createRankingsNodeFetch(requestImpl: HttpsRequest = request): typeof fetch {
  return async (input, init = {}) => {
    const requestInput = typeof input === 'string' || input instanceof URL ? undefined : input
    const url = new URL(requestInput ? requestInput.url : String(input))
    const method = (init.method ?? requestInput?.method ?? 'GET').toUpperCase()
    if (url.protocol !== 'https:' || url.username || url.password || method !== 'GET' || init.body != null) throw new TypeError('AA transport requires an HTTPS GET request')
    const headers = new Headers(init.headers ?? requestInput?.headers)
    headers.set('Accept-Encoding', 'identity')
    const signal = init.signal ?? requestInput?.signal

    return new Promise<Response>((resolve, reject) => {
      let req: ClientRequest | undefined
      let incoming: IncomingMessage | undefined
      let decoded: Transform | undefined
      let settled = false
      const timer = setTimeout(() => fail(Object.assign(new Error('AA connection timed out'), { code: 'ETIMEDOUT' })), 20_000)
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        clean()
        decoded?.destroy()
        incoming?.destroy()
        req?.destroy()
        reject(error)
      }
      const finish = (body: string | null, status: number, responseHeaders: Headers) => {
        if (settled) return
        try {
          const response = new Response(body, { status, headers: responseHeaders })
          settled = true
          clean()
          resolve(response)
        } catch (error) { fail(error) }
      }
      const abort = () => fail(Object.assign(new Error('AA request aborted'), { name: 'AbortError', code: 'ABORT_ERR' }))
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener('abort', abort, { once: true })

      try {
        req = requestImpl(url, { method, headers: Object.fromEntries(headers) }, response => {
          incoming = response
          response.once('error', fail)
          response.once('aborted', () => fail(Object.assign(new Error('AA response interrupted'), { code: 'ECONNRESET' })))
          const status = response.statusCode ?? 502
          const responseHeaders = new Headers()
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item)
          }
          // Return status/Retry-After without reading an error body, and never follow redirects.
          if (status !== 200) {
            finish(null, status, responseHeaders)
            response.destroy()
            return
          }

          const encoding = responseHeaders.get('content-encoding')?.toLowerCase().trim()
          let body: Readable = response
          if (encoding && encoding !== 'identity') {
            if (!['gzip', 'deflate', 'br'].includes(encoding)) { fail(new AppError('upstream', 'AA 返回了不支持的压缩格式，已保留上次榜单。')); return }
            decoded = encoding === 'br' ? createBrotliDecompress() : createUnzip()
            body = response.pipe(decoded)
            body.once('error', fail)
          }
          responseHeaders.delete('content-encoding')
          responseHeaders.delete('content-length')
          const chunks: Buffer[] = []
          let size = 0
          body.on('data', (chunk: Buffer) => {
            if (settled) return
            size += chunk.length
            if (size > 5 * 1024 * 1024) { fail(new AppError('upstream', 'AA 响应超过大小限制，已保留上次榜单。')); return }
            chunks.push(chunk)
          })
          body.once('end', () => finish(Buffer.concat(chunks).toString('utf8'), status, responseHeaders))
        })
        req.once('error', fail)
        req.end()
      } catch (error) { fail(error) }
    })
  }
}

export const fetchRankingsFromNode = createRankingsNodeFetch()
