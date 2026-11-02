import type { Currency } from '../types'

export interface PriceOverride {
  inputPerM: number
  outputPerM: number
  cacheReadPerM?: number
  cacheWritePerM?: number
  currency: Currency
}

export interface PriceOverridesFile {
  updatedAt: number
  models: Record<string, PriceOverride>
}

export interface PriceTier {
  aboveTokens: number
  inputPerM?: number
  outputPerM?: number
  cacheReadPerM?: number
  cacheWritePerM?: number
}

export interface ModelPrice {
  model: string
  provider?: string
  inputPerM: number
  outputPerM: number
  cacheReadPerM?: number
  cacheWritePerM?: number
  maxInputTokens?: number
  mode?: string
  tiers?: PriceTier[]
}

export interface SnapshotFile {
  generatedAt: number
  source: string
  models: Record<string, ModelPrice>
}
