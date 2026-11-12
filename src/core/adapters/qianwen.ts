import { AppError } from '../errors'
import type { QuotaWindow } from '../types'
import { toNumber } from '../util/json'
import type { AdapterContext, SnapshotDraft } from './types'

/**
 * 千问 Token Plan 个人版：控制台登录态（Cookie）读取额度。
 * 接口为 ONE_CONSOLE 网关：cs-data.qianwenai.com/data/api.json（POST 表单 + params JSON + sec_token）。
 * sec_token 从控制台页面 HTML 动态提取；sk-sp- / AK/SK 均不开放个人版额度。
 */
const PAGE = 'https://platform.qianwenai.com/home/analytics/token-plan/individual'
const GATEWAY = 'https://cs-data.qianwenai.com/data/api.json'
const CORNERSTONE = { domain: 'platform.qianwenai.com', consoleSite: 'QIANWENAI', console: 'ONE_CONSOLE', xsp_lang: 'zh-CN', protocol: 'V2', productCode: 'p_efm' }

async function secToken(ctx: AdapterContext, cookie: string): Promise<string> {
  const response = await ctx.fetch(PAGE, { headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0' }, signal: ctx.signal })
  if (!response.ok) throw new AppError('auth', '控制台登录态失效，请重新登录并更新 Cookie', 401)
  const html = await response.text()
  const match = html.match(/SEC_TOKEN["']?\s*[:=]\s*["']([^"']+)["']/i)
  if (!match) throw new AppError('auth', '未能从控制台页面提取 sec_token，请确认 Cookie 有效', 401)
  return match[1]
}

async function consoleCall(ctx: AdapterContext, cookie: string, sec: string, api: string, extraData: Record<string, unknown> = {}): Promise<any> {
  const fullApi = `zeldaHttp.apikeyMgr.${api}`
  const params = { Api: fullApi, Data: { ...extraData, cornerstoneParam: CORNERSTONE }, V: '1.0' }
  const body = new URLSearchParams({ product: 'sfm_bailian', action: 'BroadScopeAspnGateway', sec_token: sec, region: 'cn-beijing', params: JSON.stringify(params) })
  const response = await ctx.fetch(`${GATEWAY}?product=sfm_bailian&action=BroadScopeAspnGateway&api=${encodeURIComponent(fullApi)}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', origin: 'https://platform.qianwenai.com' },
    body: body.toString(),
    signal: ctx.signal,
  })
  if (response.status === 401 || response.status === 403) throw new AppError('auth', '控制台登录态失效，请更新 Cookie', 401)
  if (!response.ok) throw new AppError('upstream', `个人版额度接口返回 ${response.status}`)
  const outer = (await response.json()) as any
  const inner = outer?.data?.DataV2?.data
  if (!inner || inner.success === false || (inner.code && inner.code !== 'SUCCESS')) {
    throw new AppError('upstream', `个人版额度接口返回异常：${JSON.stringify(outer).slice(0, 160)}`)
  }
  return inner.data
}

const pct = (v: unknown): number | null => {
  const n = toNumber(v)
  if (n === null) return null
  return n <= 1 ? n * 100 : n
}

export async function qianwenPlan(ctx: AdapterContext): Promise<SnapshotDraft> {
  const raw = ctx.account.auth.cookie?.trim()
  if (!raw) throw new AppError('auth', '请填写控制台 Cookie（只需 login_qianwenai_ticket=… 这一段）')
  // 只保留必需的会话票据，避免把整串无关 Cookie 存进配置。
  const ticket = raw.match(/login_qianwenai_ticket=[^;]+/)
  const cookie = ticket ? ticket[0] : raw

  const sec = await secToken(ctx, cookie)
  const [usage, subscription, quotaConfig] = await Promise.all([
    consoleCall(ctx, cookie, sec, '/tokenplan/personal/api/v2/usage'),
    consoleCall(ctx, cookie, sec, '/tokenplan/personal/api/v2/subscription', { commodityCode: 'sfm_tokenplansolo_public_cn' }).catch(() => null),
    consoleCall(ctx, cookie, sec, '/tokenplan/personal/api/v2/quota-config').catch(() => null),
  ])

  const tier = typeof subscription?.specCode === 'string' ? subscription.specCode : 'lite'
  const tierCfg = quotaConfig?.[tier] ?? {}
  const windows: QuotaWindow[] = []

  const push = (key: string, label: string, percentage: unknown, reset: unknown, total: unknown) => {
    const usedPct = pct(percentage)
    if (usedPct === null) return
    const totalNum = toNumber(total)
    const clamped = Math.min(100, Math.max(0, usedPct))
    windows.push({
      key,
      label,
      used: totalNum !== null ? (clamped / 100) * totalNum : undefined,
      total: totalNum ?? undefined,
      unit: 'Credits',
      usedPct: clamped,
      remainingPct: 100 - clamped,
      resetsAt: toNumber(reset) ?? undefined,
    })
  }

  push('5h', '5 小时', usage?.per5HourPercentage, usage?.per5HourResetTime, tierCfg.five_hour)
  push('week', '每周', usage?.per7DayPercentage, usage?.per7DayResetTime, tierCfg.weekly)
  push('month', '每月', usage?.per1MonthPercentage, usage?.per1MonthResetTime, tierCfg.monthly)

  if (windows.length === 0) throw new AppError('upstream', `未识别个人版额度字段：${JSON.stringify(usage).slice(0, 160)}`)

  const endTime = toNumber(subscription?.endTime)
  return {
    status: 'ok',
    kind: 'plan',
    source: 'unofficial',
    windows,
    planLabel: `千问 Token Plan · ${tier}`,
    extras: {
      interface: 'console-personal',
      ...(endTime !== null ? { subscriptionEndTime: endTime } : {}),
      ...(toNumber(subscription?.remainingDays) !== null ? { remainingDays: toNumber(subscription.remainingDays)! } : {}),
    },
  }
}
