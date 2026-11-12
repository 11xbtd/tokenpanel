import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/core/storage/store'
import { manualBalanceOf } from '../src/core/services/manual'
import type { UsageRecord } from '../src/core/types'

let dir = ''
let store: Store

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenpanel-'))
  store = await Store.open(dir)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function usage(externalId: string, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: crypto.randomUUID(),
    accountId: 'unused',
    providerId: 'deepseek',
    ts: Date.now(),
    model: 'deepseek-chat',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsdMicros: 1000,
    costEstimated: true,
    source: 'csv',
    externalId,
    ...overrides,
  }
}

describe('Store', () => {
  it('额度颜色默认 50/20，自定义持久化，旧配置自动补齐且保留通知阈值', async () => {
    expect(store.getSettings().quotaColors).toEqual({ warningPct: 50, dangerPct: 20 })
    await store.updateSettings({ quotaColors: { warningPct: 60, dangerPct: 25 } })
    expect((await Store.open(dir)).getSettings().quotaColors).toEqual({ warningPct: 60, dangerPct: 25 })

    const configPath = path.join(dir, 'config.json')
    const legacy = JSON.parse(await fs.readFile(configPath, 'utf8'))
    delete legacy.settings.quotaColors
    legacy.settings.alerts.remainingBelowPct = 15
    await fs.writeFile(configPath, JSON.stringify(legacy))
    const migrated = await Store.open(dir)
    expect(migrated.getSettings().quotaColors).toEqual({ warningPct: 50, dangerPct: 20 })
    expect(migrated.getSettings().alerts.remainingBelowPct).toBe(15)
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).settings.quotaColors).toEqual({ warningPct: 50, dangerPct: 20 })
  })

  it('颜色配置拒绝无效范围和倒置阈值，备份恢复保留自定义颜色', async () => {
    for (const quotaColors of [
      { warningPct: 20, dangerPct: 50 }, { warningPct: 20, dangerPct: 20 },
      { warningPct: 101, dangerPct: 20 }, { warningPct: 50, dangerPct: -1 },
      { warningPct: Number.NaN, dangerPct: 20 },
    ]) {
      await expect(store.updateSettings({ quotaColors })).rejects.toThrow('额度颜色阈值')
    }
    expect(store.getSettings().quotaColors).toEqual({ warningPct: 50, dangerPct: 20 })
    await store.updateSettings({ quotaColors: { warningPct: 40, dangerPct: 10 } })
    const bundle = await store.exportBundle(false)
    const restored = await Store.open(path.join(dir, 'restored'))
    await restored.importBundle(bundle)
    expect(restored.getSettings().quotaColors).toEqual({ warningPct: 40, dangerPct: 10 })
  })

  it('重复日志只补齐缺失计时，保留 token、费用、归属和已有速度', async () => {
    const record = usage('timing-1', { source: 'local-log', clientId: 'codex', meta: { source: 'manual' } })
    await store.appendUsage([record])
    const candidate = {
      ...record, id: 'new-id', inputTokens: 9999, costUsdMicros: 9999,
      durationMs: 2000, tokensPerSecond: 10, ttftMs: 500,
      meta: { source: 'auto', durationScope: 'task', ttftScope: 'task' },
    }
    expect(await store.enrichUsageTiming([candidate])).toBe(1)
    expect(await store.appendUsage([candidate])).toBe(0)
    const saved = store.getUsageSince(0)[0]
    expect(saved).toMatchObject({ id: record.id, inputTokens: 100, costUsdMicros: 1000, durationMs: 2000, tokensPerSecond: 10, ttftMs: 500 })
    expect(saved.meta).toMatchObject({ source: 'manual', durationScope: 'task', ttftScope: 'task' })
    expect(await store.enrichUsageTiming([{ ...candidate, tokensPerSecond: 999 }])).toBe(0)
    expect(await store.enrichUsageTiming([{ ...candidate, accountId: 'another-account' }])).toBe(0)
    const reopened = await Store.open(dir)
    expect(reopened.getUsageSince(0)).toHaveLength(1)
    expect(reopened.getUsageSince(0)[0].tokensPerSecond).toBe(10)
  })

  it('密钥加密落盘，列表只返回掩码', async () => {
    const account = await store.saveAccount({
      providerId: 'deepseek',
      label: '主账号',
      auth: { apiKey: 'sk-test-1234567890' },
    })
    const raw = await fs.readFile(path.join(dir, 'config.json'), 'utf8')
    expect(raw).not.toContain('sk-test-1234567890')
    expect(raw).toContain('authEnc')
    expect(account.authMasked.apiKey).not.toContain('1234567890')
    expect(store.getAccount(account.id).auth.apiKey).toBe('sk-test-1234567890')
  })

  it('编辑时留空鉴权字段会保留旧密钥', async () => {
    const account = await store.saveAccount({ providerId: 'deepseek', auth: { apiKey: 'sk-keep-me-123456' } })
    await store.saveAccount({ id: account.id, providerId: 'deepseek', label: '改名', auth: {} })
    expect(store.getAccount(account.id).auth.apiKey).toBe('sk-keep-me-123456')
    expect(store.listAccounts()[0].label).toBe('改名')
  })

  it('并发写 state.json 不会产生损坏或临时文件竞争', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.setSync('a', { at: index + 1, status: 'ok' })))
    const raw = await fs.readFile(path.join(dir, 'state.json'), 'utf8')
    const parsed = JSON.parse(raw) as { sync: Record<string, { at: number }> }
    expect(parsed.sync.a.at).toBe(20)
    const files = await fs.readdir(dir)
    expect(files.filter((file) => file.endsWith('.tmp'))).toHaveLength(0)
  })

  it('日志源支持多账户绑定，旧单绑定写法读盘时折叠', async () => {
    const glm = await store.saveAccount({ providerId: 'glm-plan', label: 'GLM 套餐', auth: { apiKey: 'sk-glm-test' } })
    const minimax = await store.saveAccount({ providerId: 'minimax-plan', label: 'MiniMax 套餐', auth: { planKey: 'sk-mm-test' } })
    const saved = await store.updateSettings({
      logSources: [
        {
          id: 'zcode',
          enabled: true,
          bindings: [
            { accountId: glm.id, modelPattern: 'glm' },
            { accountId: minimax.id, modelPattern: 'minimax' },
            { accountId: glm.id, modelPattern: 'glm' },
            {},
          ],
        },
      ],
    })
    expect(saved.logSources[0].bindings).toHaveLength(2)
    expect(saved.logSources[0].bindings[1]).toEqual({ accountId: minimax.id, modelPattern: 'minimax' })

    const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as {
      settings: { logSources: Array<Record<string, unknown>> }
    }
    raw.settings.logSources = [{ id: 'kimi-code', enabled: true, accountId: glm.id, modelPattern: 'kimi' }]
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(raw, null, 2), 'utf8')

    const reopened = await Store.open(dir)
    expect(reopened.getSettings().logSources[0]).toEqual({
      id: 'kimi-code',
      enabled: true,
      bindings: [{ accountId: glm.id, modelPattern: 'kimi' }],
    })
    expect(reopened.getSettings().logSources[0]).not.toHaveProperty('accountId')
  })

  it('用量按来源+账户+externalId 去重', async () => {
    const account = await store.saveAccount({ providerId: 'deepseek', auth: { apiKey: 'sk-1234567890' } })
    const record = usage('ext-1', { accountId: account.id })
    expect(await store.appendUsage([record])).toBe(1)
    expect(await store.appendUsage([{ ...record, id: crypto.randomUUID() }])).toBe(0)
    expect(store.queryUsage({ pageSize: 10 }).total).toBe(1)
  })

  it('记账调整保留负数，手动余额按台账计算', async () => {
    const account = await store.saveAccount({
      providerId: 'gemini',
      options: { manualBalance: { amount: 100, currency: 'CNY' } },
    })
    await store.addLedger({ accountId: account.id, ts: Date.now(), kind: 'adjust', amount: -5, currency: 'CNY' })
    await store.addLedger({ accountId: account.id, ts: Date.now(), kind: 'recharge', amount: 30, currency: 'CNY' })
    const ledger = store.listLedger(account.id)
    expect(ledger.find((entry) => entry.kind === 'adjust')?.amount).toBe(-5)
    const balance = manualBalanceOf(store.listAccounts()[0], ledger)
    expect(balance).toEqual({ amount: 125, currency: 'CNY' })
  })

  it('带密钥备份可迁移账户、记录与设置', async () => {
    const account = await store.saveAccount({ providerId: 'deepseek', auth: { apiKey: 'sk-migrate-123456' } })
    await store.appendUsage([usage('ext-migrate', { accountId: account.id })])
    await store.updateSettings({ displayCurrency: 'USD', theme: 'dark' })
    const bundle = await store.exportBundle(true)
    expect(bundle.plainAccounts?.[0].auth.apiKey).toBe('sk-migrate-123456')

    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenpanel-other-'))
    try {
      const other = await Store.open(otherDir)
      const result = await other.importBundle(bundle)
      expect(result.accounts).toBe(1)
      expect(result.usage).toBe(1)
      expect(other.listAccounts()[0].authMasked.apiKey).toBeTruthy()
      expect(other.getAccount(other.listAccounts()[0].id).auth.apiKey).toBe('sk-migrate-123456')
      expect(other.getSettings().displayCurrency).toBe('USD')
      expect(other.getSettings().theme).toBe('dark')
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true })
    }
  })

  it('Webhook URL 加密落盘，安全备份移除地址与自定义请求头', async () => {
    await store.updateSettings({
      webhooks: [
        {
          id: 'hook-1',
          type: 'feishu',
          url: 'https://open.feishu.cn/open-apis/bot/v2/hook/SECRET-WEBHOOK',
          enabled: true,
        },
      ],
    })
    const raw = await fs.readFile(path.join(dir, 'config.json'), 'utf8')
    expect(raw).not.toContain('SECRET-WEBHOOK')
    const reopened = await Store.open(dir)
    expect(reopened.getSettings().webhooks[0].url).toContain('SECRET-WEBHOOK')

    await store.saveAccount({
      providerId: 'custom-http',
      options: {
        custom: { method: 'GET', balancePath: 'data.balance', headers: '{"Authorization":"Bearer SECRET-HEADER"}' },
      },
    })
    const safe = JSON.stringify(await store.exportBundle(false))
    expect(safe).not.toContain('SECRET-WEBHOOK')
    expect(safe).not.toContain('SECRET-HEADER')
    const full = JSON.stringify(await store.exportBundle(true))
    expect(full).toContain('SECRET-HEADER')
  })

  it('删除账户时可选清除历史数据', async () => {
    const account = await store.saveAccount({ providerId: 'deepseek', auth: { apiKey: 'sk-delete-123456' } })
    await store.appendUsage([usage('ext-delete', { accountId: account.id })])
    await store.deleteAccount(account.id, true)
    expect(store.listAccounts()).toHaveLength(0)
    expect(store.queryUsage({ pageSize: 10 }).total).toBe(0)
  })
})

describe('套餐到期日', () => {
  it('手动到期日可保存并在重开后保留', async () => {
    const expiresAt = Date.now() + 20 * 86_400_000
    const account = await store.saveAccount({ providerId: 'minimax-plan', auth: { planKey: 'sk-tp-test' }, options: { planExpiresAt: expiresAt } })
    expect(account.options.planExpiresAt).toBe(expiresAt)
    const reopened = await Store.open(dir)
    expect(reopened.getAccount(account.id).options.planExpiresAt).toBe(expiresAt)
  })

  it('拒绝非法到期日，清空后不再保留', async () => {
    const account = await store.saveAccount({ providerId: 'minimax-plan', auth: { planKey: 'sk-tp-test' }, options: { planExpiresAt: Date.now() + 86_400_000 } })
    await expect(store.saveAccount({ id: account.id, providerId: 'minimax-plan', options: { planExpiresAt: -5 } })).rejects.toThrow('到期日')
    const cleared = await store.saveAccount({ id: account.id, providerId: 'minimax-plan', options: {} })
    expect(cleared.options.planExpiresAt).toBeUndefined()
  })
})
