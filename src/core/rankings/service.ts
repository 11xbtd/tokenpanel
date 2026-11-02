import path from 'node:path'
import { createHash } from 'node:crypto'
import { AppError, ValidationError } from '../errors'
import { decryptText, encryptText, loadOrCreateKey } from '../storage/crypto'
import { readJson, writeJsonAtomic } from '../storage/files'
import { normalizeRankedModel } from './models'
import { fetchRankingsFromNode } from './transport'
import type { RankedModel, RankingsOverview, RankingsSettingsInput } from './types'
import { VERSION } from '../storage/defaults'

export const AA_MODELS_URL = 'https://artificialanalysis.ai/api/v2/language/models/free'
export type RankingsFetch = typeof fetch
interface Cache {
  schema: 1
  models: RankedModel[]
  indexVersion: number
  tier: 'free' | 'pro' | 'commercial'
  fetchedAt: number
}

const HOUR = 3_600_000
const MAX_PAGES = 20

function isRecord(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }

function retryTime(header: string | null, now: number): number {
  const seconds = header && /^\d+$/.test(header) ? Number(header) : undefined
  const time = seconds !== undefined ? now + seconds * 1000 : Date.parse(header ?? '')
  return Math.min(now + 24 * HOUR, Math.max(now + 60_000, Number.isFinite(time) ? time : now + HOUR))
}

export class RankingsService {
  private initialized?: Promise<void>
  private key?: Buffer
  private apiKey = ''
  private keySource: RankingsOverview['keySource'] = 'none'
  private credentialsError?: string
  private connectionToken = ''
  private cache?: Cache
  private checkedAt?: number
  private retryAt?: number
  private error?: string
  private errorCode?: RankingsOverview['errorCode']
  private notice?: string
  private revision = 0
  private inFlight?: { revision: number; promise: Promise<void>; controller: AbortController }
  private mutation = Promise.resolve()

  constructor(private readonly dataDir: string, private readonly fetchImpl: RankingsFetch = fetchRankingsFromNode, private readonly clock = Date.now, private readonly sharedApiKey = '') {}

  private useSharedKey(): void {
    this.apiKey = this.sharedApiKey
    this.keySource = this.sharedApiKey ? 'shared' : 'none'
    this.connectionToken = this.sharedApiKey ? createHash('sha256').update('shared:').update(this.sharedApiKey).digest('hex') : ''
  }

  private initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      this.key = await loadOrCreateKey(this.dataDir)
      this.useSharedKey()
      try {
        const credentials = await readJson<{ encryptedKey?: string }>(path.join(this.dataDir, 'aa-settings.json'), {})
        if (credentials.encryptedKey) {
          this.apiKey = decryptText(this.key, credentials.encryptedKey)
          this.keySource = 'personal'
          this.connectionToken = createHash('sha256').update(credentials.encryptedKey).digest('hex')
        }
      } catch {
        this.useSharedKey()
        if (this.sharedApiKey) this.notice = '本机个人 Key 无法读取，已恢复使用默认共享 Key。'
        else this.credentialsError = 'AA Key 无法读取，请重新配置。'
      }
      try {
        const cached = await readJson<Cache | undefined>(path.join(this.dataDir, 'aa-rankings-cache.json'), undefined)
        const fields = ['intelligence', 'outputSpeed', 'firstTokenSeconds', 'firstAnswerSeconds', 'inputPrice', 'outputPrice', 'cacheReadPrice', 'costPerTask'] as const
        if (cached?.schema === 1 && Array.isArray(cached.models) && cached.models.length <= 5000 && Number.isFinite(cached.fetchedAt) && Number.isFinite(cached.indexVersion) && ['free', 'pro', 'commercial'].includes(cached.tier)) {
          const models = cached.models.filter(model => model && typeof model.id === 'string' && typeof model.name === 'string' && typeof model.creator === 'string' && typeof model.creatorId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(model.slug) && fields.every(field => model[field] === null || (typeof model[field] === 'number' && Number.isFinite(model[field]))))
          if (models.length === cached.models.length) this.cache = { ...cached, models }
        }
      } catch { this.notice = '本机榜单缓存无法读取，连接 AA 后可重新获取。' }
      try {
        const state = await readJson<Record<string, unknown>>(path.join(this.dataDir, 'aa-rankings-state.json'), {})
        if (this.apiKey && state.connectionToken === this.connectionToken) {
          if (typeof state.checkedAt === 'number' && Number.isFinite(state.checkedAt)) this.checkedAt = state.checkedAt
          if (typeof state.retryAt === 'number' && Number.isFinite(state.retryAt) && state.retryAt <= this.clock() + 24 * HOUR) this.retryAt = state.retryAt
          if (typeof state.error === 'string') this.error = state.error.slice(0, 250)
          if (typeof state.errorCode === 'string' && ['auth', 'rate_limit', 'network', 'timeout', 'upstream', 'internal'].includes(state.errorCode)) this.errorCode = state.errorCode as RankingsOverview['errorCode']
        }
      } catch { /* A lost throttle record does not invalidate model data or credentials. */ }
    })().catch(error => { this.initialized = undefined; throw error })
  }

  async get(force = false, cachedOnly = false): Promise<RankingsOverview> {
    await this.initialize()
    await this.mutation
    if (!cachedOnly && this.apiKey && !this.credentialsError) {
      const now = this.clock()
      const blockedUntil = this.retryAt ?? 0
      const last = this.checkedAt ?? this.cache?.fetchedAt
      const retryNetwork = force && (this.errorCode === 'network' || this.errorCode === 'timeout')
      const ttl = retryNetwork ? 0 : force ? 60_000 : this.error ? 5 * 60_000 : 6 * HOUR
      if (now >= blockedUntil && (last === undefined || now - last >= ttl || now < last)) await this.refresh()
    }
    return this.overview()
  }

  async configure(input: RankingsSettingsInput): Promise<RankingsOverview> {
    await this.initialize()
    const operation = this.mutation.then(async () => {
      if (!isRecord(input) || (input.apiKey !== undefined && typeof input.apiKey !== 'string') || (input.removeKey !== undefined && typeof input.removeKey !== 'boolean')) throw new ValidationError('AA 连接设置格式无效')
      if (input.removeKey && input.apiKey?.trim()) throw new ValidationError('请分别操作保存 Key 和移除 Key')
      const apiKey = input.removeKey ? '' : input.apiKey?.trim() || (this.keySource === 'personal' ? this.apiKey : '')
      if (apiKey && !/^[\x21-\x7e]{8,512}$/.test(apiKey)) throw new ValidationError('AA Key 格式无效，请粘贴完整 Key，去除空格和换行')
      const encryptedKey = apiKey ? encryptText(this.key!, apiKey) : undefined
      await writeJsonAtomic(path.join(this.dataDir, 'aa-settings.json'), { encryptedKey })
      this.revision++
      this.inFlight?.controller.abort()
      this.inFlight = undefined
      this.useSharedKey()
      if (encryptedKey) {
        this.apiKey = apiKey
        this.keySource = 'personal'
        this.connectionToken = createHash('sha256').update(encryptedKey).digest('hex')
      }
      this.credentialsError = undefined
      this.error = undefined
      this.errorCode = undefined
      this.checkedAt = undefined
      this.retryAt = undefined
      this.notice = undefined
      // Fetch after changing the key, even when another account's old cache is fresh.
      if (this.cache) this.checkedAt = this.clock() - 6 * HOUR
    })
    this.mutation = operation.catch(() => undefined)
    await operation
    return this.overview()
  }

  private refresh(): Promise<void> {
    const revision = this.revision
    if (this.inFlight?.revision === revision) return this.inFlight.promise
    const controller = new AbortController()
    const apiKey = this.apiKey
    const keySource = this.keySource
    const promise = (async () => {
      const timer = setTimeout(() => controller.abort(), 45_000)
      try {
        const models = new Map<string, RankedModel>()
        let indexVersion: number | undefined
        let tier: Cache['tier'] | undefined
        let finished = false
        let skipped = 0
        let pages = 0
        let totalPages: number | undefined
        for (let page = 1; page <= MAX_PAGES; page++) {
          const url = new URL(AA_MODELS_URL)
          url.searchParams.set('page', String(page))
          let response: Response
          try {
            response = await this.fetchImpl(url, { signal: controller.signal, redirect: 'manual', headers: { 'x-api-key': apiKey, Accept: 'application/json', 'User-Agent': `TokenPanel/${VERSION} (Artificial Analysis client)` } })
          } catch (error) {
            if (error instanceof AppError) throw error
            const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
            if (controller.signal.aborted || code === 'ETIMEDOUT') throw new AppError('timeout', 'AA 连接超时，请检查网络后重试。')
            if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new AppError('network', 'AA 域名解析失败，请检查网络或 DNS 后重试。')
            if (typeof code === 'string' && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) throw new AppError('network', 'AA 的 HTTPS 证书校验失败，请检查系统时间或代理证书配置。')
            throw new AppError('network', '无法连接 Artificial Analysis，请检查网络后重试。')
          }
          if (revision !== this.revision) { await response.body?.cancel(); return }
          if (response.status !== 200) {
            await response.body?.cancel()
            if (response.status === 401) throw new AppError('auth', keySource === 'shared' ? '默认共享 AA Key 已失效，请配置自己的 API Key 继续使用。' : 'AA Key 无效或已失效，请在连接设置中更新。')
            if (response.status === 403) throw new AppError('auth', keySource === 'shared' ? '默认共享 AA Key 暂时无法访问模型数据，请配置自己的 API Key。' : '当前 AA Key 无权访问模型数据，请检查账户权限。')
            if (response.status === 429) {
              this.retryAt = retryTime(response.headers.get('retry-after'), this.clock())
              throw new AppError('rate_limit', keySource === 'shared' ? '共享 AA Key 的请求额度已用尽。可配置自己的免费 API Key 继续同步，或等待额度恢复。' : '你的 AA Key 请求额度暂时用尽，可更换 API Key 或等待额度恢复。')
            }
            throw new AppError('upstream', response.status >= 300 && response.status < 400 ? 'AA 返回了跳转，已停止同步以保护 Key。' : `AA 暂时无法提供数据（HTTP ${response.status}）。`)
          }
          const body = await this.readBody(response)
          let json: unknown
          try { json = JSON.parse(body) } catch { throw new AppError('upstream', 'AA 返回了无法识别的内容，已保留上次榜单。') }
          if (!isRecord(json) || !Array.isArray(json.data) || json.data.length > 1000 || !isRecord(json.pagination) || !Number.isFinite(json.intelligence_index_version) || json.intelligence_index_version <= 0 || !['free', 'pro', 'commercial'].includes(json.tier)) throw new AppError('upstream', 'AA 数据结构已变化，已保留上次榜单。')
          const pagination = json.pagination
          if (pagination.page !== page || !Number.isInteger(pagination.total_pages) || pagination.total_pages < 1 || pagination.total_pages > MAX_PAGES || typeof pagination.has_more !== 'boolean' || pagination.has_more !== (page < pagination.total_pages)) throw new AppError('upstream', 'AA 分页信息异常，已保留上次完整榜单。')
          if ((indexVersion !== undefined && indexVersion !== json.intelligence_index_version) || (totalPages !== undefined && totalPages !== pagination.total_pages) || (tier !== undefined && tier !== json.tier)) throw new AppError('upstream', 'AA 数据在同步期间更新，请稍后重新同步。')
          indexVersion = json.intelligence_index_version
          totalPages = pagination.total_pages
          tier = json.tier
          for (const raw of json.data) {
            const model = normalizeRankedModel(raw)
            if (model) models.set(model.id, model)
            else skipped++
          }
          if (models.size > 5000) throw new AppError('upstream', 'AA 数据量超过本机缓存上限，已保留上次榜单。')
          pages++
          if (!pagination.has_more) { finished = true; break }
        }
        if (!finished || !indexVersion || !tier || !models.size) throw new AppError('upstream', 'AA 尚未返回完整可用的模型数据，已保留上次榜单。')
        if (revision !== this.revision) return
        const cache: Cache = { schema: 1, models: [...models.values()], indexVersion, tier, fetchedAt: this.clock() }
        // Serialize with key changes so an obsolete request cannot overwrite the new connection.
        const write = this.mutation.then(async () => {
          if (revision !== this.revision) return
          await writeJsonAtomic(path.join(this.dataDir, 'aa-rankings-cache.json'), cache)
          this.cache = cache
          this.checkedAt = this.clock()
          this.error = undefined
          this.errorCode = undefined
          this.retryAt = undefined
          this.notice = [pages > 1 ? `本次同步 ${pages} 页` : '', skipped ? `${skipped} 条无效记录未收录` : ''].filter(Boolean).join(' · ') || undefined
          await this.persistState()
        })
        this.mutation = write.catch(() => undefined)
        await write
      } catch (error) {
        if (revision !== this.revision) return
        this.checkedAt = this.clock()
        // Never relay an upstream body, URL, headers, or arbitrary exception containing a key.
        this.error = error instanceof AppError ? error.message : 'AA 同步失败，请稍后重试；已保留上次成功获取的榜单。'
        this.errorCode = error instanceof AppError ? error.code : 'internal'
        const write = this.mutation.then(async () => { if (revision === this.revision) await this.persistState() })
        this.mutation = write.catch(() => undefined)
        await write.catch(() => undefined)
      } finally { clearTimeout(timer) }
    })().finally(() => { if (this.inFlight?.revision === revision) this.inFlight = undefined })
    this.inFlight = { revision, promise, controller }
    return promise
  }

  private async readBody(response: Response): Promise<string> {
    if (!response.body) throw new AppError('upstream', 'AA 返回了空内容。')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 5 * 1024 * 1024) { await reader.cancel(); throw new AppError('upstream', 'AA 响应超过大小限制，已保留上次榜单。') }
        chunks.push(part.value)
      }
    } finally { reader.releaseLock() }
    return Buffer.concat(chunks).toString('utf8')
  }

  private overview(): RankingsOverview {
    const error = this.credentialsError ?? this.error
    return {
      configured: Boolean(this.apiKey), keySource: this.keySource, sharedKeyAvailable: Boolean(this.sharedApiKey),
      status: error ? 'error' : !this.apiKey ? 'unconfigured' : this.cache ? 'ok' : 'idle',
      models: this.cache?.models ?? [], indexVersion: this.cache?.indexVersion, tier: this.cache?.tier,
      fetchedAt: this.cache?.fetchedAt, checkedAt: this.checkedAt, retryAt: this.retryAt, error, errorCode: this.credentialsError ? 'auth' : this.errorCode, notice: this.notice,
    }
  }

  private persistState(): Promise<void> {
    return writeJsonAtomic(path.join(this.dataDir, 'aa-rankings-state.json'), { connectionToken: this.connectionToken, checkedAt: this.checkedAt, retryAt: this.retryAt, error: this.error, errorCode: this.errorCode })
  }
}
