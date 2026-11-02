import type { Currency } from '../types'

export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd)) return 0
  return Math.round(usd * 1_000_000)
}

export function microsToUsd(micros: number): number {
  return (Number.isFinite(micros) ? micros : 0) / 1_000_000
}

export function convertCurrency(amount: number, from: string, to: Currency, usdCny: number): number {
  if (!Number.isFinite(amount)) return 0
  if (from === to) return amount
  if (from === 'USD' && to === 'CNY') return amount * usdCny
  if (from === 'CNY' && to === 'USD') return amount / usdCny
  return amount
}

const SYMBOLS: Record<string, string> = { CNY: '¥', USD: '$' }

export function formatMoney(amount: number, currency: string, maxFrac?: number): string {
  const value = Number.isFinite(amount) ? amount : 0
  const abs = Math.abs(value)
  const frac = maxFrac ?? (abs >= 100 ? 2 : abs >= 1 ? 2 : 4)
  const body = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: frac,
  }).format(value)
  const symbol = SYMBOLS[currency] ?? `${currency} `
  return `${symbol}${body}`
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  return new Intl.NumberFormat('zh-CN').format(n)
}

export function formatPct(value?: number, digits = 0): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}
