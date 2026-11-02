import type { TokenPanelApp } from '../core/services/app'

const DAY = 86_400_000

function dateOnly(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * DAY)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function createDemoFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const now = Date.now()

    if (url.includes('api.deepseek.com/user/balance')) {
      return json({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '128.60', granted_balance: '10.00', topped_up_balance: '118.60' },
        ],
      })
    }
    if (url.includes('openrouter.ai/api/v1/credits')) {
      return json({ data: { total_credits: 80, total_usage: 23.45 } })
    }
    if (url.includes('open.bigmodel.cn/api/monitor/usage/quota/limit')) {
      return json({
        code: 200,
        success: true,
        data: {
          level: 'coding_pro',
          limits: [
            {
              type: 'TOKENS_LIMIT',
              unit: 3,
              number: 5,
              percentage: 42,
              nextResetTime: new Date(now + 2 * 3_600_000).toISOString(),
            },
            {
              type: 'TOKENS_LIMIT',
              unit: 6,
              number: 1,
              percentage: 68,
              nextResetTime: new Date(now + 3 * DAY).toISOString(),
            },
          ],
        },
      })
    }
    if (url.includes('api.openai.com/v1/organization/usage/completions')) {
      const bucket = Math.floor(now / DAY) * 86_400
      return json({
        object: 'page',
        data: [
          {
            object: 'bucket',
            start_time: bucket,
            end_time: bucket + 86_400,
            results: [
              {
                object: 'organization.usage.completions.result',
                input_tokens: 180_000,
                output_tokens: 22_000,
                input_cached_tokens: 60_000,
                num_model_requests: 36,
                model: 'gpt-5.1',
              },
            ],
          },
        ],
        has_more: false,
      })
    }
    if (url.includes('api.openai.com/v1/organization/costs')) {
      const bucket = Math.floor(now / DAY) * 86_400
      return json({
        object: 'page',
        data: [
          {
            object: 'bucket',
            start_time: bucket,
            end_time: bucket + 86_400,
            results: [{ object: 'organization.costs.result', amount: { value: 0.42, currency: 'USD' } }],
          },
        ],
        has_more: false,
      })
    }
    if (url.includes('relay.demo.local/api/user/self')) {
      return json({ success: true, data: { quota: 12_500_000, used_quota: 3_000_000, request_count: 1284 } })
    }
    if (url.includes('relay.demo.local/api/log/self')) {
      return json({
        success: true,
        data: {
          items: [
            { id: 9001, type: 2, created_at: Math.floor(now / 1000) - 3600, model_name: 'gpt-4o-mini', prompt_tokens: 4200, completion_tokens: 880, quota: 50_000 },
            { id: 9002, type: 2, created_at: Math.floor(now / 1000) - 1800, model_name: 'gemini-2.5-pro', prompt_tokens: 12_000, completion_tokens: 2400, quota: 120_000 },
            { id: 9003, type: 2, created_at: Math.floor(now / 1000) - 600, model_name: 'gpt-4o-mini', prompt_tokens: 800, completion_tokens: 120, quota: 9_000 },
          ],
          total: 3,
        },
      })
    }
    return json({ error: { message: `演示模式未模拟该接口：${url}` } }, 404)
  }) as typeof fetch
}

export async function seedDemo(service: TokenPanelApp): Promise<void> {
  const bootstrap = await service.getBootstrap()
  if (bootstrap.accounts.length > 0) return

  const deepseek = await service.saveAccount({
    providerId: 'deepseek',
    label: 'DeepSeek',
    auth: { apiKey: 'sk-demo-deepseek' },
    options: { thresholds: { balanceBelow: 200 } },
  })
  const openrouter = await service.saveAccount({
    providerId: 'openrouter',
    label: 'OpenRouter',
    auth: { managementKey: 'sk-or-v1-demo' },
    options: {},
  })
  await service.saveAccount({
    providerId: 'glm-plan',
    label: 'GLM Coding Plan',
    auth: { apiKey: 'demo-glm-key' },
    options: { thresholds: { remainingBelowPct: 65 } },
  })
  await service.saveAccount({
    providerId: 'openai-usage',
    label: 'OpenAI 团队',
    auth: { adminKey: 'sk-admin-demo' },
    options: {},
  })
  await service.saveAccount({
    providerId: 'newapi',
    label: '团队中转站',
    auth: { accessToken: 'nap_demo' },
    options: { baseUrl: 'https://relay.demo.local', quotaPerUnit: 500000 },
  })
  const gemini = await service.saveAccount({
    providerId: 'gemini',
    label: 'Gemini（手动）',
    options: {
      manualBalance: { amount: 42, currency: 'USD' },
      manualPlan: {
        planLabel: 'AI Studio',
        windows: [{ label: '每日请求', total: 1500, used: 420, unit: '次', resetsAt: Date.now() + 8 * 3_600_000 }],
      },
      thresholds: { balanceBelow: 20, remainingBelowPct: 20 },
    },
  })

  let seed = 20261029
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
  const rows = [
    'account,date,model,input,output,cache_read,cache_write,cost,currency',
  ]
  const accounts = [
    { label: deepseek.label, models: ['deepseek-chat', 'deepseek-reasoner'], skipToday: false },
    { label: openrouter.label, models: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5.1'], skipToday: false },
    { label: 'OpenAI 团队', models: ['gpt-5.1'], skipToday: true },
    { label: '团队中转站', models: ['gpt-4o-mini', 'gemini-2.5-pro'], skipToday: true },
  ]
  for (const account of accounts) {
    for (let offset = 29; offset >= 0; offset--) {
      if (offset === 0 && account.skipToday) continue
      const calls = 1 + Math.floor(rand() * 3)
      for (let call = 0; call < calls; call++) {
        const model = account.models[Math.floor(rand() * account.models.length)]
        const input = 4_000 + Math.floor(rand() * 60_000)
        const output = 500 + Math.floor(rand() * 8_000)
        const cacheRead = Math.floor(input * (0.2 + rand() * 0.4))
        rows.push(`${account.label},${dateOnly(-offset)},${model},${input},${output},${cacheRead},0,,`)
      }
    }
  }
  await service.importUsageCsv(rows.join('\n'))
  await service.addLedger({
    accountId: gemini.id,
    ts: Date.now() - 5 * DAY,
    kind: 'recharge',
    amount: 50,
    currency: 'USD',
    note: '演示充值',
  })
}
