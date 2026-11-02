import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LogScanResult, LogScanSourceResult, Settings, UsageRecord } from '../types'
import type { Store } from '../storage/store'
import type { Pricing } from '../pricing/pricing'
import { readJson, writeJsonAtomic } from '../storage/files'
import { redact } from '../util/redact'
import { logBillingModeForAccount, resolveAccountForRecord } from './attribution'
import type { LogSourceAdapter } from './types'
import { MAX_LOG_FILE_BYTES } from './util'

const CACHE_VERSION = 1
const CACHE_FILE = 'log-file-cache.json'

interface FileCacheEntry {
  size: number
  mtimeMs: number
  parserVersion?: number
}

export interface LogFileCache {
  version: number
  files: Record<string, Record<string, FileCacheEntry>>
  lastScanAt: Record<string, number>
  /** 上次扫描各来源"匹配不上归属、未入库"的条数。 */
  lastUnattributed: Record<string, number>
}

export async function readLogCache(dataDir: string): Promise<LogFileCache> {
  const cache = await readJson<LogFileCache>(path.join(dataDir, CACHE_FILE), {
    version: CACHE_VERSION,
    files: {},
    lastScanAt: {},
    lastUnattributed: {},
  })
  if (cache.version !== CACHE_VERSION) {
    return { version: CACHE_VERSION, files: {}, lastScanAt: {}, lastUnattributed: {} }
  }
  if (!cache.files) cache.files = {}
  if (!cache.lastScanAt) cache.lastScanAt = {}
  if (!cache.lastUnattributed) cache.lastUnattributed = {}
  return cache
}

export async function resetLogSourceCache(dataDir: string, sourceId: string): Promise<void> {
  const cache = await readLogCache(dataDir)
  delete cache.files[sourceId]
  delete cache.lastScanAt[sourceId]
  await writeJsonAtomic(path.join(dataDir, CACHE_FILE), cache)
}

export async function scanLocalLogs(input: {
  store: Store
  pricing: Pricing
  settings: Settings
  adapters: LogSourceAdapter[]
  now?: number
}): Promise<LogScanResult> {
  const now = input.now ?? Date.now()
  const accounts = input.store.listAccounts()
  const cache = await readLogCache(input.store.dataDir)
  const results: LogScanSourceResult[] = []

  for (const adapter of input.adapters) {
    const setting = input.settings.logSources.find((item) => item.id === adapter.id)
    if (!setting?.enabled) continue
    const detect = await adapter.detect()
    const result: LogScanSourceResult = {
      id: adapter.id,
      name: adapter.name,
      available: detect.available,
      imported: 0,
      skipped: 0,
      unattributed: 0,
      files: 0,
      errors: [],
    }
    if (!detect.available) {
      results.push(result)
      continue
    }
    const sourceCache = cache.files[adapter.id] ?? {}
    let files
    try {
      files = await adapter.listFiles()
    } catch (error) {
      result.errors.push(redact(error, 160))
      results.push(result)
      continue
    }
    result.files = files.length
    const records: UsageRecord[] = []

    for (const file of files) {
      if (file.size > MAX_LOG_FILE_BYTES) {
        result.errors.push(`${path.basename(file.path)} 超过 80MB，已跳过`)
        continue
      }
      const previous = sourceCache[file.path]
      if (previous && previous.size === file.size && previous.mtimeMs === file.mtimeMs && (previous.parserVersion ?? 1) === (adapter.version ?? 1)) {
        result.skipped++
        continue
      }
      let parsed
      try {
        parsed = await adapter.parseFile(file)
      } catch (error) {
        result.errors.push(`${path.basename(file.path)}: ${redact(error, 120)}`)
        continue
      }
      let unattributedHere = 0
      for (const record of parsed) {
        const hint = typeof record.meta?.provider === 'string' ? record.meta.provider : undefined
        const resolved = resolveAccountForRecord(record.model, setting, accounts, hint)
        const account = resolved.account
        // 匹配不上归属就不落库：宁可不统计，也别把别家的调用算进某个套餐。
        if (!account) {
          unattributedHere++
          continue
        }
        const mode = logBillingModeForAccount(account)
        const estimate =
          mode === 'api'
            ? input.pricing.estimateCost({
                model: record.model,
                providerId: account.providerId,
                inputTokens: record.inputTokens,
                outputTokens: record.outputTokens + record.reasoningTokens,
                cacheReadTokens: record.cacheReadTokens,
                cacheWriteTokens: record.cacheWriteTokens,
              })
            : undefined
        records.push({
          id: randomUUID(),
          accountId: account.id,
          providerId: account.providerId,
          ts: record.ts,
          model: record.model,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheReadTokens: record.cacheReadTokens,
          cacheWriteTokens: record.cacheWriteTokens,
          reasoningTokens: record.reasoningTokens,
          costUsdMicros: mode === 'plan' ? 0 : estimate?.usdMicros ?? 0,
          costEstimated: mode === 'plan' ? false : true,
          source: 'local-log',
          externalId: record.externalId,
          billingMode: mode,
          clientId: adapter.id,
          ttftMs: record.ttftMs,
          durationMs: record.durationMs,
          tokensPerSecond: record.tokensPerSecond,
          meta: {
            client: adapter.id,
            source: resolved.via,
            ...(mode === 'plan' ? { subscription: 1 } : {}),
            ...(estimate?.missingPrice ? { priceMissing: 1 } : {}),
            ...(record.meta ?? {}),
          },
        })
      }
      result.unattributed += unattributedHere
      sourceCache[file.path] = { size: file.size, mtimeMs: file.mtimeMs, parserVersion: adapter.version ?? 1 }
    }

    if (records.length > 0) {
      try {
        const updated = await input.store.enrichUsageTiming(records)
        if (updated > 0) result.updated = updated
        result.imported = await input.store.appendUsage(records)
      } catch (error) {
        result.errors.push(`写入失败：${redact(error, 120)}`)
      }
    }
    // 该来源历史上"没归属"的记录一起清掉：新规则下它们不该继续算进总量。
    try {
      await input.store.removeUnattributedByClient(adapter.id)
    } catch (error) {
      result.errors.push(`清理历史未归属记录失败：${redact(error, 120)}`)
    }
    cache.files[adapter.id] = sourceCache
    cache.lastScanAt[adapter.id] = now
    cache.lastUnattributed[adapter.id] = result.unattributed
    result.errors = result.errors.slice(0, 5)
    results.push(result)
  }

  await writeJsonAtomic(path.join(input.store.dataDir, CACHE_FILE), cache)
  const updated = results.reduce((total, item) => total + (item.updated ?? 0), 0)
  return {
    at: now,
    sources: results,
    imported: results.reduce((total, item) => total + item.imported, 0),
    ...(updated > 0 ? { updated } : {}),
    unattributed: results.reduce((total, item) => total + item.unattributed, 0),
  }
}
