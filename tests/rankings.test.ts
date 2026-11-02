import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeRankedModel, rankedCreatorBrand, rankedCreatorFollowed, sortedRankedModels } from '../src/core/rankings/models'
import { AA_MODELS_URL, RankingsService } from '../src/core/rankings/service'
import { TokenPanelApp } from '../src/core/services/app'
import { redact } from '../src/core/util/redact'

// Contract-shaped synthetic values; never shipped or presented as live AA rankings.
const key = 'aa-test-private-key-for-tests-only'
const now = Date.parse('2026-11-02T04:00:00Z')
function model(id = 'test-alpha', overrides: Record<string, unknown> = {}) {
  return {
    id, slug: id, name: `Model ${id}`, release_date: '2026-10-20', model_creator: { id: 'test-creator', name: 'MiniMax' },
    evaluations: { artificial_analysis_intelligence_index: 42, artificial_analysis_coding_index: null },
    pricing: { price_1m_input_tokens: 0.2, price_1m_output_tokens: 0.8, price_1m_cache_hit_tokens: 0, price_1m_cache_write_tokens: null },
    performance: { median_output_tokens_per_second: 120, median_time_to_first_token_seconds: 1.2, median_time_to_first_answer_token_seconds: 12.4, median_end_to_end_response_time_seconds: 20 },
    artificial_analysis_intelligence_index_cost: { total_cost: 420, cost_per_task: { total_cost: 0.7 } }, ...overrides,
  }
}
function page(data: unknown[] = [model()], current = 1, total = 1, version = 5) {
  return { tier: 'free', intelligence_index_version: version, pagination: { page: current, page_size: 200, total_pages: total, has_more: current < total }, data }
}
const response = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('AA 免费接口字段与模型排序', () => {
  it('按官方字段提取价格和中位速度，首答等待与首 token 延迟分别保存', () => {
    expect(normalizeRankedModel(model())).toMatchObject({ intelligence: 42, outputSpeed: 120, firstTokenSeconds: 1.2, firstAnswerSeconds: 12.4, inputPrice: 0.2, outputPrice: 0.8, cacheReadPrice: 0, costPerTask: 0.7 })
    const missing = normalizeRankedModel(model('missing', { evaluations: { artificial_analysis_intelligence_index: null }, performance: { median_time_to_first_token_seconds: 1 }, pricing: { price_1m_input_tokens: null, price_1m_output_tokens: 0 }, artificial_analysis_intelligence_index_cost: null }))!
    expect(missing).toMatchObject({ intelligence: null, outputSpeed: null, firstTokenSeconds: 1, firstAnswerSeconds: null, inputPrice: null, outputPrice: 0, costPerTask: null })
    expect(normalizeRankedModel(model('invalid', { slug: '../login?secret=x' }))).toBeUndefined()
    expect(normalizeRankedModel(model('negative', { evaluations: { artificial_analysis_intelligence_index: -1 }, pricing: { price_1m_input_tokens: -1 } }))).toMatchObject({ intelligence: -1, inputPrice: null })
  })

  it('能力与速度降序、成本升序，真实 0 与缺测区分，缺测始终置底', () => {
    const high = normalizeRankedModel(model('high'))!
    const low = { ...high, id: 'low', name: 'Low', intelligence: 10, outputSpeed: 5, inputPrice: 0 }
    const missing = { ...high, id: 'none', name: 'None', intelligence: null, outputSpeed: null, inputPrice: null }
    expect(sortedRankedModels([missing, low, high], 'intelligence').map(item => item.id)).toEqual(['high', 'low', 'none'])
    expect(sortedRankedModels([missing, high, low], 'inputPrice').map(item => item.id)).toEqual(['low', 'high', 'none'])
    expect(rankedCreatorBrand('Moonshot AI')).toEqual({ providerId: 'kimi-code-plan', topicId: 'kimi' })
    expect(rankedCreatorBrand('Z AI').providerId).toBe('glm-plan')
    expect(rankedCreatorBrand('New Lab').topicId).toBeUndefined()
    expect(rankedCreatorFollowed('OpenAI', ['codex'])).toBe(true)
    expect(rankedCreatorFollowed('Moonshot AI', ['kimi-code'])).toBe(true)
    expect(rankedCreatorFollowed('MiniMax', ['codex'])).toBe(false)
  })
})

let dir = ''
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenpanel-rankings-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('AA 连接、分页缓存与请求恢复', () => {
  it('没有 Key 和仅请求缓存时不联网，保存的 Key 加密且不返回给前端', async () => {
    let calls = 0
    const service = new RankingsService(dir, async () => { calls++; return response(page()) }, () => now)
    expect(await service.get()).toMatchObject({ configured: false, models: [], status: 'unconfigured' })
    const saved = await service.configure({ apiKey: key })
    expect(saved.configured).toBe(true)
    expect(JSON.stringify(saved)).not.toContain(key)
    expect(await fs.readFile(path.join(dir, 'aa-settings.json'), 'utf8')).not.toContain(key)
    await service.get(false, true)
    expect(calls).toBe(0)
    await expect(service.configure({ apiKey: 'newline\ninvalid' })).rejects.toThrow('格式')
  })

  it('完整取完免费接口分页后才发布新快照，合并重复模型且请求携带固定目的地的 Key', async () => {
    const calls: string[] = []
    const service = new RankingsService(dir, async (input, init) => {
      const url = new URL(String(input)); calls.push(url.href)
      expect(url.origin + url.pathname).toBe(AA_MODELS_URL)
      expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).get('x-api-key')).toBe(key)
      const current = Number(url.searchParams.get('page'))
      return response(page(current === 1 ? [model('alpha')] : [model('alpha'), model('beta')], current, 2))
    }, () => now)
    await service.configure({ apiKey: key })
    const data = await service.get()
    expect(data).toMatchObject({ status: 'ok', tier: 'free', indexVersion: 5, fetchedAt: now })
    expect(data.models).toHaveLength(2)
    expect(calls).toHaveLength(2)
    const reopened = new RankingsService(dir, async () => { throw new Error('should use cache') }, () => now)
    expect((await reopened.get()).models).toEqual(data.models)
    expect((await reopened.configure({ apiKey: '  ' })).configured).toBe(true)
  })

  it('6 小时内缓存有效，手动刷新也至少间隔一分钟，并发请求共用一次同步', async () => {
    let clock = now, calls = 0
    const service = new RankingsService(dir, async () => { calls++; await new Promise(resolve => setTimeout(resolve, 2)); return response(page()) }, () => clock)
    await service.configure({ apiKey: key })
    const [first, second] = await Promise.all([service.get(), service.get()])
    expect(first.models).toEqual(second.models)
    expect(calls).toBe(1)
    await service.get(true)
    expect(calls).toBe(1)
    clock += 60_001
    await service.get()
    expect(calls).toBe(1)
    await service.get(true)
    expect(calls).toBe(2)
    clock += 6 * 3_600_000
    await service.get()
    expect(calls).toBe(3)
  })

  it('第二页失败或评分版本变化时保留完整旧榜单，不用部分结果冒充完整列表', async () => {
    let clock = now, mode = 'ok'
    const service = new RankingsService(dir, async input => {
      const current = Number(new URL(String(input)).searchParams.get('page'))
      if (mode === 'ok') return response(page())
      if (mode === 'fail' && current === 2) return response({ error: key }, 503)
      return response(page([model(`new-${current}`)], current, 2, mode === 'change' && current === 2 ? 6 : 5))
    }, () => clock)
    await service.configure({ apiKey: key })
    const first = await service.get()
    for (mode of ['fail', 'change']) {
      clock += 60_001
      const next = await service.get(true)
      expect(next.models).toEqual(first.models)
      expect(next.fetchedAt).toBe(now)
      expect(next.status).toBe('error')
      expect(JSON.stringify(next)).not.toContain(key)
    }
    const disk = JSON.parse(await fs.readFile(path.join(dir, 'aa-rankings-cache.json'), 'utf8'))
    expect(disk.models).toEqual(first.models)
  })

  it('429 遵守 Retry-After 并跨重启保留退避，不因手动点击重复耗费额度', async () => {
    let clock = now, calls = 0
    const fetcher = async () => { calls++; return response({ error: 'quota' }, 429, { 'retry-after': '600' }) }
    const service = new RankingsService(dir, fetcher, () => clock)
    await service.configure({ apiKey: key })
    const first = await service.get()
    expect(first.retryAt).toBe(now + 600_000)
    clock += 300_000
    await service.get(true)
    const reopened = new RankingsService(dir, fetcher, () => clock)
    await reopened.get(true)
    expect(calls).toBe(1)
    clock += 300_001
    await reopened.get(true)
    expect(calls).toBe(2)
  })

  it('网络失败后手动重试立即发起新请求，不受一分钟成功缓存间隔限制', async () => {
    let calls = 0
    const service = new RankingsService(dir, async () => {
      calls++
      if (calls === 1) throw new Error('Failed to fetch')
      return response(page())
    }, () => now)
    await service.configure({ apiKey: key })
    expect(await service.get()).toMatchObject({ status: 'error', errorCode: 'network' })
    await service.get()
    expect(calls).toBe(1)
    expect(await service.get(true)).toMatchObject({ status: 'ok', error: undefined })
    expect(calls).toBe(2)
  })

  it.each([
    ['ENOTFOUND', 'network', '域名解析失败'],
    ['EAI_AGAIN', 'network', '域名解析失败'],
    ['CERT_HAS_EXPIRED', 'network', '证书校验失败'],
    ['ETIMEDOUT', 'timeout', '连接超时'],
    ['ECONNRESET', 'network', '无法连接'],
  ])('对 %s 显示可操作的提示，不暴露原始异常或 Key', async (code, errorCode, message) => {
    const service = new RankingsService(dir, async () => { throw Object.assign(new Error(`Private error: ${key}`), { code }) }, () => now)
    await service.configure({ apiKey: key })
    const result = await service.get()
    expect(result).toMatchObject({ status: 'error', errorCode, error: expect.stringContaining(message) })
    expect(JSON.stringify(result)).not.toContain(key)
  })

  it('不跟随跳转，不转发上游错误正文和带 Key 的异常，401 提示更新连接', async () => {
    for (const type of ['redirect', 'auth', 'network']) {
      const subdir = path.join(dir, type)
      let calls = 0
      const service = new RankingsService(subdir, async () => {
        calls++
        if (type === 'network') throw new Error(`network failed x-api-key=${key}`)
        return type === 'redirect' ? new Response(null, { status: 302, headers: { location: `https://example.com/?key=${key}` } }) : response({ error: key }, 401)
      }, () => now)
      await service.configure({ apiKey: key })
      const data = await service.get()
      expect(data.status).toBe('error')
      expect(JSON.stringify(data)).not.toContain(key)
      expect(calls).toBe(1)
      if (type === 'auth') expect(data.error).toContain('Key 无效')
    }
  })

  it('Key 变更使旧请求失效，旧结果不能覆盖新连接；移除 Key 后停止联网', async () => {
    let finish!: (value: Response) => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let calls = 0
    const service = new RankingsService(dir, async () => { calls++; started(); return new Promise<Response>(resolve => { finish = resolve }) }, () => now)
    await service.configure({ apiKey: key })
    const pending = service.get()
    await ready
    await service.configure({ removeKey: true })
    finish(response(page()))
    const old = await pending
    expect(old).toMatchObject({ configured: false, models: [], status: 'unconfigured' })
    await service.get(true)
    expect(calls).toBe(1)
    await expect(fs.access(path.join(dir, 'aa-rankings-cache.json'))).rejects.toThrow()
    expect(await fs.readFile(path.join(dir, 'aa-settings.json'), 'utf8')).not.toContain(key)
  })

  it('异常响应、空列表、过大响应和错误分页不会成为新的榜单', async () => {
    for (const value of ['not-json', JSON.stringify(page([])), JSON.stringify(page([model()], 2, 2)), 'x'.repeat(5 * 1024 * 1024 + 1)]) {
      const subdir = await fs.mkdtemp(path.join(dir, 'case-'))
      const service = new RankingsService(subdir, async () => new Response(value), () => now)
      await service.configure({ apiKey: key })
      const data = await service.get()
      expect(data).toMatchObject({ status: 'error', models: [] })
      await expect(fs.access(path.join(subdir, 'aa-rankings-cache.json'))).rejects.toThrow()
    }
  })

  it('应用启动和账户读取不获取 AA 数据，排行连接也不复用账户 Key', async () => {
    let calls = 0
    const app = await TokenPanelApp.create({ dataDir: dir, mode: 'utools', version: 'test', enableLocalLogs: false, fetchImpl: async () => response({}, 503), rankingsFetchImpl: async () => { calls++; return response(page()) } })
    await app.getBootstrap()
    await app.getOverview(30)
    await app.getRankings()
    expect(calls).toBe(0)
    await app.configureRankings({ apiKey: key })
    expect((await app.getRankings()).models).toHaveLength(1)
    expect(calls).toBe(1)
  })
})

describe('默认共享 Key 与个人 Key 回退', () => {
  const sharedKey = 'aa_shared-test-key-never-for-production'

  it('新用户免配置使用共享 Key，缓存读取不联网，共享 Key 不写入个人设置或响应', async () => {
    let calls = 0
    const service = new RankingsService(dir, async (_input, init) => {
      calls++
      expect(new Headers(init?.headers).get('x-api-key')).toBe(sharedKey)
      return response(page())
    }, () => now, sharedKey)
    expect(await service.get(false, true)).toMatchObject({ configured: true, keySource: 'shared', sharedKeyAvailable: true, status: 'idle' })
    expect(calls).toBe(0)
    const data = await service.get()
    expect(data).toMatchObject({ status: 'ok', keySource: 'shared' })
    expect(data.models).toHaveLength(1)
    expect(calls).toBe(1)
    expect(JSON.stringify(data)).not.toContain(sharedKey)
    await expect(fs.access(path.join(dir, 'aa-settings.json'))).rejects.toThrow()
    expect(await fs.readFile(path.join(dir, 'aa-rankings-state.json'), 'utf8')).not.toContain(sharedKey)
    expect(redact(`Failed x-api-key=${sharedKey}`)).not.toContain(sharedKey)
  })

  it('共享额度超限时明确提示个人 Key，个人 Key 不受共享重试时间阻止并在重启后优先使用', async () => {
    let clock = now, exhausted = false
    const used: string[] = []
    const fetcher = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const supplied = new Headers(init?.headers).get('x-api-key')!
      used.push(supplied)
      return supplied === sharedKey && exhausted ? response({ error: sharedKey }, 429, { 'retry-after': '3600' }) : response(page())
    }
    const service = new RankingsService(dir, fetcher, () => clock, sharedKey)
    const initial = await service.get()
    clock += 60_001
    exhausted = true
    const limited = await service.get(true)
    expect(limited).toMatchObject({ keySource: 'shared', status: 'error', errorCode: 'rate_limit', retryAt: clock + 3_600_000, models: initial.models, fetchedAt: now })
    expect(limited.error).toContain('自己的免费 API Key')
    expect(JSON.stringify(limited)).not.toContain(sharedKey)
    await service.get(true)
    expect(used).toHaveLength(2)
    await service.configure({ apiKey: key })
    expect(await service.get()).toMatchObject({ keySource: 'personal', sharedKeyAvailable: true, status: 'ok', error: undefined, errorCode: undefined, retryAt: undefined })
    expect(used).toEqual([sharedKey, sharedKey, key])
    const settings = await fs.readFile(path.join(dir, 'aa-settings.json'), 'utf8')
    expect(settings).not.toContain(key)
    expect(settings).not.toContain(sharedKey)
    const reopened = new RankingsService(dir, fetcher, () => clock, sharedKey)
    expect(await reopened.get()).toMatchObject({ keySource: 'personal', status: 'ok' })
    expect(used).toHaveLength(3)
    clock += 60_001
    await reopened.get(true)
    expect(used.at(-1)).toBe(key)
  })

  it('移除个人 Key 后恢复默认共享 Key，空白配置不会将共享 Key 保存为个人 Key', async () => {
    const used: string[] = []
    const service = new RankingsService(dir, async (_input, init) => {
      used.push(new Headers(init?.headers).get('x-api-key')!)
      return response(page())
    }, () => now, sharedKey)
    expect(await service.configure({ apiKey: ' ' })).toMatchObject({ keySource: 'shared' })
    expect(JSON.parse(await fs.readFile(path.join(dir, 'aa-settings.json'), 'utf8')).encryptedKey).toBeUndefined()
    await service.configure({ apiKey: key })
    await service.get()
    expect(await service.configure({ removeKey: true })).toMatchObject({ configured: true, keySource: 'shared', sharedKeyAvailable: true })
    expect(await service.get()).toMatchObject({ status: 'ok', keySource: 'shared' })
    expect(used).toEqual([key, sharedKey])
    const reopened = new RankingsService(dir, async () => { throw new Error('fresh cache') }, () => now, sharedKey)
    expect(await reopened.get()).toMatchObject({ keySource: 'shared', status: 'ok' })
  })

  it('共享 429 退避跨重启保留，更新发布用共享 Key 后不会复用旧 Key 的限额状态', async () => {
    let calls = 0
    const fetcher = async () => { calls++; return response({}, 429, { 'retry-after': '600' }) }
    const service = new RankingsService(dir, fetcher, () => now, sharedKey)
    await service.get()
    const reopened = new RankingsService(dir, fetcher, () => now + 100_000, sharedKey)
    expect(await reopened.get(true)).toMatchObject({ errorCode: 'rate_limit', retryAt: now + 600_000 })
    expect(calls).toBe(1)
    const replacement = new RankingsService(dir, async () => { calls++; return response(page()) }, () => now + 100_000, `${sharedKey}-replacement`)
    expect(await replacement.get()).toMatchObject({ keySource: 'shared', status: 'ok', retryAt: undefined })
    expect(calls).toBe(2)
  })

  it('切换到个人 Key 后，尚未完成的共享请求不能覆盖新榜单', async () => {
    let finish!: (value: Response) => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const service = new RankingsService(dir, async (_input, init) => {
      if (new Headers(init?.headers).get('x-api-key') === sharedKey) {
        started()
        return new Promise<Response>(resolve => { finish = resolve })
      }
      return response(page([model('personal-result')]))
    }, () => now, sharedKey)
    const pending = service.get()
    await ready
    await service.configure({ apiKey: key })
    expect((await service.get()).models[0]?.id).toBe('personal-result')
    finish(response(page([model('obsolete-shared')]), 200))
    expect((await pending).models[0]?.id).toBe('personal-result')
    expect(JSON.parse(await fs.readFile(path.join(dir, 'aa-rankings-cache.json'), 'utf8')).models[0].id).toBe('personal-result')
  })

  it('应用只在进入榜单时消耗共享额度，个人 Key 覆盖默认值，账户功能不受影响', async () => {
    const used: string[] = []
    const app = await TokenPanelApp.create({
      dataDir: dir, mode: 'utools', version: 'test', enableLocalLogs: false,
      fetchImpl: async () => response({}, 503), rankingsSharedApiKey: sharedKey,
      rankingsFetchImpl: async (_input, init) => { used.push(new Headers(init?.headers).get('x-api-key')!); return response(page()) },
    })
    await app.getBootstrap()
    await app.getOverview(30)
    expect(await app.getRankings(false, true)).toMatchObject({ keySource: 'shared', configured: true })
    expect(used).toHaveLength(0)
    await app.getRankings()
    await app.configureRankings({ apiKey: key })
    expect(await app.getRankings()).toMatchObject({ keySource: 'personal' })
    expect(used).toEqual([sharedKey, key])
  })
})
