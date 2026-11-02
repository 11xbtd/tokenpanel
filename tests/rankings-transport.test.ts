import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRankingsNodeFetch } from '../src/core/rankings/transport'

const endpoint = 'https://artificialanalysis.ai/api/v2/language/models/free?page=1'
const key = 'aa_native-transport-fixture-key'
const body = JSON.stringify({ data: [{ name: '本机传输测试' }] })

function harness(options: { status?: number; headers?: Record<string, string>; body?: string | Buffer; hang?: boolean; error?: string; interrupted?: boolean } = {}) {
  const calls: Array<{ url: string; options: RequestOptions }> = []
  const requests: Array<EventEmitter & { destroyed: boolean }> = []
  const responses: PassThrough[] = []
  const nativeFetch = createRankingsNodeFetch((url, requestOptions, callback) => {
    calls.push({ url: url.href, options: requestOptions })
    const response = Object.assign(new PassThrough(), { statusCode: options.status ?? 200, headers: options.headers ?? { 'content-type': 'application/json' } })
    responses.push(response)
    const req = Object.assign(new EventEmitter(), {
      destroyed: false,
      end() {
        void Promise.resolve().then(() => {
          if (req.destroyed) return
          if (options.error) { req.emit('error', Object.assign(new Error('Transport fixture error'), { code: options.error })); return }
          callback(response as unknown as IncomingMessage)
          if (options.interrupted) { response.emit('aborted'); return }
          if (options.hang) response.write('{')
          else response.end(options.body ?? body)
        })
        return req
      },
      destroy() { req.destroyed = true; return req },
    })
    requests.push(req)
    return req as unknown as ClientRequest
  })
  return { nativeFetch, calls, requests, responses }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('AA 使用明确的 Node HTTPS 通道', () => {
  it('不调用会受浏览器跨域限制的全局 fetch，保留鉴权头并发送 HTTPS GET', async () => {
    const browserFetch = vi.fn(() => { throw new TypeError('Failed to fetch (CORS)') })
    vi.stubGlobal('fetch', browserFetch)
    const test = harness()
    const result = await test.nativeFetch(endpoint, { redirect: 'manual', headers: { 'x-api-key': key, Accept: 'application/json' } })
    expect(await result.json()).toEqual(JSON.parse(body))
    expect(browserFetch).not.toHaveBeenCalled()
    expect(test.calls).toHaveLength(1)
    expect(test.calls[0]).toMatchObject({ url: endpoint, options: { method: 'GET', headers: { 'x-api-key': key, 'accept-encoding': 'identity' } } })
    expect(test.calls[0].options.rejectUnauthorized).not.toBe(false)
  })

  it('不跟随跳转，不读取错误正文，并保留 429 的 Retry-After', async () => {
    for (const status of [302, 401, 429, 503]) {
      const test = harness({ status, headers: { location: 'https://example.com/must-not-follow', 'retry-after': '600' }, body: key })
      const result = await test.nativeFetch(endpoint, { headers: { 'x-api-key': key } })
      expect(result.status).toBe(status)
      expect(result.headers.get('retry-after')).toBe('600')
      expect(await result.text()).toBe('')
      expect(test.calls).toHaveLength(1)
      expect(test.responses[0].destroyed).toBe(true)
    }
  })

  it.each([
    ['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync],
  ] as const)('正确读取 %s 压缩内容，限制作用于解压后的正文', async (encoding, compress) => {
    const test = harness({ headers: { 'content-encoding': encoding, 'content-length': '999' }, body: compress(Buffer.from(body)) })
    const result = await test.nativeFetch(endpoint)
    expect(await result.json()).toEqual(JSON.parse(body))
    expect(result.headers.has('content-encoding')).toBe(false)
    expect(result.headers.has('content-length')).toBe(false)
    const oversized = harness({ headers: { 'content-encoding': encoding }, body: compress(Buffer.alloc(5 * 1024 * 1024 + 1, 65)) })
    await expect(oversized.nativeFetch(endpoint)).rejects.toMatchObject({ code: 'upstream', message: expect.stringContaining('大小限制') })
    expect(oversized.requests[0].destroyed).toBe(true)
    expect(oversized.responses[0].destroyed).toBe(true)
  })

  it('已取消的请求不发出连接，中途取消会关闭请求与响应', async () => {
    const before = harness()
    await expect(before.nativeFetch(endpoint, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(before.calls).toHaveLength(0)
    const during = harness({ hang: true })
    const controller = new AbortController()
    const pending = during.nativeFetch(endpoint, { signal: controller.signal })
    const checked = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    controller.abort()
    await checked
    expect(during.requests[0].destroyed).toBe(true)
    expect(during.responses[0].destroyed).toBe(true)
  })

  it('连接不结束时超时关闭，响应中断不会返回不完整成功内容', async () => {
    vi.useFakeTimers()
    const hanging = harness({ hang: true })
    const checked = expect(hanging.nativeFetch(endpoint)).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    await vi.advanceTimersByTimeAsync(20_000)
    await checked
    expect(hanging.requests[0].destroyed).toBe(true)
    expect(hanging.responses[0].destroyed).toBe(true)
    const interrupted = harness({ interrupted: true })
    await expect(interrupted.nativeFetch(endpoint)).rejects.toMatchObject({ code: 'ECONNRESET' })
  })

  it('拒绝明文 URL、URL 内凭据和非 GET 请求，保留 Node 连接错误代码', async () => {
    const test = harness()
    await expect(test.nativeFetch('http://example.com', { headers: { 'x-api-key': key } })).rejects.toThrow('HTTPS GET')
    await expect(test.nativeFetch('https://user:password@example.com')).rejects.toThrow('HTTPS GET')
    await expect(test.nativeFetch(endpoint, { method: 'POST', body: key })).rejects.toThrow('HTTPS GET')
    expect(test.calls).toHaveLength(0)
    const tls = harness({ error: 'CERT_HAS_EXPIRED' })
    await expect(tls.nativeFetch(endpoint)).rejects.toMatchObject({ code: 'CERT_HAS_EXPIRED' })
  })
})
