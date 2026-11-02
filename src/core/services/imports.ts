import { createHash } from 'node:crypto'
import type { AccountPublic, LedgerEntry, UsageRecord } from '../types'
import type { Pricing } from '../pricing/pricing'
import { AppError } from '../errors'
import { parseCsv } from '../util/csv'
import { convertCurrency } from '../util/money'
import { toNumber } from '../util/json'

export interface ImportResult<T> {
  added: number
  errors: string[]
  items: T[]
}

export const USAGE_TEMPLATE = `account,date,model,input,output,cache_read,cache_write,cost,currency
DeepSeek,2026-10-28,deepseek-chat,12000,3400,8000,0,0.0123,USD`

export const LEDGER_TEMPLATE = `account,date,kind,amount,currency,note
DeepSeek,2026-10-01,recharge,100,CNY,充值
DeepSeek,2026-10-15,expense,12.5,CNY,手动记账`

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '').replace(/[()（）]/g, '')
}

/**
 * 先按别名精确匹配，再退到"包含"匹配——
 * 厂商账单表头常写成「输入tokens(缓存命中)」这种带括号的长名字。
 * exclude 用来排除容易误认的列（如普通输入列不能命中带「缓存」字样的表头）。
 */
function findIndex(header: string[], aliases: string[], exclude?: RegExp): number {
  const normalized = header.map(normalizeHeader)
  const usable = (value: string) => !exclude || !exclude.test(value)
  for (const alias of aliases) {
    const index = normalized.indexOf(normalizeHeader(alias))
    if (index >= 0 && usable(normalized[index])) return index
  }
  for (const alias of aliases) {
    const needle = normalizeHeader(alias)
    if (!needle) continue
    const index = normalized.findIndex((value) => value.includes(needle) && usable(value))
    if (index >= 0) return index
  }
  return -1
}

function parseWhen(value: string | undefined, fallback: number): number {
  const text = value?.trim()
  if (!text) return fallback
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T00:05:00`).getTime()
    return Number.isFinite(parsed) ? parsed : fallback
  }
  if (/^\d{10}$/.test(text)) return Number(text) * 1000
  if (/^\d{13}$/.test(text)) return Number(text)
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : fallback
}

function resolveAccount(accounts: AccountPublic[], value: string): AccountPublic | undefined {
  const needle = value.trim().toLowerCase()
  return (
    accounts.find((account) => account.id === value.trim()) ??
    accounts.find((account) => account.label.toLowerCase() === needle)
  )
}

export function parseUsageCsv(
  text: string,
  accounts: AccountPublic[],
  pricing: Pricing,
  fxUsdCny: number,
  options?: { defaultAccountId?: string },
): ImportResult<Omit<UsageRecord, 'id'>> {
  const rows = parseCsv(text)
  if (rows.length < 2) throw new AppError('validation', 'CSV 至少需要表头和一行数据')
  const header = rows[0]
  const idx = {
    account: findIndex(header, ['account', '账户', '账号']),
    date: findIndex(header, ['date', 'time', '日期', '时间', '调用时间']),
    model: findIndex(header, ['model', '模型', '模型名称']),
    input: findIndex(
      header,
      ['input', 'input_tokens', 'prompt_tokens', '输入tokens未命中', '输入未命中', '输入', 'prompt'],
      /缓存/,
    ),
    output: findIndex(header, ['output', 'output_tokens', 'completion_tokens', '输出tokens', '输出', 'completion']),
    cacheRead: findIndex(
      header,
      ['cache_read', 'cache_read_tokens', '缓存读取', '缓存命中', '输入tokens缓存命中', 'prompt_cache_hit_tokens'],
      /未命中/,
    ),
    cacheWrite: findIndex(header, ['cache_write', 'cache_creation_input_tokens', '缓存写入']),
    reasoning: findIndex(header, ['reasoning', 'reasoning_tokens', '推理']),
    cost: findIndex(header, ['cost', '费用', '金额', '总消耗', '消耗', 'total_cost', '费用元']),
    currency: findIndex(header, ['currency', '币种']),
  }
  if (idx.model < 0) throw new AppError('validation', '缺少 model 列')
  const defaultAccount = options?.defaultAccountId
    ? accounts.find((account) => account.id === options.defaultAccountId)
    : undefined
  if (idx.account < 0 && !defaultAccount) {
    throw new AppError('validation', '缺少 account 列：请在导入时选择这份账单归属的账户')
  }
  // 表头里带「元 / ¥」的按人民币处理，DeepSeek 账单没有币种列。
  const costHeader = idx.cost >= 0 ? header[idx.cost] : ''
  const costIsCny = /元|¥|rmb|cny/i.test(costHeader)

  const errors: string[] = []
  const items: Omit<UsageRecord, 'id'>[] = []
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    const account =
      idx.account >= 0 ? resolveAccount(accounts, row[idx.account] ?? '') : defaultAccount
    if (!account) {
      errors.push(`第 ${rowIndex + 1} 行：找不到账户 "${row[idx.account] ?? ''}"`)
      continue
    }
    const model = (row[idx.model] ?? '').trim()
    if (!model) {
      errors.push(`第 ${rowIndex + 1} 行：model 为空`)
      continue
    }
    const ts = parseWhen(idx.date >= 0 ? row[idx.date] : undefined, Date.now())
    const input = toNumber(idx.input >= 0 ? row[idx.input] : 0) ?? 0
    const output = toNumber(idx.output >= 0 ? row[idx.output] : 0) ?? 0
    const cacheRead = toNumber(idx.cacheRead >= 0 ? row[idx.cacheRead] : 0) ?? 0
    const cacheWrite = toNumber(idx.cacheWrite >= 0 ? row[idx.cacheWrite] : 0) ?? 0
    const reasoning = toNumber(idx.reasoning >= 0 ? row[idx.reasoning] : 0) ?? 0
    const rawCost = idx.cost >= 0 ? toNumber(row[idx.cost]) : null
    const currencyRaw = (idx.currency >= 0 ? row[idx.currency] : '')?.trim().toUpperCase()
    const currency =
      currencyRaw === 'CNY' || currencyRaw === 'USD' ? currencyRaw : costIsCny ? 'CNY' : 'USD'
    let costUsdMicros: number
    let costEstimated: boolean
    let nativeCost: number | undefined
    let nativeCurrency: string | undefined
    if (rawCost !== null) {
      nativeCost = rawCost
      nativeCurrency = currency
      costUsdMicros = Math.round(convertCurrency(rawCost, currency, 'USD', fxUsdCny) * 1_000_000)
      costEstimated = false
    } else {
      const estimate = pricing.estimateCost({
        model,
        providerId: account.providerId,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      })
      costUsdMicros = estimate.usdMicros
      costEstimated = true
    }
    const externalId = `csv:${createHash('sha1')
      .update(`${account.id}|${ts}|${model}|${input}|${output}|${cacheRead}|${cacheWrite}|${rawCost ?? ''}|${rowIndex}`)
      .digest('hex')
      .slice(0, 20)}`
    items.push({
      accountId: account.id,
      providerId: account.providerId,
      ts,
      model,
      inputTokens: Math.max(0, input),
      outputTokens: Math.max(0, output),
      cacheReadTokens: Math.max(0, cacheRead),
      cacheWriteTokens: Math.max(0, cacheWrite),
      reasoningTokens: Math.max(0, reasoning),
      costUsdMicros,
      costEstimated,
      nativeCost,
      nativeCurrency,
      source: 'csv',
      externalId,
    })
  }
  return { added: items.length, errors: errors.slice(0, 20), items }
}

export function parseLedgerCsv(
  text: string,
  accounts: AccountPublic[],
): ImportResult<Omit<LedgerEntry, 'id'>> {
  const rows = parseCsv(text)
  if (rows.length < 2) throw new AppError('validation', 'CSV 至少需要表头和一行数据')
  const header = rows[0]
  const idx = {
    account: findIndex(header, ['account', '账户']),
    date: findIndex(header, ['date', '日期']),
    kind: findIndex(header, ['kind', 'type', '类型']),
    amount: findIndex(header, ['amount', '金额']),
    currency: findIndex(header, ['currency', '币种']),
    note: findIndex(header, ['note', '备注']),
  }
  if (idx.account < 0) throw new AppError('validation', '缺少 account 列')
  if (idx.amount < 0) throw new AppError('validation', '缺少 amount 列')
  const kindMap: Record<string, LedgerEntry['kind']> = {
    recharge: 'recharge',
    充值: 'recharge',
    expense: 'expense',
    消费: 'expense',
    adjust: 'adjust',
    调整: 'adjust',
  }
  const errors: string[] = []
  const items: Omit<LedgerEntry, 'id'>[] = []
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    const account = resolveAccount(accounts, row[idx.account] ?? '')
    if (!account) {
      errors.push(`第 ${rowIndex + 1} 行：找不到账户 "${row[idx.account] ?? ''}"`)
      continue
    }
    const amount = toNumber(idx.amount >= 0 ? row[idx.amount] : null)
    if (amount === null || amount === 0) {
      errors.push(`第 ${rowIndex + 1} 行：金额无效`)
      continue
    }
    const kindRaw = (idx.kind >= 0 ? row[idx.kind] : 'recharge')?.trim().toLowerCase()
    const kind = kindMap[kindRaw] ?? kindMap[kindRaw?.replace(/\s/g, '')] ?? 'recharge'
    const currencyRaw = (idx.currency >= 0 ? row[idx.currency] : 'CNY')?.trim().toUpperCase()
    const currency = currencyRaw === 'USD' ? 'USD' : 'CNY'
    items.push({
      accountId: account.id,
      ts: parseWhen(idx.date >= 0 ? row[idx.date] : undefined, Date.now()),
      kind,
      amount: kind === 'adjust' ? amount : Math.abs(amount),
      currency,
      note: idx.note >= 0 ? row[idx.note]?.slice(0, 200) : undefined,
    })
  }
  return { added: items.length, errors: errors.slice(0, 20), items }
}
