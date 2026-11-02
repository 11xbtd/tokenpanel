import type { ErrorCode } from '../errors'

export interface RankedModel {
  id: string
  slug: string
  name: string
  creator: string
  creatorId: string
  releasedAt: string | null
  intelligence: number | null
  outputSpeed: number | null
  firstTokenSeconds: number | null
  firstAnswerSeconds: number | null
  inputPrice: number | null
  outputPrice: number | null
  cacheReadPrice: number | null
  costPerTask: number | null
}

export type RankingMetric = 'intelligence' | 'outputSpeed' | 'costPerTask' | 'inputPrice' | 'outputPrice' | 'firstAnswerSeconds'

export interface RankingsOverview {
  configured: boolean
  keySource: 'none' | 'shared' | 'personal'
  sharedKeyAvailable: boolean
  status: 'unconfigured' | 'idle' | 'ok' | 'error'
  models: RankedModel[]
  indexVersion?: number
  tier?: 'free' | 'pro' | 'commercial'
  fetchedAt?: number
  checkedAt?: number
  retryAt?: number
  error?: string
  errorCode?: ErrorCode
  notice?: string
}

export interface RankingsSettingsInput {
  apiKey?: string
  removeKey?: boolean
}
