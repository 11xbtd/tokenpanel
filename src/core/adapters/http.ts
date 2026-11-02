import { AppError } from '../errors'
import { redact } from '../util/redact'

export interface JsonRequestOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  signal?: AbortSignal
  retry?: number
}

export interface JsonResponse<T> {
  data: T
  status: number
  latencyMs: number
  headers: Headers
}

function upstreamMessage(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const root = data as Record<string, any>
  const candidates = [
    root.error?.message,
    typeof root.error === 'string' ? root.error : undefined,
    root.message,
    root.msg,
    root.base_resp?.status_msg,
    root.detail,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return redact(candidate, 180)
  }
  return undefined
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function jsonRequest<T>(fetchImpl: typeof fetch, options: JsonRequestOptions): Promise<JsonResponse<T>> {
  const method = options.method ?? 'GET'
  const attempts = Math.max(0, options.retry ?? (method === 'GET' ? 1 : 0)) + 1
  const started = Date.now()
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 12_000)
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
      const response = await fetchImpl(options.url, {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'TokenPanel/0.1',
          ...options.headers,
        },
        body: options.body,
        signal,
      })
      const text = await response.text()
      const latencyMs = Date.now() - started
      let data: unknown
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          data = undefined
        }
      }
      if (!response.ok) {
        const message = upstreamMessage(data) ?? `HTTP ${response.status}`
        if (response.status === 401 || response.status === 403) {
          throw new AppError('auth', message, 401, `HTTP ${response.status}`)
        }
        if (response.status === 429) {
          throw new AppError('rate_limit', message, 429, 'HTTP 429')
        }
        if (response.status >= 500 && attempt < attempts - 1) {
          lastError = new AppError('upstream', message, response.status)
          await delay(500)
          continue
        }
        throw new AppError('upstream', message, response.status)
      }
      if (data === undefined) {
        throw new AppError('upstream', text ? `返回的不是 JSON：${redact(text, 120)}` : '上游返回空响应')
      }
      return { data: data as T, status: response.status, latencyMs, headers: response.headers }
    } catch (error) {
      if (error instanceof AppError) {
        if (error.code === 'rate_limit' || error.code === 'auth') throw error
        if (error.code === 'upstream' && attempt < attempts - 1) {
          await delay(400)
          continue
        }
        throw error
      }
      const err = error as Error
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        if (options.signal?.aborted) throw new AppError('timeout', '请求已取消')
        throw new AppError('timeout', '请求超时')
      }
      lastError = error
      if (attempt < attempts - 1) {
        await delay(400)
        continue
      }
    }
  }
  throw new AppError('network', `网络错误：${redact(lastError)}`)
}
