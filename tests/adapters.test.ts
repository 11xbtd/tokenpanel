import { describe, expect, it } from 'vitest'
import { Pricing } from '../src/core/pricing/pricing'
import type { AdapterContext } from '../src/core/adapters/types'
import * as bal from '../src/core/adapters/balance'
import * as plans from '../src/core/adapters/plans'
import { anthropicUsage, openaiUsage } from '../src/core/adapters/usage'
import { relayBalance, relayUsage } from '../src/core/adapters/relay'
import { customQuota } from '../src/core/adapters/custom'
import type { AccountOptions } from '../src/core/types'

const pricing = new Pricing({ updatedAt: 0, models: {} }, 7.2)
const NOW = Date.UTC(2026, 9, 29, 1, 0, 0)

interface Route {
  match: string
  body: unknown
  status?: number
}

function fakeFetch(
  routes: Route[],
  seen?: Array<{ url: string; auth?: string; headers?: Record<string, string> }>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = (init?.headers ?? {}) as Record<string, string>
    seen?.push({ url, auth: headers.Authorization, headers })
    const route = routes.find((item) => url.includes(item.match))
    if (!route) {
      return new Response(JSON.stringify({ error: { message: `未模拟：${url}` } }), { status: 404 })
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

function ctx(
  providerId: string,
  auth: Record<string, string>,
  fetchImpl: typeof fetch,
  options: AccountOptions = {},
): AdapterContext {
  return {
    account: { id: 'acc', providerId, label: 'Test', enabled: true, createdAt: 0, auth, options },
    fetch: fetchImpl,
    now: NOW,
    timeoutMs: 2000,
    quotaPerUnit: 500000,
    pricing,
  }
}

describe('余额适配器', () => {
  it('DeepSeek 解析余额与赠送金额', async () => {
    const result = await bal.deepseekBalance(
      ctx('deepseek', { apiKey: 'k' }, fakeFetch([
        {
          match: '/user/balance',
          body: {
            is_available: true,
            balance_infos: [{ currency: 'CNY', total_balance: '128.60', granted_balance: '10.00', topped_up_balance: '118.60' }],
          },
        },
      ])),
    )
    expect(result.balance).toBe(128.6)
    expect(result.currency).toBe('CNY')
    expect(result.kind).toBe('balance')
  })

  it('Kimi 国际站使用 USD', async () => {
    const result = await bal.kimiBalance(
      ctx('kimi-global', { apiKey: 'k' }, fakeFetch([
        { match: '/v1/users/me/balance', body: { data: { available_balance: '12.5', cash_balance: '10' } } },
      ])),
    )
    expect(result.currency).toBe('USD')
    expect(result.balance).toBe(12.5)
  })

  it('StepFun / 302 / Novita / xAI 单位换算', async () => {
    const step = await bal.stepfunBalance(
      ctx('stepfun', { apiKey: 'k' }, fakeFetch([{ match: '/v1/accounts', body: { balance: 8.8, total_cash_balance: 8, total_voucher_balance: 0.8 } }])),
    )
    expect(step.balance).toBe(8.8)

    const cheap = await bal.ai302Balance(
      ctx('302ai', { apiKey: 'k' }, fakeFetch([{ match: '/dashboard/balance', body: { data: { balance: 3.2 } } }])),
    )
    expect(cheap.balance).toBe(3.2)

    const novita = await bal.novitaBalance(
      ctx('novita', { apiKey: 'k' }, fakeFetch([{ match: '/billing/balance/detail', body: { availableBalance: 123456 } }])),
    )
    expect(novita.balance).toBe(12.3456)

    const xai = await bal.xaiBalance(
      ctx('xai', { managementKey: 'm', teamId: 't1' }, fakeFetch([{ match: '/prepaid/balance', body: { total: { val: 12345 } } }])),
    )
    expect(xai.balance).toBe(123.45)
  })

  it('AIHubMix 按 quotaPerUnit 换算', async () => {
    const result = await bal.aihubmixBalance(
      ctx('aihubmix', { systemToken: 'fd-test' }, fakeFetch([{ match: '/api/user/self', body: { data: { quota: 1250000, used_quota: 500000 } } }])),
    )
    expect(result.balance).toBe(2.5)
    expect(result.extras?.used).toBe(1)
  })

  it('OpenRouter 管理 Key 求差额，普通 Key 显示额度窗口', async () => {
    const credits = await bal.openrouterBalance(
      ctx('openrouter', { managementKey: 'mg' }, fakeFetch([{ match: '/api/v1/credits', body: { data: { total_credits: 80, total_usage: 23.45 } } }])),
    )
    expect(credits.balance).toBe(56.55)

    const key = await bal.openrouterBalance(
      ctx('openrouter', { apiKey: 'k' }, fakeFetch([{ match: '/api/v1/key', body: { data: { limit: 10, usage: 3.5, limit_remaining: 6.5 } } }])),
    )
    expect(key.balance).toBe(6.5)
    expect(key.windows?.[0].usedPct).toBe(35)
  })

  it('鉴权失败抛出 auth 错误', async () => {
    await expect(
      bal.deepseekBalance(
        ctx('deepseek', { apiKey: 'bad' }, fakeFetch([{ match: '/user/balance', status: 401, body: { error: { message: 'invalid api key' } } }])),
      ),
    ).rejects.toMatchObject({ code: 'auth' })
  })

  it('网络中止归类为超时', async () => {
    const aborted = (async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }) as unknown as typeof fetch
    await expect(bal.deepseekBalance(ctx('deepseek', { apiKey: 'k' }, aborted))).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('套餐适配器', () => {
  it('GLM/Z.AI 解析 5 小时与周窗口，且 Authorization 不带 Bearer', async () => {
    const seen: Array<{ url: string; auth?: string }> = []
    const result = await plans.glmPlan(
      ctx('glm-plan', { apiKey: 'demo-key' }, fakeFetch([
        {
          match: '/api/monitor/usage/quota/limit',
          body: {
            code: 200,
            success: true,
            data: {
              level: 'coding_pro',
              limits: [
                { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42, nextResetTime: new Date(NOW + 2 * 3600_000).toISOString() },
                { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 68, nextResetTime: new Date(NOW + 3 * 86400_000).toISOString() },
              ],
            },
          },
        },
      ], seen)),
    )
    expect(seen[0].auth).toBe('demo-key')
    expect(result.windows?.map((window) => window.remainingPct)).toEqual([58, 32])
    expect(result.planLabel).toBe('Coding Pro')
  })

  it('MiniMax Token Plan 按次数计算剩余', async () => {
    const result = await plans.minimaxPlan(
      ctx('minimax-plan', { planKey: 'k' }, fakeFetch([
        {
          match: '/v1/token_plan/remains',
          body: {
            base_resp: { status_code: 0 },
            model_remains: [{ model_name: 'M3', current_interval_total_count: 100, current_interval_usage_count: 30, end_time: NOW + 3600_000 }],
          },
        },
      ])),
    )
    expect(result.windows?.[0].remainingPct).toBe(70)
    expect(result.windows?.[0].unit).toBe('次')
  })

  it('MiniMax Coding Plan 使用百分比字段（计数字段为 0）', async () => {
    const result = await plans.minimaxPlan(
      ctx('minimax-plan', { planKey: 'k' }, fakeFetch([
        {
          match: '/v1/token_plan/remains',
          body: {
            base_resp: { status_code: 0 },
            model_remains: [
              {
                start_time: NOW,
                end_time: NOW + 5 * 3600_000,
                remains_time: 5 * 3600_000,
                current_interval_total_count: 0,
                current_interval_usage_count: 0,
                model_name: 'general',
                current_weekly_total_count: 0,
                current_weekly_usage_count: 0,
                weekly_end_time: NOW + 4 * 86400_000,
                weekly_remains_time: 4 * 86400_000,
                current_interval_status: 1,
                current_interval_remaining_percent: 100,
                current_weekly_status: 1,
                current_weekly_remaining_percent: 89,
              },
            ],
          },
        },
      ])),
    )
    expect(result.windows?.map((window) => ({ label: window.label, remaining: window.remainingPct }))).toEqual([
      { label: '5 小时', remaining: 100 },
      { label: '每周', remaining: 89 },
    ])
    expect(result.windows?.[0].usedPct).toBe(0)
  })

  it('OpenCode Go 解析 5 小时 / 每周 / 每月窗口', async () => {
    const seen: Array<{ url: string; auth?: string }> = []
    const result = await plans.openCodeGoPlan(
      ctx('opencode-go', { apiKey: 'demo-key' }, fakeFetch([
        {
          match: '/zen/go/v1/usage',
          body: {
            plan: 'Go',
            usage: {
              rolling: { percent: 25 },
              weekly: { percent: 40 },
              monthly: { percent: 12.5 },
            },
            rollingUsage: { resetInSec: 3600 },
          },
        },
      ], seen)),
    )
    expect(seen[0].url).toContain('https://opencode.ai/zen/go/v1/usage')
    expect(seen[0].auth).toBe('Bearer demo-key')
    expect(result.windows?.map((window) => ({ label: window.label, remaining: window.remainingPct }))).toEqual([
      { label: '5 小时', remaining: 75 },
      { label: '每周', remaining: 60 },
      { label: '每月', remaining: 87.5 },
    ])
    expect(result.windows?.[0].resetsAt).toBe(NOW + 3600_000)
    expect(result.planLabel).toBe('Go')
  })

  it('OpenCode Go 也认 rollingUsage 形状与 used/limit 绝对值', async () => {
    const result = await plans.openCodeGoPlan(
      ctx('opencode-go', { apiKey: 'k' }, fakeFetch([
        {
          match: '/zen/go/v1/usage',
          body: {
            rollingUsage: { usagePercent: 30, resetsAt: NOW + 7200_000 },
            weeklyUsage: { used: 25, limit: 100 },
          },
        },
      ])),
    )
    expect(result.windows?.map((window) => window.remainingPct)).toEqual([70, 75])
    expect(result.windows?.[0].resetsAt).toBe(NOW + 7200_000)
  })

  it('OpenCode Go 认不出窗口时报错，不当成 0 额度', async () => {
    await expect(
      plans.openCodeGoPlan(
        ctx('opencode-go', { apiKey: 'k' }, fakeFetch([{ match: '/zen/go/v1/usage', body: { hello: 'world' } }])),
      ),
    ).rejects.toThrow(/未返回额度窗口/)
  })

  it('Claude 解析 5h/7d 百分比', async () => {
    const result = await plans.claudePlan(
      ctx('claude-plan', { oauthToken: 't' }, fakeFetch([
        {
          match: '/api/oauth/usage',
          body: { five_hour: { utilization: 25, resets_at: new Date(NOW + 3600_000).toISOString() }, seven_day: { utilization: 50 } },
        },
      ])),
    )
    expect(result.windows?.map((window) => window.remainingPct)).toEqual([75, 50])
  })

  it('Codex 解析主/次窗口并从秒数生成标签', async () => {
    const result = await plans.codexPlan(
      ctx('codex-plan', { oauthToken: 't', accountId: 'acc' }, fakeFetch([
        {
          match: '/backend-api/wham/usage',
          body: {
            plan_type: 'plus',
            rate_limit: {
              primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: NOW / 1000 + 3600 },
              secondary_window: { used_percent: 40, limit_window_seconds: 604800 },
            },
          },
        },
      ])),
    )
    expect(result.windows?.map((window) => window.label)).toEqual(['5 小时', '7 天'])
    expect(result.windows?.map((window) => window.remainingPct)).toEqual([90, 60])
  })

  it('Kimi Code 兼容 limit/remaining 与分钟窗口', async () => {
    const seen: Array<{ url: string; auth?: string; headers?: Record<string, string> }> = []
    const result = await plans.kimiCodePlan(
      ctx('kimi-code-plan', { accessToken: 't' }, fakeFetch([
        {
          match: '/coding/v1/usages',
          body: {
            usage: { limit: 100, remaining: 80, resetTime: NOW + 86400_000 },
            limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 50, remaining: 10 } }],
            user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
          },
        },
      ], seen)),
    )
    expect(result.windows?.map((window) => window.label)).toEqual(['每周', '5 小时'])
    expect(result.windows?.[1].remainingPct).toBe(20)
    expect(result.windows?.[0].used).toBeUndefined()
    expect(result.windows?.[0].total).toBeUndefined()
    expect(result.windows?.[0].unit).toBeUndefined()
    expect(result.planLabel).toBe('Intermediate')
    expect(seen[0].headers?.['X-Msh-Platform']).toBe('kimi_code_cli')
    expect(seen[0].headers?.['X-Msh-Device-Id']).toBeTruthy()
  })

  it('Kimi Code 用 API Key 优先，并解析 usages 池', async () => {
    const seen: Array<{ url: string; auth?: string; headers?: Record<string, string> }> = []
    const result = await plans.kimiCodePlan(
      ctx('kimi-code-plan', { apiKey: 'sk-kimi', accessToken: 'cli-token' }, fakeFetch([
        {
          match: '/coding/v1/usages',
          body: {
            usages: {
              limit_5h: { used_ratio: 0.25, reset_time: new Date(NOW + 3600_000).toISOString() },
              limit_7d: { used_ratio: 0.11, reset_time: new Date(NOW + 3 * 86400_000).toISOString() },
              limit_month_total: { used_ratio: 0.4 },
            },
            user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
          },
        },
      ], seen)),
    )
    expect(seen[0].auth).toBe('Bearer sk-kimi')
    expect(seen[0].headers?.['X-Msh-Platform']).toBeUndefined()
    expect(result.windows?.map((window) => [window.label, window.remainingPct])).toEqual([
      ['5 小时', 75],
      ['每周', 89],
      ['每月（共享）', 60],
    ])
    expect(result.planLabel).toBe('Intermediate')
  })
})

describe('用量适配器', () => {
  it('OpenAI 用日账单分摊实际费用，并扣除缓存输入', async () => {
    const bucket = Math.floor(NOW / 86_400_000) * 86_400
    const records = await openaiUsage(
      ctx('openai-usage', { adminKey: 'sk-admin' }, fakeFetch([
        {
          match: '/v1/organization/usage/completions',
          body: {
            data: [{ start_time: bucket, results: [{ input_tokens: 180000, output_tokens: 22000, input_cached_tokens: 60000, model: 'gpt-5.1' }] }],
            has_more: false,
          },
        },
        {
          match: '/v1/organization/costs',
          body: { data: [{ start_time: bucket, results: [{ amount: { value: 0.42, currency: 'USD' } }] }], has_more: false },
        },
      ])),
      NOW - 86_400_000,
    )
    expect(records).toHaveLength(1)
    expect(records[0].inputTokens).toBe(120000)
    expect(records[0].cacheReadTokens).toBe(60000)
    expect(records[0].costUsdMicros).toBe(420000)
    expect(records[0].costEstimated).toBe(false)
  })

  it('Anthropic 费用报告按美分换算', async () => {
    const records = await anthropicUsage(
      ctx('anthropic-usage', { adminKey: 'sk-ant-admin01' }, fakeFetch([
        {
          match: '/v1/organizations/usage_report/messages',
          body: {
            data: [
              {
                starting_at: '2026-10-29T00:00:00Z',
                results: [
                  {
                    uncached_input_tokens: 1000,
                    cache_read_input_tokens: 200,
                    cache_creation_input_tokens: 300,
                    output_tokens: 500,
                    model: 'claude-sonnet-4-5',
                  },
                ],
              },
            ],
            has_more: false,
          },
        },
        {
          match: '/v1/organizations/cost_report',
          body: { data: [{ starting_at: '2026-10-29T00:00:00Z', results: [{ amount: { value: '100', currency: 'USD' } }] }] },
        },
      ])),
      NOW - 86_400_000,
    )
    expect(records).toHaveLength(1)
    expect(records[0].cacheWriteTokens).toBe(300)
    expect(records[0].costUsdMicros).toBe(1_000_000)
  })

  it('中转站余额与日志：跳过非消费记录并解析缓存 token', async () => {
    const options = { baseUrl: 'https://relay.example.com', quotaPerUnit: 500000 }
    const balance = await relayBalance(
      ctx('newapi', { accessToken: 'nap_x' }, fakeFetch([{ match: '/api/user/self', body: { success: true, data: { quota: 1250000, used_quota: 500000, request_count: 10 } } }]), options),
    )
    expect(balance.balance).toBe(2.5)
    expect(balance.usage?.costUsd).toBe(1)

    const records = await relayUsage(
      ctx('newapi', { accessToken: 'nap_x' }, fakeFetch([
        {
          match: '/api/log/self',
          body: {
            success: true,
            data: {
              items: [
                { id: 1, type: 2, created_at: Math.floor(NOW / 1000), model_name: 'gpt-4o-mini', prompt_tokens: 100, completion_tokens: 20, quota: 25000, other: '{"cache_tokens":1000}' },
                { id: 2, type: 2, created_at: Math.floor(NOW / 1000), model_name: 'gpt-4o-mini', prompt_tokens: 10, completion_tokens: 2, quota: 5000 },
                { id: 3, type: 3, created_at: Math.floor(NOW / 1000), model_name: 'gpt-4o-mini', quota: 0 },
              ],
              total: 3,
            },
          },
        },
      ]), options),
      NOW - 86_400_000,
    )
    expect(records).toHaveLength(2)
    expect(records[0].cacheReadTokens).toBe(1000)
    expect(records[0].costUsdMicros).toBe(50000)
    expect(records[0].costEstimated).toBe(false)
  })
})

describe('自定义 HTTP', () => {
  it('替换 {{apiKey}} 并按点路径提取余额', async () => {
    const seen: Array<{ url: string; auth?: string }> = []
    const result = await customQuota(
      ctx(
        'custom-http',
        { apiKey: 'demo-key' },
        fakeFetch([{ match: '/balance', body: { data: { balance: '9.9', currency: 'USD' } } }], seen),
        {
          baseUrl: 'https://example.com/balance',
          custom: { method: 'GET', headers: '{"Authorization":"Bearer {{apiKey}}"}', balancePath: 'data.balance', currencyPath: 'data.currency' },
        },
      ),
    )
    expect(seen[0].auth).toBe('Bearer demo-key')
    expect(result.balance).toBe(9.9)
    expect(result.currency).toBe('USD')
  })
})
