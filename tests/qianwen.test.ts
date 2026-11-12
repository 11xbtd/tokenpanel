import { describe, expect, it } from 'vitest'
import { qianwenPlan } from '../src/core/adapters/qianwen'
import { Pricing } from '../src/core/pricing/pricing'
import type { AdapterContext } from '../src/core/adapters/types'

const NOW = Date.UTC(2026, 10, 12, 1, 0, 0)
const envelope = (data: unknown) => ({ data: { DataV2: { data: { success: true, code: 'SUCCESS', data } } } })

function ctx(fetchImpl: typeof fetch): AdapterContext {
  return {
    account: { id: 'a', providerId: 'qianwen-plan', label: 'T', enabled: true, createdAt: 0, auth: { cookie: 'login_qianwenai_ticket=x' }, options: {} },
    fetch: fetchImpl,
    now: NOW,
    timeoutMs: 2000,
    quotaPerUnit: 500000,
    pricing: new Pricing({ updatedAt: 0, models: {} }, 7.2),
  }
}

const mockFetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('platform.qianwenai.com/home')) {
    return new Response('<script>SEC_TOKEN: "tok123"</script>', { status: 200 })
  }
  const api = decodeURIComponent(new URL(url).searchParams.get('api') ?? '')
  if (api.endsWith('/usage')) return new Response(JSON.stringify(envelope({ per1MonthPercentage: 0.16, per1MonthResetTime: NOW + 20 * 86400_000 })), { status: 200 })
  if (api.endsWith('/subscription')) return new Response(JSON.stringify(envelope({ specCode: 'lite', endTime: NOW + 10 * 86400_000, remainingDays: 10, status: 'VALID' })), { status: 200 })
  if (api.endsWith('/quota-config')) return new Response(JSON.stringify(envelope({ lite: { five_hour: 700, monthly: 20000 } })), { status: 200 })
  return new Response('{}', { status: 404 })
}) as typeof fetch

describe('千问 Token Plan 个人版（控制台 Cookie）', () => {
  it('无 Cookie 时提示填写', async () => {
    const noCookie = { ...ctx(mockFetch), account: { ...ctx(mockFetch).account, auth: {} } }
    await expect(qianwenPlan(noCookie)).rejects.toThrow('Cookie')
  })

  it('月度窗口按档位总额换算，并带出订阅到期日', async () => {
    const result = await qianwenPlan(ctx(mockFetch))
    expect(result.planLabel).toContain('lite')
    const month = result.windows?.find((w) => w.key === 'month')
    expect(month).toMatchObject({ total: 20000, used: 3200, unit: 'Credits' })
    expect(month?.usedPct).toBeCloseTo(16)
    expect(result.extras?.subscriptionEndTime).toBe(NOW + 10 * 86400_000)
    expect(result.extras?.remainingDays).toBe(10)
  })
})
