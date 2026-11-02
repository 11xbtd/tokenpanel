import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TokenPanelApp } from '../src/core/services/app'
import { Store } from '../src/core/storage/store'

let dir = ''
let app: TokenPanelApp

function fakeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('api.deepseek.com/user/balance')) {
      return json({ error: { message: 'invalid api key' } }, 401)
    }
    if (url.includes('open.bigmodel.cn/api/monitor/usage/quota/limit')) {
      return json({
        code: 200,
        success: true,
        data: {
          level: 'coding_pro',
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 90 },
            { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 20 },
          ],
        },
      })
    }
    return json({ error: { message: `未模拟：${url}` } }, 404)
  }) as typeof fetch
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenpanel-int-'))
  app = await TokenPanelApp.create({ dataDir: dir, mode: 'browser', version: 'test', fetchImpl: fakeFetch() })
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('刷新编排', () => {
  it('总览从持久化额度快照提供时间轴预估，切换用量区间不改变当前额度预估', async () => {
    const account = await app.saveAccount({ providerId: 'glm-plan', auth: { apiKey: 'demo' } })
    await app.updateSettings({ fxAuto: false })
    const stored = await Store.open(dir)
    const at = Date.now()
    const minute = 60_000
    await stored.appendSnapshots([40, 30, 20].map((remainingPct, index) => ({
      id: `quota-${index}`, accountId: account.id, providerId: 'glm-plan', kind: 'plan' as const,
      at: at - (2 - index) * 10 * minute, status: 'ok' as const, latencyMs: 0, source: 'official' as const,
      windows: [{ key: '5h', label: '5 小时', remainingPct, resetsAt: at + 120 * minute }],
    })))
    await stored.setSync(account.id, { at, status: 'ok' })
    const reopened = await TokenPanelApp.create({ dataDir: dir, mode: 'browser', version: 'test', fetchImpl: fakeFetch(), enableLocalLogs: false })
    const day = (await reopened.getOverview(1)).accounts[0]
    const year = (await reopened.getOverview(365)).accounts[0]
    expect(day.quotaUpdatedAt).toBe(at)
    expect(day.quotaForecasts?.[0]).toMatchObject({ windowKey: '5h', depletesAt: at + 20 * minute, sampleCount: 3 })
    expect(year.quotaForecasts).toEqual(day.quotaForecasts)
    expect(day.windows?.[0].remainingPct).toBe(20)
  })

  it('单个账户失败不影响其他账户，并保留错误快照与告警', async () => {
    await app.saveAccount({
      providerId: 'deepseek',
      label: 'DeepSeek',
      auth: { apiKey: 'bad' },
      options: { thresholds: { balanceBelow: 10 } },
    })
    await app.saveAccount({
      providerId: 'glm-plan',
      label: 'GLM',
      auth: { apiKey: 'demo' },
      options: { thresholds: { remainingBelowPct: 15 } },
    })
    await app.saveAccount({
      providerId: 'gemini',
      label: 'Gemini',
      options: {
        manualBalance: { amount: 100, currency: 'CNY' },
        manualPlan: { planLabel: 'AI Studio', windows: [{ label: '每日请求', total: 10, used: 8, unit: '次' }] },
      },
    })

    const result = await app.refreshAll(true)
    const byLabel = Object.fromEntries(result.results.map((item) => [item.label, item]))
    expect(byLabel.DeepSeek.status).toBe('error')
    expect(byLabel.GLM.status).toBe('ok')
    expect(byLabel.Gemini.status).toBe('ok')

    const overview = await app.getOverview(30)
    const deepseek = overview.accounts.find((account) => account.label === 'DeepSeek')!
    expect(deepseek.status).toBe('error')
    expect(deepseek.error).toContain('invalid api key')

    const glm = overview.accounts.find((account) => account.label === 'GLM')!
    expect(glm.windows?.map((window) => window.remainingPct)).toEqual([10, 80])

    const gemini = overview.accounts.find((account) => account.label === 'Gemini')!
    expect(gemini.balance).toBe(100)
    expect(gemini.windows?.[0].remainingPct).toBe(20)

    expect(result.alerts.some((alert) => alert.type === 'auth_error' && alert.accountId === deepseek.accountId)).toBe(true)
    expect(result.alerts.some((alert) => alert.type === 'plan_low' && alert.accountId === glm.accountId)).toBe(true)
  })

  it('手动账户余额随记账变化，刷新周期内自动刷新会跳过', async () => {
    const gemini = await app.saveAccount({
      providerId: 'gemini',
      label: 'Gemini',
      options: { manualBalance: { amount: 100, currency: 'CNY' } },
    })
    await app.refreshAll(true)
    expect((await app.getOverview(30)).accounts[0].balance).toBe(100)
    await app.addLedger({ accountId: gemini.id, ts: Date.now(), kind: 'recharge', amount: 20, currency: 'CNY' })
    expect((await app.getOverview(30)).accounts[0].balance).toBe(120)

    const skipped = await app.refreshAll(false)
    expect(skipped.skipped).toBe(true)
    expect(skipped.results).toHaveLength(0)
  })

  it('告警不落库：每次进来按当前状态现算', async () => {
    await app.saveAccount({
      providerId: 'deepseek',
      label: 'DeepSeek',
      auth: { apiKey: 'bad' },
      options: { thresholds: { balanceBelow: 10 } },
    })
    const first = await app.refreshAll(true)
    expect(first.alerts.filter((alert) => alert.type === 'auth_error')).toHaveLength(1)

    // 磁盘上没有告警文件：告警只在内存里现算现用。
    const files = await fs.readdir(dir)
    expect(files.some((file) => file.startsWith('alerts'))).toBe(false)

    // 再次进入面板（bootstrap）依然能算出当前告警。
    const bootstrap = await app.getBootstrap()
    expect(bootstrap.alerts.some((alert) => alert.type === 'auth_error')).toBe(true)
    const current = await app.currentAlerts()
    expect(current.some((alert) => alert.type === 'auth_error')).toBe(true)
  })

  it('告警只在本次进程内去重，重启后仍会重新提示', async () => {
    await app.saveAccount({
      providerId: 'deepseek',
      label: 'DeepSeek',
      auth: { apiKey: 'bad' },
      options: { thresholds: { balanceBelow: 10 } },
    })
    await app.refreshAll(true)
    const reopened = await TokenPanelApp.create({ dataDir: dir, mode: 'browser', version: 'test', fetchImpl: fakeFetch() })
    const alerts = await reopened.currentAlerts()
    expect(alerts.some((alert) => alert.type === 'auth_error')).toBe(true)
  })

  it('账户编辑留空密钥不会破坏后续刷新', async () => {
    const glm = await app.saveAccount({ providerId: 'glm-plan', label: 'GLM', auth: { apiKey: 'demo' } })
    await app.refreshAll(true)
    await app.saveAccount({ id: glm.id, providerId: 'glm-plan', label: 'GLM 改名', auth: {} })
    const result = await app.refreshAccount(glm.id)
    expect(result.status).toBe('ok')
    expect((await app.getBootstrap()).accounts[0].label).toBe('GLM 改名')
  })
})
