import type { Account, QuotaSnapshot, UsageRecord } from '../types'
import type { Pricing } from '../pricing/pricing'
import { AppError } from '../errors'

export interface AdapterContext {
  account: Account
  fetch: typeof fetch
  now: number
  timeoutMs: number
  quotaPerUnit: number
  pricing: Pricing
  signal?: AbortSignal
}

export type SnapshotDraft = Omit<QuotaSnapshot, 'id' | 'accountId' | 'providerId' | 'at' | 'latencyMs'>

export type RawUsage = Omit<
  UsageRecord,
  'id' | 'accountId' | 'providerId' | 'costUsdMicros' | 'costEstimated'
> & {
  costUsdMicros?: number
  costEstimated?: boolean
}

export interface ProviderAdapter {
  balance?: (ctx: AdapterContext) => Promise<SnapshotDraft>
  plan?: (ctx: AdapterContext) => Promise<SnapshotDraft>
  usage?: (ctx: AdapterContext, since: number) => Promise<RawUsage[]>
  custom?: (ctx: AdapterContext) => Promise<SnapshotDraft>
}

export function requireAuth(ctx: AdapterContext, key: string, label: string): string {
  const value = ctx.account.auth[key]?.trim()
  if (!value) throw new AppError('auth', `缺少 ${label}`)
  return value
}

export function baseUrlOf(ctx: AdapterContext, fallback: string): string {
  const value = ctx.account.options.baseUrl?.trim() || fallback
  return value.replace(/\/+$/, '')
}
