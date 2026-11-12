import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Account,
  AccountInput,
  AccountOptions,
  AccountPublic,
  Currency,
  Diagnostics,
  ExportBundle,
  LedgerEntry,
  LogSourceBinding,
  LogSourceSetting,
  QuotaSnapshot,
  RawLogSourceSetting,
  RecordsPage,
  RecordsQuery,
  Settings,
  SyncState,
  UsageRecord,
} from '../types'
import type { ProviderPreset } from '../types'
import { getProvider } from '../providers/registry'
import { bindingKey } from '../logs/attribution'
import { ValidationError, NotFoundError } from '../errors'
import { maskSecret } from '../util/redact'
import { quotaColorThresholds, validQuotaColors } from '../util/quota'
import { decryptJson, decryptText, encryptJson, encryptText, loadOrCreateKey } from './crypto'
import { appendNdjson, readJson, readNdjson, writeJsonAtomic, writeNdjson } from './files'
import { DEFAULT_SETTINGS, SCHEMA_VERSION, defaultConfig, defaultState } from './defaults'
import type { RefreshLogEntry, StoredConfig, StoredState } from './defaults'
import type { PriceOverridesFile } from '../pricing/types'
import { VERSION } from './defaults'

const FILES = {
  config: 'config.json',
  state: 'state.json',
  usage: 'usage.ndjson',
  snapshots: 'snapshots.ndjson',
  ledger: 'ledger.ndjson',
  refreshLog: 'refresh-log.ndjson',
  prices: 'prices-overrides.json',
  archive: 'archive',
} as const

const ALLOWED_CURRENCIES: Currency[] = ['CNY', 'USD']

const MAX_BINDINGS_PER_SOURCE = 8

function trimmed(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
}

/** bindings 新写法优先；磁盘上的旧单绑定（accountId / modelPattern）折叠成一条。 */
function normalizeBindings(item: RawLogSourceSetting): LogSourceBinding[] {
  const raw: LogSourceBinding[] = Array.isArray(item.bindings) ? item.bindings : []
  const merged = raw
    .map((binding) => ({
      accountId: trimmed(binding?.accountId, 80),
      modelPattern: trimmed(binding?.modelPattern, 120),
    }))
  const legacyAccountId = trimmed(item.accountId, 80)
  if (legacyAccountId && !merged.some((binding) => binding.accountId === legacyAccountId)) {
    merged.push({ accountId: legacyAccountId, modelPattern: trimmed(item.modelPattern, 120) })
  }
  const seen = new Set<string>()
  return merged
    .filter((binding) => binding.accountId)
    .filter((binding) => {
      const key = bindingKey(binding)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_BINDINGS_PER_SOURCE)
    .map((binding) => ({
      ...(binding.accountId ? { accountId: binding.accountId } : {}),
      ...(binding.modelPattern ? { modelPattern: binding.modelPattern } : {}),
    }))
}

export class Store {
  private config: StoredConfig
  private state: StoredState
  private snapshots: QuotaSnapshot[]
  private usage: UsageRecord[]
  private ledger: LedgerEntry[]
  private refreshLog: RefreshLogEntry[]
  private prices: PriceOverridesFile
  private usageKeys = new Set<string>()
  private latest = new Map<string, QuotaSnapshot>()
  private authMap = new Map<string, Record<string, string>>()
  private decryptErrors = new Set<string>()
  private key: Buffer
  private archivedUsage = 0
  private archivedSnapshots = 0

  private constructor(
    public readonly dataDir: string,
    key: Buffer,
    config: StoredConfig,
    state: StoredState,
    snapshots: QuotaSnapshot[],
    usage: UsageRecord[],
    ledger: LedgerEntry[],
    refreshLog: RefreshLogEntry[],
    prices: PriceOverridesFile,
  ) {
    this.key = key
    this.config = config
    this.state = state
    this.snapshots = snapshots
    this.usage = usage
    this.ledger = ledger
    this.refreshLog = refreshLog
    this.prices = prices
    this.reindex()
  }

  static async open(dataDir: string): Promise<Store> {
    await fs.mkdir(dataDir, { recursive: true })
    const key = await loadOrCreateKey(dataDir)
    const config = await readJson<StoredConfig>(path.join(dataDir, FILES.config), defaultConfig())
    const state = await readJson<StoredState>(path.join(dataDir, FILES.state), defaultState())
    const snapshotsFile = await readNdjson<QuotaSnapshot>(path.join(dataDir, FILES.snapshots))
    const usageFile = await readNdjson<UsageRecord>(path.join(dataDir, FILES.usage))
    const ledgerFile = await readNdjson<LedgerEntry>(path.join(dataDir, FILES.ledger))
    const refreshFile = await readNdjson<RefreshLogEntry>(path.join(dataDir, FILES.refreshLog))
    const prices = await readJson<PriceOverridesFile>(path.join(dataDir, FILES.prices), {
      updatedAt: 0,
      models: {},
    })

    if (!config.settings) config.settings = structuredClone(DEFAULT_SETTINGS)
    if (!config.accounts) config.accounts = []
    if (!state.sync) state.sync = {}
    for (const webhook of config.settings.webhooks ?? []) {
      if (typeof webhook.url === 'string' && webhook.url.startsWith('v1.')) {
        try {
          webhook.url = decryptText(key, webhook.url)
        } catch {
          webhook.url = ''
          webhook.enabled = false
        }
      }
    }
    if (config.schemaVersion !== SCHEMA_VERSION) {
      const backup = path.join(dataDir, `config.v${config.schemaVersion || 0}.${Date.now()}.bak.json`)
      await fs.writeFile(backup, JSON.stringify(config, null, 2), 'utf8')
      config.schemaVersion = SCHEMA_VERSION
    }

    const store = new Store(
      dataDir,
      key,
      config,
      state,
      snapshotsFile.items,
      usageFile.items,
      ledgerFile.items,
      refreshFile.items,
      prices,
    )
    await store.normalizeSettings()
    await store.compact()
    return store
  }

  private reindex(): void {
    this.usageKeys.clear()
    for (const record of this.usage) {
      this.usageKeys.add(`${record.source}|${record.accountId}|${record.externalId}`)
    }
    this.latest.clear()
    for (const snapshot of this.snapshots) {
      if (snapshot.status !== 'ok') continue
      const key = `${snapshot.accountId}:${snapshot.kind}`
      const current = this.latest.get(key)
      if (!current || current.at < snapshot.at) this.latest.set(key, snapshot)
    }
  }

  private async normalizeSettings(): Promise<void> {
    let changed = false
    const quotaColors = quotaColorThresholds(this.config.settings.quotaColors)
    if (JSON.stringify(this.config.settings.quotaColors) !== JSON.stringify(quotaColors)) {
      this.config.settings.quotaColors = quotaColors
      changed = true
    }
    if (!this.config.settings.alerts) {
      this.config.settings.alerts = structuredClone(DEFAULT_SETTINGS.alerts)
      changed = true
    }
    if (!Array.isArray(this.config.settings.webhooks)) {
      this.config.settings.webhooks = []
      changed = true
    }
    const rawSources = Array.isArray(this.config.settings.logSources) ? this.config.settings.logSources : []
    const normalizedSources = this.sanitizeLogSources(rawSources)
    if (JSON.stringify(normalizedSources) !== JSON.stringify(rawSources)) {
      this.config.settings.logSources = normalizedSources
      changed = true
    }
    if (!ALLOWED_CURRENCIES.includes(this.config.settings.displayCurrency)) {
      this.config.settings.displayCurrency = 'CNY'
      changed = true
    }
    if (!Number.isFinite(this.config.settings.fxUsdCny) || this.config.settings.fxUsdCny <= 0) {
      this.config.settings.fxUsdCny = DEFAULT_SETTINGS.fxUsdCny
      changed = true
    }
    if (changed) await this.persistConfig()
  }

  private async compact(): Promise<void> {
    const now = Date.now()
    const usageCutoff = now - 400 * 86_400_000
    const snapshotCutoff = now - 365 * 86_400_000
    if (this.usage.length > 50_000) {
      const old = this.usage.filter((r) => r.ts < usageCutoff)
      if (old.length > 0) {
        await this.archive('usage', old)
        this.usage = this.usage.filter((r) => r.ts >= usageCutoff)
        await writeNdjson(path.join(this.dataDir, FILES.usage), this.usage)
        this.archivedUsage = old.length
        this.reindex()
      }
    }
    if (this.snapshots.length > 20_000) {
      const old = this.snapshots.filter((s) => s.at < snapshotCutoff)
      if (old.length > 0) {
        await this.archive('snapshots', old)
        this.snapshots = this.snapshots.filter((s) => s.at >= snapshotCutoff)
        await writeNdjson(path.join(this.dataDir, FILES.snapshots), this.snapshots)
        this.archivedSnapshots = old.length
        this.reindex()
      }
    }
    if (this.refreshLog.length > 5_000) {
      this.refreshLog = this.refreshLog.slice(-2_000)
      await writeNdjson(path.join(this.dataDir, FILES.refreshLog), this.refreshLog)
    }
  }

  private async archive(kind: 'usage' | 'snapshots', items: unknown[]): Promise<void> {
    const dir = path.join(this.dataDir, FILES.archive)
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${kind}-${new Date().getFullYear()}.ndjson`)
    await appendNdjson(file, items)
  }

  private async persistConfig(): Promise<void> {
    this.config.updatedAt = Date.now()
    const stored = structuredClone(this.config)
    stored.settings.webhooks = stored.settings.webhooks.map((webhook) => ({
      ...webhook,
      url: webhook.url.startsWith('v1.') ? webhook.url : encryptText(this.key, webhook.url),
    }))
    await writeJsonAtomic(path.join(this.dataDir, FILES.config), stored)
    await this.writeConfigSnapshot(stored)
  }

  /** 每次保存都留一份配置快照，防止误删后无法回滚；只保留最近 10 份。 */
  private async writeConfigSnapshot(stored: StoredConfig): Promise<void> {
    const dir = path.join(this.dataDir, 'backups')
    try {
      await fs.mkdir(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await fs.writeFile(path.join(dir, `config-${stamp}.json`), `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
      const files = (await fs.readdir(dir)).filter((file) => file.startsWith('config-')).sort()
      for (const file of files.slice(0, Math.max(0, files.length - 10))) {
        await fs.rm(path.join(dir, file), { force: true })
      }
    } catch {
      // 快照失败不影响主流程
    }
  }

  private async persistState(): Promise<void> {
    await writeJsonAtomic(path.join(this.dataDir, FILES.state), this.state)
  }

  private decryptAccount(stored: StoredConfig['accounts'][number]): Record<string, string> {
    const cached = this.authMap.get(stored.id)
    if (cached) return cached
    try {
      const auth = decryptJson<Record<string, string>>(this.key, stored.authEnc)
      this.authMap.set(stored.id, auth)
      return auth
    } catch {
      this.decryptErrors.add(stored.id)
      return {}
    }
  }

  listAccounts(): AccountPublic[] {
    return this.config.accounts.map((stored) => {
      const preset = getProvider(stored.providerId)
      const auth = this.decryptAccount(stored)
      const authMasked: Record<string, string> = {}
      for (const field of preset?.auth ?? []) {
        if (auth[field.key]) authMasked[field.key] = maskSecret(auth[field.key])
      }
      const { authEnc: _authEnc, ...rest } = stored
      return {
        ...rest,
        authMasked,
        hasAuth: Object.values(auth).some((v) => Boolean(v)),
      }
    })
  }

  getAccount(id: string): Account {
    const stored = this.config.accounts.find((item) => item.id === id)
    if (!stored) throw new NotFoundError('账户不存在')
    return {
      id: stored.id,
      providerId: stored.providerId,
      label: stored.label,
      enabled: stored.enabled,
      createdAt: stored.createdAt,
      auth: this.decryptAccount(stored),
      options: structuredClone(stored.options ?? {}),
    }
  }

  hasDecryptError(id: string): boolean {
    return this.decryptErrors.has(id)
  }

  private validateAuth(preset: ProviderPreset, input: Record<string, string>, previous?: Record<string, string>): Record<string, string> {
    const allowed = new Set(preset.auth.map((field) => field.key))
    const merged: Record<string, string> = {}
    for (const field of preset.auth) {
      const incoming = input[field.key]
      const old = previous?.[field.key] ?? ''
      const value = typeof incoming === 'string' && incoming.trim() !== '' ? incoming.trim() : old
      if (value) merged[field.key] = value
    }
    for (const key of Object.keys(input)) {
      if (!allowed.has(key) && input[key]) throw new ValidationError(`未知的鉴权字段：${key}`)
    }
    for (const field of preset.auth) {
      if (field.required && !merged[field.key]) throw new ValidationError(`请填写 ${field.label}`)
    }
    if (preset.authOneOf && !preset.authOneOf.some((key) => merged[key])) {
      const labels = preset.authOneOf
        .map((key) => preset.auth.find((field) => field.key === key)?.label ?? key)
        .join(' 或 ')
      throw new ValidationError(`请至少填写 ${labels}`)
    }
    return merged
  }

  private sanitizeOptions(preset: ProviderPreset, options: AccountOptions | undefined, isNew: boolean): AccountOptions {
    const out: AccountOptions = {}
    const baseUrl = (options?.baseUrl ?? (isNew ? preset.baseUrl : undefined))?.trim()
    if (baseUrl) {
      if (!/^https?:\/\//i.test(baseUrl)) throw new ValidationError('Base URL 必须以 http:// 或 https:// 开头')
      out.baseUrl = baseUrl.replace(/\/+$/, '')
    }
    if (preset.baseUrlRequired && !out.baseUrl) throw new ValidationError('请填写 Base URL')
    if (options?.quotaPerUnit !== undefined) {
      const value = Number(options.quotaPerUnit)
      if (!Number.isFinite(value) || value <= 0) throw new ValidationError('quotaPerUnit 必须是正数')
      out.quotaPerUnit = value
    } else if (preset.quotaPerUnit) {
      out.quotaPerUnit = preset.quotaPerUnit
    }
    if (options?.balanceSource) out.balanceSource = options.balanceSource
    if (options?.manualBalance) {
      const amount = Number(options.manualBalance.amount)
      if (!Number.isFinite(amount) || amount < 0) throw new ValidationError('手动余额必须是非负数')
      if (!ALLOWED_CURRENCIES.includes(options.manualBalance.currency)) throw new ValidationError('币种只支持 CNY / USD')
      out.manualBalance = { amount, currency: options.manualBalance.currency }
    }
    if (options?.manualPlan) {
      const windows = (options.manualPlan.windows ?? [])
        .map((window) => ({
          label: String(window.label ?? '').trim().slice(0, 40) || '额度',
          total: Number(window.total),
          used: Number(window.used),
          unit: window.unit ? String(window.unit).slice(0, 12) : undefined,
          resetsAt: window.resetsAt && Number.isFinite(window.resetsAt) ? window.resetsAt : undefined,
        }))
        .filter((window) => Number.isFinite(window.total) && window.total > 0 && Number.isFinite(window.used))
      out.manualPlan = {
        planLabel: options.manualPlan.planLabel?.trim().slice(0, 40) || undefined,
        windows,
      }
    }
    if (options?.planExpiresAt !== undefined) {
      const value = Number(options.planExpiresAt)
      if (!Number.isFinite(value) || value <= 0) throw new ValidationError('套餐到期日无效')
      out.planExpiresAt = value
    }
    if (options?.thresholds) {
      const thresholds: NonNullable<AccountOptions['thresholds']> = {}
      if (options.thresholds.balanceBelow !== undefined) {
        const value = Number(options.thresholds.balanceBelow)
        if (!Number.isFinite(value) || value < 0) throw new ValidationError('余额阈值必须是非负数')
        thresholds.balanceBelow = value
      }
      if (options.thresholds.remainingBelowPct !== undefined) {
        const value = Number(options.thresholds.remainingBelowPct)
        if (!Number.isFinite(value) || value < 0 || value > 100) throw new ValidationError('套餐阈值必须在 0-100 之间')
        thresholds.remainingBelowPct = value
      }
      out.thresholds = thresholds
    }
    if (preset.category === 'custom') {
      const custom = options?.custom
      if (!custom) throw new ValidationError('请填写自定义接口配置')
      if (!custom.balancePath && !custom.windowsPath) throw new ValidationError('至少填写余额路径或套餐窗口路径')
      if (custom.headers) {
        try {
          const parsed = JSON.parse(custom.headers)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
        } catch {
          throw new ValidationError('请求头必须是合法的 JSON 对象')
        }
      }
      out.custom = {
        method: custom.method === 'POST' ? 'POST' : 'GET',
        headers: custom.headers?.slice(0, 4000),
        body: custom.body?.slice(0, 4000),
        balancePath: custom.balancePath?.slice(0, 200),
        currencyPath: custom.currencyPath?.slice(0, 200),
        windowsPath: custom.windowsPath?.slice(0, 200),
        windowLabelPath: custom.windowLabelPath?.slice(0, 200),
        windowUsedPath: custom.windowUsedPath?.slice(0, 200),
        windowTotalPath: custom.windowTotalPath?.slice(0, 200),
        windowResetPath: custom.windowResetPath?.slice(0, 200),
        planLabelPath: custom.planLabelPath?.slice(0, 200),
      }
    }
    return out
  }

  async saveAccount(input: AccountInput): Promise<AccountPublic> {
    const preset = getProvider(input.providerId)
    if (!preset) throw new ValidationError('未知的厂商')
    const existing = input.id ? this.config.accounts.find((item) => item.id === input.id) : undefined
    if (input.id && !existing) throw new NotFoundError('账户不存在')
    const previousAuth = existing ? this.decryptAccount(existing) : undefined
    const auth =
      preset.category === 'manual'
        ? {}
        : this.validateAuth(preset, input.auth ?? {}, previousAuth)
    const label = (input.label ?? existing?.label ?? preset.name).trim().slice(0, 60) || preset.name
    const options = this.sanitizeOptions(preset, input.options ?? existing?.options, !existing)
    const authEnc = encryptJson(this.key, auth)
    const createdAt = existing?.createdAt ?? Date.now()
    const id = existing?.id ?? randomUUID()
    const stored = {
      id,
      providerId: input.providerId,
      label,
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt,
      authEnc,
      options,
    }
    if (existing) {
      this.config.accounts = this.config.accounts.map((item) => (item.id === id ? stored : item))
    } else {
      this.config.accounts.push(stored)
    }
    this.authMap.set(id, auth)
    this.decryptErrors.delete(id)
    await this.persistConfig()
    return this.listAccounts().find((item) => item.id === id)!
  }

  async deleteAccount(id: string, purge: boolean): Promise<void> {
    const exists = this.config.accounts.some((item) => item.id === id)
    if (!exists) throw new NotFoundError('账户不存在')
    this.config.accounts = this.config.accounts.filter((item) => item.id !== id)
    this.authMap.delete(id)
    delete this.state.sync[id]
    if (purge) {
      this.usage = this.usage.filter((record) => record.accountId !== id)
      this.snapshots = this.snapshots.filter((snapshot) => snapshot.accountId !== id)
      this.ledger = this.ledger.filter((entry) => entry.accountId !== id)
      await writeNdjson(path.join(this.dataDir, FILES.usage), this.usage)
      await writeNdjson(path.join(this.dataDir, FILES.snapshots), this.snapshots)
      await writeNdjson(path.join(this.dataDir, FILES.ledger), this.ledger)
      this.reindex()
    }
    await this.persistConfig()
    await this.persistState()
  }

  getSettings(): Settings {
    return structuredClone(this.config.settings)
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const current = this.config.settings
    const next: Settings = {
      ...current,
      ...patch,
      quotaColors: { ...current.quotaColors, ...(patch.quotaColors ?? {}) },
      alerts: { ...current.alerts, ...(patch.alerts ?? {}) },
      webhooks: patch.webhooks ? this.sanitizeWebhooks(patch.webhooks) : current.webhooks,
      logSources: patch.logSources ? this.sanitizeLogSources(patch.logSources) : current.logSources,
    }
    if (!ALLOWED_CURRENCIES.includes(next.displayCurrency)) throw new ValidationError('展示币种只支持 CNY / USD')
    if (!validQuotaColors(next.quotaColors)) {
      throw new ValidationError('额度颜色阈值必须满足 0 ≤ 红色 < 橙色 ≤ 100（%）')
    }
    if (!Number.isFinite(next.fxUsdCny) || next.fxUsdCny <= 0) throw new ValidationError('汇率必须是正数')
    if (!Number.isFinite(next.refreshTtlMin) || next.refreshTtlMin < 1 || next.refreshTtlMin > 1440) {
      throw new ValidationError('刷新间隔必须在 1-1440 分钟之间')
    }
    if (!Number.isFinite(next.alerts.remainingBelowPct) || next.alerts.remainingBelowPct < 0 || next.alerts.remainingBelowPct > 100) {
      throw new ValidationError('套餐告警阈值必须在 0-100 之间')
    }
    if (!Number.isFinite(next.alerts.cooldownHours) || next.alerts.cooldownHours < 1 || next.alerts.cooldownHours > 168) {
      throw new ValidationError('告警冷却必须在 1-168 小时之间')
    }
    this.config.settings = next
    await this.persistConfig()
    return this.getSettings()
  }

  private sanitizeLogSources(list: RawLogSourceSetting[]): Settings['logSources'] {
    if (!Array.isArray(list)) return []
    const seen = new Set<string>()
    return list
      .filter((item) => item && typeof item.id === 'string' && item.id.trim())
      .map((item) => ({
        id: item.id.trim().slice(0, 80),
        enabled: item.enabled !== false,
        bindings: normalizeBindings(item),
      }))
      .filter((item) => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })
  }

  private sanitizeWebhooks(webhooks: Settings['webhooks']): Settings['webhooks'] {
    return webhooks
      .filter((hook) => ['feishu', 'wecom', 'generic'].includes(hook.type))
      .map((hook) => {
        if (!/^https?:\/\//i.test(hook.url)) throw new ValidationError('Webhook 地址必须是 http(s) URL')
        return {
          id: hook.id || randomUUID(),
          type: hook.type,
          url: hook.url.trim(),
          enabled: hook.enabled !== false,
        }
      })
  }

  getSync(): Record<string, SyncState> {
    return structuredClone(this.state.sync)
  }

  async setSync(accountId: string, patch: Partial<SyncState>): Promise<void> {
    const current = this.state.sync[accountId] ?? { accountId, at: 0, status: 'ok' }
    this.state.sync[accountId] = { ...current, ...patch, accountId, at: patch.at ?? Date.now() }
    await this.persistState()
  }

  getLastRefresh(): StoredState['lastRefresh'] {
    return this.state.lastRefresh
  }

  async setLastRefresh(value: NonNullable<StoredState['lastRefresh']>): Promise<void> {
    this.state.lastRefresh = value
    await this.persistState()
  }

  latestSnapshots(): Map<string, QuotaSnapshot> {
    return new Map(this.latest)
  }

  latestSnapshot(accountId: string, kind: QuotaSnapshot['kind']): QuotaSnapshot | undefined {
    return this.latest.get(`${accountId}:${kind}`)
  }

  listSnapshots(accountId?: string, since?: number): QuotaSnapshot[] {
    return this.snapshots.filter(
      (snapshot) => (!accountId || snapshot.accountId === accountId) && (!since || snapshot.at >= since),
    )
  }

  async appendSnapshots(snapshots: QuotaSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return
    const valid = snapshots.filter((snapshot) => snapshot.status === 'ok' || snapshot.error)
    if (valid.length === 0) return
    this.snapshots.push(...valid)
    for (const snapshot of valid) {
      if (snapshot.status !== 'ok') continue
      const key = `${snapshot.accountId}:${snapshot.kind}`
      const current = this.latest.get(key)
      if (!current || current.at <= snapshot.at) this.latest.set(key, snapshot)
    }
    await appendNdjson(path.join(this.dataDir, FILES.snapshots), valid)
  }

  getUsageSince(since: number, to = Date.now()): UsageRecord[] {
    return this.usage.filter((record) => record.ts >= since && record.ts <= to)
  }

  async appendUsage(records: UsageRecord[]): Promise<number> {
    const added: UsageRecord[] = []
    for (const record of records) {
      const key = `${record.source}|${record.accountId}|${record.externalId}`
      if (this.usageKeys.has(key)) continue
      this.usageKeys.add(key)
      added.push(record)
    }
    if (added.length === 0) return 0
    this.usage.push(...added)
    await appendNdjson(path.join(this.dataDir, FILES.usage), added)
    return added.length
  }

  /** 原日志补写了完成事件时，只补齐计时，不重记 token、费用或修改账户归属。 */
  async enrichUsageTiming(records: UsageRecord[]): Promise<number> {
    const candidates = new Map(records
      .filter((record) => record.source === 'local-log')
      .map((record) => [`${record.source}|${record.accountId}|${record.externalId}`, record]))
    // 计时精度排序：整轮/消息间隔 < 逐调用间隔 < 官方精确值。只允许往上升级。
    const rankOf = (record: UsageRecord): number => {
      const scope = record.meta?.durationScope
      if (scope === 'request') return 3
      if (scope === 'turn-gap') return 2
      if (scope === 'task' || scope === 'turn' || record.meta?.durationSource === 'message-gap') return 1
      return 0
    }
    let updated = 0
    this.usage = this.usage.map((current) => {
      if (current.source !== 'local-log') return current
      const incoming = candidates.get(`${current.source}|${current.accountId}|${current.externalId}`)
      if (!incoming || incoming.clientId !== current.clientId) return current
      // 估速可以被后来的精确值覆盖（回合结束后才知道单次耗时），精确值不会被降级。
      const upgrade = rankOf(incoming) > rankOf(current)
      const patch: Partial<UsageRecord> = {}
      const keepDuration = current.durationMs === undefined || upgrade
      const keepSpeed = current.tokensPerSecond === undefined || upgrade
      if (keepDuration && incoming.durationMs !== undefined && Number.isFinite(incoming.durationMs) && incoming.durationMs > 0) patch.durationMs = incoming.durationMs
      if (keepSpeed && incoming.tokensPerSecond !== undefined && Number.isFinite(incoming.tokensPerSecond) && incoming.tokensPerSecond > 0) patch.tokensPerSecond = incoming.tokensPerSecond
      if (upgrade && incoming.ttftMs !== undefined && Number.isFinite(incoming.ttftMs) && incoming.ttftMs >= 0) patch.ttftMs = incoming.ttftMs
      else if (current.ttftMs === undefined && incoming.ttftMs !== undefined && Number.isFinite(incoming.ttftMs) && incoming.ttftMs >= 0) patch.ttftMs = incoming.ttftMs
      if (Object.keys(patch).length === 0) return current
      const meta = { ...current.meta }
      const metaKeys = [
        ...(patch.durationMs !== undefined || patch.tokensPerSecond !== undefined ? ['durationScope', 'durationSource'] : []),
        ...(patch.ttftMs !== undefined ? ['ttftScope'] : []),
      ]
      for (const key of metaKeys) {
        const value = incoming.meta?.[key]
        if (value === undefined) continue
        if (meta[key] === undefined || upgrade) meta[key] = value
      }
      updated++
      return { ...current, ...patch, meta }
    })
    if (updated > 0) await writeNdjson(path.join(this.dataDir, FILES.usage), [...this.usage])
    return updated
  }

  queryUsage(query: RecordsQuery): RecordsPage {
    const page = Math.max(1, Math.floor(query.page ?? 1))
    const pageSize = Math.min(500, Math.max(1, Math.floor(query.pageSize ?? 50)))
    const modelFilter = query.model?.trim().toLowerCase()
    const filtered = this.usage
      .filter((record) => {
        if (query.from && record.ts < query.from) return false
        if (query.to && record.ts > query.to) return false
        if (query.accountId && record.accountId !== query.accountId) return false
        if (query.source && record.source !== query.source) return false
        if (query.billingMode && query.billingMode !== 'all' && (record.billingMode ?? 'api') !== query.billingMode) return false
        if (modelFilter && !record.model.toLowerCase().includes(modelFilter)) return false
        return true
      })
      .sort((a, b) => b.ts - a.ts)
    const sumCost = filtered.reduce((total, record) => total + record.costUsdMicros, 0)
    const sumActual = filtered.reduce(
      (total, record) => (record.costEstimated ? total : total + record.costUsdMicros),
      0,
    )
    const sumTokens = filtered.reduce(
      (total, record) => total + record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens,
      0,
    )
    const start = (page - 1) * pageSize
    return {
      total: filtered.length,
      page,
      pageSize,
      items: filtered.slice(start, start + pageSize),
      sum: { costUsd: sumCost / 1_000_000, actualUsd: sumActual / 1_000_000, tokens: sumTokens },
    }
  }

  sourceStats(clientId: string): { records: number; tokens: number } {
    const stats = { records: 0, tokens: 0 }
    for (const record of this.usage) {
      if (record.clientId !== clientId) continue
      stats.records += 1
      stats.tokens += record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens
    }
    return stats
  }

  /** 清掉这个来源历史上"没归属"的记录：现在匹配不上归属就不落库，旧的不该继续算进总量。 */
  async removeUnattributedByClient(clientId: string): Promise<number> {
    const before = this.usage.length
    this.usage = this.usage.filter((record) => !(record.clientId === clientId && !record.accountId))
    const removed = before - this.usage.length
    if (removed > 0) {
      await writeNdjson(path.join(this.dataDir, FILES.usage), this.usage)
      this.reindex()
    }
    return removed
  }

  async removeUsageByClient(clientId: string): Promise<number> {
    const before = this.usage.length
    this.usage = this.usage.filter((record) => record.clientId !== clientId)
    const removed = before - this.usage.length
    if (removed > 0) {
      await writeNdjson(path.join(this.dataDir, FILES.usage), this.usage)
      this.reindex()
    }
    return removed
  }

  listLedger(accountId?: string): LedgerEntry[] {
    return this.ledger.filter((entry) => !accountId || entry.accountId === accountId).sort((a, b) => b.ts - a.ts)
  }

  async addLedger(entry: Omit<LedgerEntry, 'id'>): Promise<LedgerEntry> {
    if (!this.config.accounts.some((account) => account.id === entry.accountId)) throw new NotFoundError('账户不存在')
    if (!['recharge', 'adjust', 'expense'].includes(entry.kind)) throw new ValidationError('未知的记账类型')
    if (!Number.isFinite(entry.amount) || entry.amount === 0) throw new ValidationError('金额不能为 0')
    if (entry.kind !== 'adjust' && entry.amount < 0) throw new ValidationError('充值/消费金额必须为正数')
    if (!ALLOWED_CURRENCIES.includes(entry.currency)) throw new ValidationError('币种只支持 CNY / USD')
    const record: LedgerEntry = {
      id: randomUUID(),
      accountId: entry.accountId,
      ts: entry.ts || Date.now(),
      kind: entry.kind,
      amount: entry.kind === 'adjust' ? entry.amount : Math.abs(entry.amount),
      currency: entry.currency,
      note: entry.note?.slice(0, 200),
    }
    this.ledger.push(record)
    await appendNdjson(path.join(this.dataDir, FILES.ledger), [record])
    return record
  }

  getPricesOverrides(): PriceOverridesFile {
    return structuredClone(this.prices)
  }

  async savePricesOverrides(file: PriceOverridesFile): Promise<void> {
    for (const [model, price] of Object.entries(file.models)) {
      if (!model.trim()) throw new ValidationError('模型名不能为空')
      for (const field of ['inputPerM', 'outputPerM', 'cacheReadPerM', 'cacheWritePerM'] as const) {
        const value = price[field]
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
          throw new ValidationError(`${model} 的 ${field} 必须是非负数`)
        }
      }
      if (!ALLOWED_CURRENCIES.includes(price.currency)) throw new ValidationError('币种只支持 CNY / USD')
    }
    this.prices = { updatedAt: Date.now(), models: file.models }
    await writeJsonAtomic(path.join(this.dataDir, FILES.prices), this.prices)
  }

  async recordRefresh(entry: RefreshLogEntry): Promise<void> {
    this.refreshLog.push(entry)
    if (this.refreshLog.length > 2_000) this.refreshLog = this.refreshLog.slice(-1_000)
    await appendNdjson(path.join(this.dataDir, FILES.refreshLog), [entry])
  }

  lastErrors(limit = 8): Array<{ at: number; accountId: string; message: string }> {
    return this.refreshLog
      .filter((entry) => entry.status === 'error')
      .slice(-limit)
      .reverse()
      .map((entry) => ({ at: entry.at, accountId: entry.accountId, message: entry.message ?? '' }))
  }

  diagnostics(mode: string, modelCount: number, pricingUpdatedAt: number, pricingSource: string): Diagnostics {
    return {
      version: VERSION,
      mode,
      dataDir: this.dataDir,
      accounts: this.config.accounts.length,
      usageRecords: this.usage.length,
      snapshots: this.snapshots.length,
      ledgerEntries: this.ledger.length,
      pricing: { modelCount, updatedAt: pricingUpdatedAt, source: pricingSource },
      lastErrors: this.lastErrors(),
    }
  }

  async exportBundle(includeSecrets: boolean): Promise<ExportBundle> {
    const accounts = includeSecrets
      ? undefined
      : this.listAccounts().map((account) => ({
          ...account,
          options: account.options.custom
            ? { ...account.options, custom: { ...account.options.custom, headers: undefined, body: undefined } }
            : account.options,
        }))
    const settings = this.getSettings()
    if (!includeSecrets) {
      settings.webhooks = settings.webhooks.map((webhook) => ({ ...webhook, url: '' }))
    }
    const plainAccounts = includeSecrets
      ? this.config.accounts.map((stored) => ({
          id: stored.id,
          providerId: stored.providerId,
          label: stored.label,
          enabled: stored.enabled,
          createdAt: stored.createdAt,
          auth: this.decryptAccount(stored),
          options: stored.options,
        }))
      : undefined
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Date.now(),
      includeSecrets,
      accounts,
      plainAccounts,
      settings,
      usage: this.usage,
      snapshots: this.snapshots,
      ledger: this.ledger,
    }
  }

  async importBundle(bundle: ExportBundle): Promise<{ accounts: number; usage: number; snapshots: number; ledger: number }> {
    if (!bundle || bundle.schemaVersion > SCHEMA_VERSION) throw new ValidationError('备份文件版本过新')
    let settingsChanged = false
    if (bundle.settings && typeof bundle.settings === 'object') {
      const current = this.config.settings
      this.config.settings = {
        ...current,
        ...bundle.settings,
        quotaColors: quotaColorThresholds(bundle.settings.quotaColors ?? current.quotaColors),
        alerts: { ...current.alerts, ...(bundle.settings.alerts ?? {}) },
        webhooks: bundle.includeSecrets
          ? this.sanitizeWebhooks(bundle.settings.webhooks ?? [])
          : current.webhooks,
      }
      settingsChanged = true
    }
    let accounts = 0
    // 不含密钥的备份也要能还原账户（标签、选项、余额/套餐），密钥留空由用户重新填。
    for (const account of bundle.accounts ?? []) {
      if (this.config.accounts.some((item) => item.id === account.id)) continue
      if (!getProvider(account.providerId)) continue
      this.config.accounts.push({
        id: account.id,
        providerId: account.providerId,
        label: account.label,
        enabled: account.enabled !== false,
        createdAt: account.createdAt || Date.now(),
        authEnc: encryptJson(this.key, {}),
        options: account.options ?? {},
      })
      accounts++
    }
    for (const account of bundle.plainAccounts ?? []) {
      if (this.config.accounts.some((item) => item.id === account.id)) continue
      const preset = getProvider(account.providerId)
      if (!preset) continue
      const authEnc = encryptJson(this.key, account.auth ?? {})
      this.config.accounts.push({
        id: account.id,
        providerId: account.providerId,
        label: account.label,
        enabled: account.enabled !== false,
        createdAt: account.createdAt || Date.now(),
        authEnc,
        options: account.options ?? {},
      })
      this.authMap.set(account.id, account.auth ?? {})
      accounts++
    }
    let usage = 0
    for (const record of bundle.usage ?? []) {
      const key = `${record.source}|${record.accountId}|${record.externalId}`
      if (this.usageKeys.has(key)) continue
      this.usageKeys.add(key)
      this.usage.push(record)
      usage++
    }
    let snapshots = 0
    for (const snapshot of bundle.snapshots ?? []) {
      if (this.snapshots.some((item) => item.id === snapshot.id)) continue
      this.snapshots.push(snapshot)
      snapshots++
    }
    let ledger = 0
    for (const entry of bundle.ledger ?? []) {
      if (this.ledger.some((item) => item.id === entry.id)) continue
      this.ledger.push(entry)
      ledger++
    }
    if (usage > 0) await writeNdjson(path.join(this.dataDir, FILES.usage), this.usage)
    if (snapshots > 0) await writeNdjson(path.join(this.dataDir, FILES.snapshots), this.snapshots)
    if (ledger > 0) await writeNdjson(path.join(this.dataDir, FILES.ledger), this.ledger)
    if (accounts > 0 || settingsChanged) await this.persistConfig()
    this.reindex()
    return { accounts, usage, snapshots, ledger }
  }

  stats(): { usageRecords: number; snapshots: number; ledgerEntries: number; archivedUsage: number; archivedSnapshots: number } {
    return {
      usageRecords: this.usage.length,
      snapshots: this.snapshots.length,
      ledgerEntries: this.ledger.length,
      archivedUsage: this.archivedUsage,
      archivedSnapshots: this.archivedSnapshots,
    }
  }
}
