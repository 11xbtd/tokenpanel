import type { AccountOptions, QuotaSnapshot, Settings } from '../types'
import { DEFAULT_QUOTA_COLORS } from '../util/quota'

export const SCHEMA_VERSION = 1
export const VERSION = '1.1.1'

export interface StoredAccount {
  id: string
  providerId: string
  label: string
  enabled: boolean
  createdAt: number
  authEnc: string
  options: AccountOptions
}

export interface StoredConfig {
  schemaVersion: number
  updatedAt: number
  accounts: StoredAccount[]
  settings: Settings
}

export interface StoredState {
  sync: Record<string, import('../types').SyncState>
  lastRefresh?: { at: number; status: 'ok' | 'error'; message?: string }
}

export interface RefreshLogEntry {
  at: number
  accountId: string
  label: string
  status: 'ok' | 'error'
  kind?: string
  message?: string
}

export interface LatestMap {
  [accountId: string]: Partial<Record<'balance' | 'plan' | 'usage' | 'relay' | 'manual', QuotaSnapshot>>
}

export const DEFAULT_SETTINGS: Settings = {
  displayCurrency: 'CNY',
  fxUsdCny: 7.2,
  fxAuto: true,
  refreshTtlMin: 10,
  theme: 'system',
  quotaColors: { ...DEFAULT_QUOTA_COLORS },
  alerts: {
    enabled: true,
    remainingBelowPct: 15,
    cooldownHours: 6,
  },
  webhooks: [],
  logSources: [],
}

export function defaultConfig(): StoredConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now(),
    accounts: [],
    settings: structuredClone(DEFAULT_SETTINGS),
  }
}

export function defaultState(): StoredState {
  return { sync: {} }
}
