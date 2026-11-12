import { randomUUID } from 'node:crypto'
import type {
  AccountInput,
  AccountPublic,
  AlertEvent,
  Bootstrap,
  Capability,
  CsvImportSummary,
  Diagnostics,
  ExportBundle,
  LedgerEntry,
  LogScanResult,
  LogSourceStatus,
  LogSourceSetting,
  Overview,
  ProviderPreset,
  QuotaSnapshot,
  RecordsPage,
  RecordsQuery,
  RefreshAccountResult,
  RefreshAllResult,
  Settings,
  UsageRecord,
  WebhookConfig,
  WebhookTestResult,
} from '../types'
import { Store } from '../storage/store'
import { Pricing } from '../pricing/pricing'
import type { PriceOverridesFile } from '../pricing/types'
import { createLogAdapters } from '../logs/registry'
import { detectUnadaptedSources } from '../logs/generic'
import { defaultBindingsFor, logBillingModeForAccount, reboundSources } from '../logs/attribution'
import { readLogCache, resetLogSourceCache, scanLocalLogs } from '../logs/scanner'
import type { LogSourceAdapter } from '../logs/types'
import { fetchUsdCny } from '../pricing/fx'
import { PROVIDERS, getProvider } from '../providers/registry'
import { getAdapter } from '../adapters'
import type { AdapterContext, RawUsage, SnapshotDraft } from '../adapters/types'
import { AppError, NotFoundError, errorCodeOf } from '../errors'
import { buildOverview } from './analytics'
import { evaluateAlerts } from './alerts'
import { manualBalanceOf, manualWindowsOf } from './manual'
import { LEDGER_TEMPLATE, USAGE_TEMPLATE, parseLedgerCsv, parseUsageCsv } from './imports'
import { DAY_MS, startOfDay, startOfMonth } from '../util/time'
import { redact } from '../util/redact'
import { toCsv } from '../util/csv'
import { NewsService } from '../news/service'
import { suggestedNewsTopics } from '../news/catalog'
import type { NewsPreferencesInput, NewsStream } from '../news/types'
import type { NewsArticleFetch, NewsFetch } from '../news/transport'
import { RankingsService, type RankingsFetch } from '../rankings/service'
import { defaultRankingsApiKey } from '../rankings/config'
import type { RankingsSettingsInput } from '../rankings/types'

export interface AppOptions {
  dataDir: string
  mode: 'utools' | 'browser'
  version: string
  fetchImpl?: typeof fetch
  notify?: (title: string) => void
  enableLocalLogs?: boolean
  startupTrace?: (stage: string, detail?: unknown) => void
  newsFetchImpl?: NewsFetch
  newsArticleFetchImpl?: NewsArticleFetch
  rankingsFetchImpl?: RankingsFetch
  rankingsSharedApiKey?: string
}

const PROVIDER_MAP = new Map(PROVIDERS.map((provider) => [provider.id, provider]))
const KIND_LABEL: Record<string, string> = { balance: '余额', plan: '套餐', usage: '用量', relay: '中转站', manual: '手动' }

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

export class TokenPanelApp {
  private news?: NewsService
  private rankings?: RankingsService
  private refreshing?: Promise<RefreshAllResult>
  /** dedupeKey → 上次推送给 Webhook 的时间，只在本次进程内有效（告警不落库）。 */
  private readonly pushedAlerts = new Map<string, number>()
  private fetchImpl: typeof fetch
  private logAdapters: LogSourceAdapter[] = createLogAdapters()

  private constructor(
    private readonly store: Store,
    private settings: Settings,
    private readonly pricing: Pricing,
    private readonly options: AppOptions,
  ) {
    // 包一层箭头函数，避免把 window.fetch 脱离 window 存起来后在 uTools 里调用报 Illegal invocation。
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  static async create(options: AppOptions): Promise<TokenPanelApp> {
    const store = await Store.open(options.dataDir)
    const settings = store.getSettings()
    const pricing = new Pricing(store.getPricesOverrides(), settings.fxUsdCny)
    const app = new TokenPanelApp(store, settings, pricing, options)
    if (settings.fxAuto && Date.now() - (settings.fxUpdatedAt ?? 0) > 12 * 3_600_000) {
      void app.refreshFx(false).catch(() => undefined)
    }
    return app
  }

  async getBootstrap(): Promise<Bootstrap> {
    return {
      version: this.options.version,
      mode: this.options.mode,
      dataDir: this.store.dataDir,
      providers: PROVIDERS,
      accounts: this.store.listAccounts(),
      settings: this.settings,
      sync: this.store.getSync(),
      alerts: await this.currentAlerts(),
      pricing: {
        modelCount: this.pricing.modelCount,
        updatedAt: this.pricing.updatedAt,
        source: this.pricing.source,
      },
      fx: {
        usdCny: this.settings.fxUsdCny,
        updatedAt: this.settings.fxUpdatedAt,
        source: this.settings.fxAuto ? 'auto' : 'manual',
      },
      templates: { usage: USAGE_TEMPLATE, ledger: LEDGER_TEMPLATE },
      lastRefresh: this.store.getLastRefresh(),
      logSources: await this.getLogSourcesStatus(),
    }
  }

  getSettings(): Settings {
    return this.settings
  }

  private getNewsService(): NewsService {
    return this.news ??= new NewsService(this.store.dataDir, this.options.newsFetchImpl, Date.now, this.options.newsArticleFetchImpl)
  }

  getNews(force = false, stream: NewsStream = 'official', cachedOnly = false) {
    return this.getNewsService().get(suggestedNewsTopics(this.store.listAccounts(), this.settings.logSources), force, stream, cachedOnly)
  }

  getNewsArticle(url: string) {
    return this.getNewsService().article(url)
  }

  updateNewsPreferences(input: NewsPreferencesInput) {
    return this.getNewsService().update(input, suggestedNewsTopics(this.store.listAccounts(), this.settings.logSources))
  }

  private getRankingsService(): RankingsService {
    return this.rankings ??= new RankingsService(this.store.dataDir, this.options.rankingsFetchImpl, Date.now, this.options.rankingsSharedApiKey ?? defaultRankingsApiKey())
  }

  getRankings(force = false, cachedOnly = false) {
    return this.getRankingsService().get(force, cachedOnly)
  }

  configureRankings(input: RankingsSettingsInput) {
    return this.getRankingsService().configure(input)
  }

  async saveAccount(input: AccountInput): Promise<AccountPublic> {
    return this.store.saveAccount(input)
  }

  async deleteAccount(id: string, purge: boolean): Promise<void> {
    await this.store.deleteAccount(id, purge)
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const previous = this.settings
    this.settings = await this.store.updateSettings(patch)
    this.pricing.setFx(this.settings.fxUsdCny)
    if (patch.logSources) {
      await this.purgeReboundSources(reboundSources(previous.logSources, this.settings.logSources))
    }
    if (patch.fxAuto === true) void this.refreshFx(true).catch(() => undefined)
    return this.settings
  }

  /** 归属变化后，该来源的历史记录整体重扫，避免同一调用被计两次。 */
  private async purgeReboundSources(sources: LogSourceSetting[]): Promise<void> {
    const ids: string[] = []
    for (const source of sources) {
      await this.store.removeUsageByClient(source.id)
      await resetLogSourceCache(this.store.dataDir, source.id)
      ids.push(source.id)
    }
    this.resetAdapterState(ids)
  }

  /** 清掉适配器内部缓存（如 DSH 的增量解析位置），确保重建时从文件头完整重读。 */
  private resetAdapterState(ids: Iterable<string>): void {
    const wanted = new Set(ids)
    for (const adapter of this.logAdapters) {
      if (wanted.has(adapter.id)) adapter.reset?.()
    }
  }

  async refreshFx(force: boolean): Promise<{ rate: number; updatedAt?: number; source: 'auto' | 'manual' }> {
    const stale = Date.now() - (this.settings.fxUpdatedAt ?? 0) > 12 * 3_600_000
    if (!this.settings.fxAuto && !force) return this.fxInfo()
    if (!force && !stale) return this.fxInfo()
    const rate = await fetchUsdCny(this.fetchImpl)
    if (rate) {
      this.settings = await this.store.updateSettings({ fxUsdCny: rate, fxUpdatedAt: Date.now() })
      this.pricing.setFx(rate)
    }
    return this.fxInfo()
  }

  private fxInfo(): { rate: number; updatedAt?: number; source: 'auto' | 'manual' } {
    return {
      rate: this.settings.fxUsdCny,
      updatedAt: this.settings.fxUpdatedAt,
      source: this.settings.fxAuto ? 'auto' : 'manual',
    }
  }

  async refreshAll(force = false): Promise<RefreshAllResult> {
    if (this.refreshing) return this.refreshing
    const accounts = this.store.listAccounts().filter((account) => account.enabled)
    const last = this.store.getLastRefresh()
    const sync = this.store.getSync()
    const ttl = this.settings.refreshTtlMin * 60_000
    const fresh =
      !force &&
      Boolean(last) &&
      Date.now() - (last?.at ?? 0) < ttl &&
      accounts.every((account) => (sync[account.id]?.at ?? 0) >= (last?.at ?? 0))
    if (fresh) {
      const logImport = await this.scanLogs().catch(() => undefined)
      return {
        at: last!.at,
        results: [],
        alerts: await this.currentAlerts(),
        skipped: true,
        logImport,
      }
    }
    this.refreshing = this.runRefresh(accounts).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async runRefresh(accounts: AccountPublic[]): Promise<RefreshAllResult> {
    const at = Date.now()
    const results = await mapLimit(accounts, 4, (account) => this.refreshOne(account))
    const logImport = await this.scanLogs().catch(() => undefined)
    const firstError = results.find((result) => result.status === 'error')
    await this.store.setLastRefresh({
      at,
      status: firstError ? 'error' : 'ok',
      message: firstError?.message,
    })
    let alerts: AlertEvent[] = []
    try {
      alerts = await this.currentAlerts()
      await this.notifyAlerts(alerts)
    } catch {
      alerts = []
    }
    return { at, results, alerts, logImport }
  }

  async refreshAccount(id: string): Promise<RefreshAccountResult> {
    const account = this.store.listAccounts().find((item) => item.id === id)
    if (!account) throw new NotFoundError('账户不存在')
    const result = await this.refreshOne(account)
    await this.scanLogs().catch(() => undefined)
    try {
      await this.notifyAlerts(await this.currentAlerts())
    } catch {
      // 告警失败不影响刷新结果
    }
    return result
  }

  async scanLogs(): Promise<LogScanResult> {
    if (this.options.enableLocalLogs === false) {
      return { at: Date.now(), sources: [], imported: 0, unattributed: 0 }
    }
    await this.ensureLogSources()
    return scanLocalLogs({
      store: this.store,
      pricing: this.pricing,
      settings: this.settings,
      adapters: this.logAdapters,
    })
  }

  /**
   * 重建本机日志统计：清掉各来源已导入的记录与文件缓存后重扫。
   * 归属规则或绑定改过之后用，让历史记录按新规则重新归属。
   */
  async rebuildLogStats(): Promise<LogScanResult & { rebuilt: number }> {
    const enabled = this.settings.logSources.filter((source) => source.enabled).map((source) => source.id)
    let rebuilt = 0
    for (const id of enabled) {
      rebuilt += await this.store.removeUsageByClient(id)
      await resetLogSourceCache(this.store.dataDir, id)
    }
    this.resetAdapterState(enabled)
    const result = await this.scanLogs()
    return { ...result, rebuilt }
  }

  private async ensureLogSources(): Promise<void> {
    if (this.options.enableLocalLogs === false) return
    const accounts = this.store.listAccounts()
    const detected = await Promise.all(this.logAdapters.map((adapter) => this.detectLogSource(adapter)))
    const previous = this.settings.logSources
    const next: LogSourceSetting[] = previous.map((source) => ({ ...source, bindings: [...source.bindings] }))
    let changed = false
    this.logAdapters.forEach((adapter, index) => {
      if (!detected[index].available) return
      const existing = next.find((source) => source.id === adapter.id)
      if (!existing) {
        next.push({
          id: adapter.id,
          // 首次发现只登记，不自动读取；用户在设置里开启后才增量扫描。
          enabled: false,
          bindings: defaultBindingsFor(adapter.id, accounts),
        })
        changed = true
        return
      }
      if (existing.bindings.length === 0) {
        const suggested = defaultBindingsFor(adapter.id, accounts)
        if (suggested.length > 0) {
          existing.bindings = suggested
          changed = true
        }
      }
    })
    if (changed) {
      this.settings = await this.store.updateSettings({ logSources: next })
      await this.purgeReboundSources(reboundSources(previous, this.settings.logSources))
    }
  }

  private async detectLogSource(adapter: LogSourceAdapter) {
    this.options.startupTrace?.(`logs:${adapter.id}:detect:start`)
    try {
      const result = await adapter.detect()
      this.options.startupTrace?.(`logs:${adapter.id}:detect:ready`)
      return result
    } catch (error) {
      this.options.startupTrace?.(`logs:${adapter.id}:detect:error`, error)
      throw error
    }
  }

  async getLogSourcesStatus(): Promise<LogSourceStatus[]> {
    if (this.options.enableLocalLogs === false) return []
    await this.ensureLogSources()
    const cache = await readLogCache(this.store.dataDir)
    const accounts = this.store.listAccounts()
    const supported: LogSourceStatus[] = []
    for (const adapter of this.logAdapters) {
      const setting = this.settings.logSources.find((item) => item.id === adapter.id)
      const detect = await this.detectLogSource(adapter)
      const stats = this.store.sourceStats(adapter.id)
      supported.push({
        id: adapter.id,
        name: adapter.name,
        description: adapter.description,
        paths: detect.paths,
        available: detect.available,
        supported: true,
        enabled: setting?.enabled ?? false,
        bindings: setting?.bindings ?? defaultBindingsFor(adapter.id, accounts),
        capabilities: { ...adapter.capabilities },
        parserVersion: adapter.version ?? 1,
        imported: stats.records,
        importedTokens: stats.tokens,
        unattributed: cache.lastUnattributed[adapter.id] ?? 0,
        lastScanAt: cache.lastScanAt[adapter.id],
        note: detect.note,
      })
    }
    const unadapted = await detectUnadaptedSources()
    const extra: LogSourceStatus[] = unadapted.map((source) => ({
      id: source.id,
      name: source.name,
      description: source.note,
      paths: source.paths,
      available: true,
      supported: false,
      enabled: false,
      bindings: [],
      capabilities: { tokens: false, cache: false, speed: false, ttft: false },
      imported: 0,
      importedTokens: 0,
      unattributed: 0,
      note: source.note,
    }))
    return [...supported.sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name)), ...extra]
  }

  private async refreshOne(publicAccount: AccountPublic): Promise<RefreshAccountResult> {
    const started = Date.now()
    const preset = getProvider(publicAccount.providerId)
    const adapter = getAdapter(publicAccount.providerId)
    const drafts: SnapshotDraft[] = []
    const errors: Array<{ kind: Capability; code: string; message: string }> = []
    let usageAdded = 0
    let lastUsageSyncAt: number | undefined
    const now = Date.now()
    const previousSync = this.store.getSync()[publicAccount.id]

    try {
      const account = this.store.getAccount(publicAccount.id)
      if (this.store.hasDecryptError(publicAccount.id)) {
        errors.push({ kind: 'balance', code: 'auth', message: '密钥无法解密，请在账户页重新填写密钥' })
      } else {
        const ctx: AdapterContext = {
          account,
          fetch: this.fetchImpl,
          now,
          timeoutMs: 12_000,
          quotaPerUnit: account.options.quotaPerUnit ?? preset?.quotaPerUnit ?? 500_000,
          pricing: this.pricing,
        }
        const capabilities = new Set(preset?.capabilities ?? [])

        if (preset?.category === 'manual') {
          const ledger = this.store.listLedger(account.id)
          const balance = manualBalanceOf(account, ledger)
          if (balance) {
            drafts.push({
              status: 'ok',
              kind: 'balance',
              source: 'manual',
              currency: balance.currency,
              balance: balance.amount,
              extras: { interface: '手动录入' },
            })
          }
          const windows = manualWindowsOf(account)
          if (windows.length) {
            drafts.push({
              status: 'ok',
              kind: 'plan',
              source: 'manual',
              windows,
              planLabel: account.options.manualPlan?.planLabel,
              extras: { interface: '手动录入' },
            })
          }
        } else if (preset?.category === 'custom') {
          if (!adapter?.custom) {
            errors.push({ kind: 'balance', code: 'unsupported', message: '该自定义数据源未实现' })
          } else {
            try {
              drafts.push(await adapter.custom(ctx))
            } catch (error) {
              errors.push({ kind: 'balance', ...this.errorMeta(error) })
            }
          }
        } else {
          if ((capabilities.has('balance') || capabilities.has('relay')) && adapter?.balance) {
            try {
              drafts.push(await adapter.balance(ctx))
            } catch (error) {
              errors.push({ kind: capabilities.has('relay') ? 'relay' : 'balance', ...this.errorMeta(error) })
            }
          }
          if (capabilities.has('plan')) {
            if (!adapter?.plan) {
              errors.push({ kind: 'plan', code: 'unsupported', message: '该套餐接口未实现' })
            } else {
              try {
                drafts.push(await adapter.plan(ctx))
              } catch (error) {
                errors.push({ kind: 'plan', ...this.errorMeta(error) })
              }
            }
          }
          if (capabilities.has('usage') || capabilities.has('relay')) {
            if (!adapter?.usage) {
              errors.push({ kind: 'usage', code: 'unsupported', message: '该用量接口未实现' })
            } else {
              const since = Math.max(now - 30 * DAY_MS, (previousSync?.lastUsageSyncAt ?? now - 14 * DAY_MS) - 2 * DAY_MS)
              try {
                const raw = await adapter.usage(ctx, since)
                const records = raw.map((item) => this.toRecord(item, account))
                usageAdded = await this.store.appendUsage(records)
                lastUsageSyncAt = now
              } catch (error) {
                errors.push({ kind: 'usage', ...this.errorMeta(error) })
              }
            }
          }
        }
      }
    } catch (error) {
      errors.push({ kind: 'balance', ...this.errorMeta(error) })
    }

    const latencyMs = Date.now() - started
    const snapshots: QuotaSnapshot[] = drafts.map((draft) => ({
      ...draft,
      id: randomUUID(),
      accountId: publicAccount.id,
      providerId: publicAccount.providerId,
      at: now,
      latencyMs,
    }))
    for (const error of errors) {
      snapshots.push({
        id: randomUUID(),
        accountId: publicAccount.id,
        providerId: publicAccount.providerId,
        at: now,
        status: 'error',
        kind: error.kind,
        error: { code: error.code, message: error.message },
        latencyMs,
        source: this.sourceOf(preset),
        extras: { interface: KIND_LABEL[error.kind] ?? error.kind },
      })
    }

    try {
      await this.store.appendSnapshots(snapshots)
    } catch (error) {
      errors.push({ kind: 'balance', ...this.errorMeta(error) })
    }

    const status = errors.length ? 'error' : 'ok'
    const message = errors.length
      ? errors.map((error) => `${KIND_LABEL[error.kind] ?? error.kind}：${error.message}`).join('；')
      : drafts.length === 0 && preset?.category === 'manual'
        ? '未录入额度'
        : undefined
    await this.store.setSync(publicAccount.id, {
      at: Date.now(),
      status,
      code: errors[0]?.code,
      message,
      lastUsageSyncAt: lastUsageSyncAt ?? previousSync?.lastUsageSyncAt,
    })
    await this.store.recordRefresh({
      at: Date.now(),
      accountId: publicAccount.id,
      label: publicAccount.label,
      status,
      kind: errors[0]?.kind ?? drafts[0]?.kind,
      message,
    })

    return {
      accountId: publicAccount.id,
      label: publicAccount.label,
      status,
      kind: (errors[0]?.kind ?? drafts[0]?.kind) as Capability | undefined,
      message,
      snapshots,
      usageAdded,
      durationMs: latencyMs,
    }
  }

  private sourceOf(preset: ProviderPreset | undefined): QuotaSnapshot['source'] {
    if (preset?.stability === 'experimental') return 'unofficial'
    if (preset?.stability === 'manual') return 'manual'
    return 'official'
  }

  private errorMeta(error: unknown): { code: string; message: string } {
    return {
      code: errorCodeOf(error),
      message: redact(error instanceof Error ? error.message : String(error)),
    }
  }

  private toRecord(raw: RawUsage, account: { id: string; providerId: string }): UsageRecord {
    let costUsdMicros = raw.costUsdMicros
    let costEstimated = raw.costEstimated ?? true
    const meta = { ...(raw.meta ?? {}) }
    if (costUsdMicros === undefined) {
      const estimate = this.pricing.estimateCost({
        model: raw.model,
        providerId: account.providerId,
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        cacheReadTokens: raw.cacheReadTokens,
        cacheWriteTokens: raw.cacheWriteTokens,
      })
      costUsdMicros = estimate.usdMicros
      costEstimated = true
      if (estimate.missingPrice) meta.priceMissing = 1
    }
    return {
      ...raw,
      id: randomUUID(),
      accountId: account.id,
      providerId: account.providerId,
      inputTokens: Math.max(0, raw.inputTokens),
      outputTokens: Math.max(0, raw.outputTokens),
      cacheReadTokens: Math.max(0, raw.cacheReadTokens),
      cacheWriteTokens: Math.max(0, raw.cacheWriteTokens),
      reasoningTokens: Math.max(0, raw.reasoningTokens),
      costUsdMicros: Math.max(0, costUsdMicros ?? 0),
      costEstimated,
      meta: Object.keys(meta).length ? meta : undefined,
    }
  }

  async getOverview(days = 30): Promise<Overview> {
    const safeDays = Math.min(365, Math.max(1, Math.round(days)))
    const now = Date.now()
    return buildOverview({
      accounts: this.store.listAccounts(),
      providers: PROVIDER_MAP,
      latest: this.store.latestSnapshots(),
      // 周额度反推要覆盖整个周窗口；耗尽预估自己会按 24 小时再截断。
      quotaHistory: this.store.listSnapshots(undefined, now - 7 * DAY_MS),
      // 套餐日志可能是几个月前的；API 汇总会在 analytics 内按时间过滤。
      usage: this.store.getUsageSince(0),
      ledger: this.store.listLedger(),
      sync: this.store.getSync(),
      settings: this.settings,
      days: safeDays,
      now,
    })
  }

  getRecords(query: RecordsQuery): RecordsPage {
    return this.store.queryUsage(query)
  }

  async addLedger(entry: Omit<LedgerEntry, 'id'>): Promise<LedgerEntry> {
    return this.store.addLedger(entry)
  }

  listLedger(accountId?: string): LedgerEntry[] {
    return this.store.listLedger(accountId)
  }

  async importUsageCsv(text: string, defaultAccountId?: string): Promise<CsvImportSummary> {
    const accounts = this.store.listAccounts()
    const accountMap = new Map(accounts.map((account) => [account.id, account]))
    const parsed = parseUsageCsv(text, accounts, this.pricing, this.settings.fxUsdCny, { defaultAccountId })
    const added = await this.store.appendUsage(
      parsed.items.map((item) => {
        const account = accountMap.get(item.accountId)
        return {
          ...item,
          id: randomUUID(),
          billingMode: account ? logBillingModeForAccount(account) : 'api',
        }
      }),
    )
    return {
      imported: parsed.items.length,
      added,
      duplicates: parsed.items.length - added,
      errors: parsed.errors,
    }
  }

  async importLedgerCsv(text: string): Promise<CsvImportSummary> {
    const parsed = parseLedgerCsv(text, this.store.listAccounts())
    let added = 0
    const errors = [...parsed.errors]
    for (const [index, item] of parsed.items.entries()) {
      try {
        await this.store.addLedger(item)
        added++
      } catch (error) {
        if (errors.length < 20) errors.push(`第 ${index + 2} 行：${redact(error, 120)}`)
      }
    }
    return { imported: parsed.items.length, added, duplicates: 0, errors: errors.slice(0, 20) }
  }

  exportUsageCsv(): string {
    const accounts = new Map(this.store.listAccounts().map((account) => [account.id, account.label]))
    const records = this.store.getUsageSince(0).sort((a, b) => a.ts - b.ts)
    const rows: Array<Array<string | number>> = [
      ['时间', '账户', '厂商', '模型', '输入', '输出', '缓存读', '缓存写', '推理', '费用USD', '原始费用', '原始币种', '来源', '估算'],
    ]
    for (const record of records) {
      rows.push([
        new Date(record.ts).toISOString(),
        accounts.get(record.accountId) ?? record.accountId,
        record.providerId,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheWriteTokens,
        record.reasoningTokens,
        (record.costUsdMicros / 1_000_000).toFixed(6),
        record.nativeCost !== undefined ? String(record.nativeCost) : '',
        record.nativeCurrency ?? '',
        record.source,
        record.costEstimated ? '是' : '否',
      ])
    }
    return toCsv(rows)
  }

  async exportBackup(includeSecrets: boolean): Promise<string> {
    const bundle = await this.store.exportBundle(includeSecrets)
    return JSON.stringify({ ...bundle, exportedAt: Date.now() }, null, 2)
  }

  async importBackup(text: string): Promise<{ accounts: number; usage: number; snapshots: number; ledger: number }> {
    let bundle: ExportBundle
    try {
      bundle = JSON.parse(text) as ExportBundle
    } catch {
      throw new AppError('validation', '备份文件不是合法 JSON')
    }
    if (!bundle || typeof bundle !== 'object' || typeof bundle.schemaVersion !== 'number') {
      throw new AppError('validation', '备份文件格式不正确')
    }
    const result = await this.store.importBundle(bundle)
    this.settings = this.store.getSettings()
    this.pricing.setFx(this.settings.fxUsdCny)
    this.pricing.setOverrides(this.store.getPricesOverrides())
    return result
  }

  /**
   * 当前状态下的告警：不落库。每次打开面板都按最新的余额/套餐快照与刷新状态现算，
   * 条件还成立就提示一次，用户手动关掉即可。
   */
  async currentAlerts(): Promise<AlertEvent[]> {
    const overview = await this.getOverview(30)
    return evaluateAlerts({
      accounts: this.store.listAccounts(),
      providers: PROVIDER_MAP,
      latest: this.store.latestSnapshots(),
      sync: this.store.getSync(),
      settings: this.settings,
      todayActualDisplay: overview.totals.todayActualDisplay,
    })
  }

  /** 推送到 Webhook：按 dedupeKey 在本次进程内去重（不落库，重启后冷却重新计时）。 */
  private async notifyAlerts(alerts: AlertEvent[]): Promise<void> {
    const hooks = this.settings.webhooks.filter((hook) => hook.enabled)
    if (hooks.length === 0 || alerts.length === 0) return
    const cooldown = this.settings.alerts.cooldownHours * 3_600_000
    const now = Date.now()
    const fresh = alerts.filter((alert) => (this.pushedAlerts.get(alert.dedupeKey) ?? 0) + cooldown <= now)
    if (fresh.length === 0) return
    for (const alert of fresh) this.pushedAlerts.set(alert.dedupeKey, now)
    const results = await this.sendHooks(hooks, fresh)
    const failed = results.filter((result) => !result.ok)
    if (failed.length) {
      await this.store.recordRefresh({
        at: now,
        accountId: 'system',
        label: 'Webhook',
        status: 'error',
        message: failed.map((item) => `${item.type}: ${item.error}`).join('；'),
      })
    }
    this.options.notify?.(`TokenPanel：${fresh.length} 条额度告警`)
  }

  async testWebhook(id?: string): Promise<WebhookTestResult[]> {
    const hooks = this.settings.webhooks.filter((hook) => hook.enabled && (!id || hook.id === id))
    if (hooks.length === 0) throw new AppError('validation', '没有启用的 Webhook')
    const sample: AlertEvent = {
      id: randomUUID(),
      at: Date.now(),
      type: 'balance_low',
      severity: 'warn',
      message: '这是一条 TokenPanel 测试告警，用于验证 Webhook 是否可达。',
      dedupeKey: 'test',
    }
    return this.sendHooks(hooks, [sample])
  }

  private async sendHooks(hooks: WebhookConfig[], events: AlertEvent[]): Promise<WebhookTestResult[]> {
    const text = [`[TokenPanel 额度告警]`, ...events.map((event) => `- ${event.message}`)].join('\n')
    return mapLimit(hooks, 3, async (hook) => {
      try {
        const payload =
          hook.type === 'feishu'
            ? { msg_type: 'text', content: { text } }
            : hook.type === 'wecom'
              ? { msgtype: 'text', text: { content: text } }
              : { title: 'TokenPanel 额度告警', text, events }
        const response = await this.fetchImpl(hook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(8000),
        })
        const bodyText = await response.text()
        let body: any
        try {
          body = JSON.parse(bodyText)
        } catch {
          body = undefined
        }
        const errcode = body?.code ?? body?.errcode
        const ok = response.ok && (errcode === undefined || errcode === 0)
        return {
          id: hook.id,
          type: hook.type,
          ok,
          error: ok ? undefined : redact(body?.msg ?? body?.errmsg ?? `HTTP ${response.status}`),
        }
      } catch (error) {
        return { id: hook.id, type: hook.type, ok: false, error: redact(error) }
      }
    })
  }

  getPriceOverrides(): PriceOverridesFile {
    return this.store.getPricesOverrides()
  }

  async savePriceOverrides(file: PriceOverridesFile): Promise<PriceOverridesFile> {
    await this.store.savePricesOverrides(file)
    const next = this.store.getPricesOverrides()
    this.pricing.setOverrides(next)
    return next
  }

  diagnostics(): Diagnostics {
    return this.store.diagnostics(this.options.mode, this.pricing.modelCount, this.pricing.updatedAt, this.pricing.source)
  }
}
