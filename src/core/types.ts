export type Stability = 'official' | 'experimental' | 'manual'
export type Capability = 'balance' | 'usage' | 'plan' | 'relay' | 'manual'
export type Currency = 'CNY' | 'USD'

export interface AuthField {
  key: string
  label: string
  required: boolean
  placeholder?: string
  help?: string
}

export interface ProviderPreset {
  id: string
  name: string
  group: string
  category: 'balance' | 'plan' | 'usage' | 'relay' | 'manual' | 'custom'
  capabilities: Capability[]
  stability: Stability
  auth: AuthField[]
  authOneOf?: string[]
  defaultCurrency?: Currency
  baseUrl?: string
  baseUrlRequired?: boolean
  docsUrl?: string
  /** 厂商控制台里创建 / 复制 Key 的页面，配置账户时一键跳转。 */
  keyUrl?: string
  notes?: string
  quotaPerUnit?: number
  /** 没有公开额度接口、只能靠本机日志统计的订阅预设：token 归套餐侧，不按按量金额估算。 */
  defaultBillingMode?: BillingMode
}

export interface ManualWindow {
  label: string
  total: number
  used: number
  unit?: string
  resetsAt?: number
}

export interface ManualPlanConfig {
  planLabel?: string
  windows: ManualWindow[]
}

export interface CustomHttpConfig {
  method: 'GET' | 'POST'
  headers?: string
  body?: string
  balancePath?: string
  currencyPath?: string
  windowsPath?: string
  windowLabelPath?: string
  windowUsedPath?: string
  windowTotalPath?: string
  windowResetPath?: string
  planLabelPath?: string
}

export interface AccountOptions {
  baseUrl?: string
  quotaPerUnit?: number
  balanceSource?: 'api' | 'ledger'
  manualBalance?: { amount: number; currency: Currency }
  manualPlan?: ManualPlanConfig
  /** 订阅套餐到期 / 续费日（手动登记）；多数厂商的额度接口不返回订阅有效期。 */
  planExpiresAt?: number
  custom?: CustomHttpConfig
  thresholds?: {
    balanceBelow?: number
    remainingBelowPct?: number
  }
}

export interface Account {
  id: string
  providerId: string
  label: string
  enabled: boolean
  createdAt: number
  auth: Record<string, string>
  options: AccountOptions
}

export interface AccountInput {
  id?: string
  providerId: string
  label?: string
  enabled?: boolean
  auth?: Record<string, string>
  options?: AccountOptions
}

export interface AccountPublic extends Omit<Account, 'auth'> {
  authMasked: Record<string, string>
  hasAuth: boolean
}

export interface QuotaWindow {
  key: string
  label: string
  used?: number
  total?: number
  unit?: string
  usedPct?: number
  remainingPct?: number
  resetsAt?: number
}

export interface QuotaSnapshot {
  id: string
  accountId: string
  providerId: string
  at: number
  status: 'ok' | 'error'
  kind: Capability
  currency?: string
  balance?: number
  windows?: QuotaWindow[]
  planLabel?: string
  usage?: { costUsd?: number; tokens?: number; requests?: number }
  error?: { code: string; message: string }
  latencyMs: number
  source: 'official' | 'unofficial' | 'manual'
  extras?: Record<string, string | number>
}

export type UsageSource = 'admin-api' | 'relay-log' | 'csv' | 'manual' | 'balance-delta' | 'local-log'
export type BillingMode = 'api' | 'plan'

export interface UsageRecord {
  id: string
  accountId: string
  providerId: string
  ts: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  costUsdMicros: number
  costEstimated: boolean
  nativeCost?: number
  nativeCurrency?: string
  source: UsageSource
  externalId: string
  billingMode?: BillingMode
  clientId?: string
  ttftMs?: number
  durationMs?: number
  tokensPerSecond?: number
  meta?: Record<string, string | number>
}

export interface LogSourceBinding {
  accountId?: string
  modelPattern?: string
}

export interface LogSourceSetting {
  id: string
  enabled: boolean
  /** 一个客户端可以同时归属到多个套餐：逐条命中带模型的绑定，其次模型规则，最后是无模型的兜底绑定。 */
  bindings: LogSourceBinding[]
}

/** 磁盘上可能还是单绑定旧写法，读取时归一成 bindings。 */
export interface RawLogSourceSetting {
  id: string
  enabled?: boolean
  accountId?: string
  modelPattern?: string
  bindings?: LogSourceBinding[]
}

export interface LogSourceStatus {
  id: string
  name: string
  description: string
  paths: string[]
  available: boolean
  supported: boolean
  enabled: boolean
  bindings: LogSourceBinding[]
  capabilities: { tokens: boolean; cache: boolean; speed: boolean; ttft: boolean }
  /** 运行中的日志解析器版本，缺省表示旧后台。 */
  parserVersion?: number
  imported: number
  importedTokens: number
  /** 上次扫描里"匹配不上归属、未入库"的条数。 */
  unattributed: number
  lastScanAt?: number
  note?: string
  error?: string
}

export interface LogScanSourceResult {
  id: string
  name: string
  available: boolean
  imported: number
  updated?: number
  skipped: number
  unattributed: number
  files: number
  errors: string[]
}

export interface LogScanResult {
  at: number
  sources: LogScanSourceResult[]
  imported: number
  updated?: number
  unattributed: number
}

export interface LedgerEntry {
  id: string
  accountId: string
  ts: number
  kind: 'recharge' | 'adjust' | 'expense'
  amount: number
  currency: Currency
  note?: string
}

export type AlertType = 'balance_low' | 'plan_low' | 'spend_high' | 'auth_error' | 'fetch_error'

export interface AlertEvent {
  id: string
  at: number
  accountId?: string
  type: AlertType
  severity: 'warn' | 'danger'
  message: string
  dedupeKey: string
}

export interface WebhookConfig {
  id: string
  type: 'feishu' | 'wecom' | 'generic'
  url: string
  enabled: boolean
}

export interface QuotaColorThresholds {
  warningPct: number
  dangerPct: number
}

export interface Settings {
  displayCurrency: Currency
  fxUsdCny: number
  fxUpdatedAt?: number
  fxAuto: boolean
  refreshTtlMin: number
  theme: 'system' | 'light' | 'dark'
  quotaColors: QuotaColorThresholds
  alerts: {
    enabled: boolean
    remainingBelowPct: number
    balanceBelowDefault?: number
    dailySpendAbove?: number
    cooldownHours: number
  }
  webhooks: WebhookConfig[]
  logSources: LogSourceSetting[]
  /** 看板卡片的展示顺序（账户 id）；未列出的账户按创建顺序排在后面。 */
  accountOrder?: string[]
}

export interface SyncState {
  accountId: string
  at: number
  status: 'ok' | 'error'
  kind?: Capability
  code?: string
  message?: string
  lastUsageSyncAt?: number
}

export interface Bootstrap {
  version: string
  mode: 'utools' | 'browser'
  dataDir: string
  providers: ProviderPreset[]
  accounts: AccountPublic[]
  settings: Settings
  sync: Record<string, SyncState>
  alerts: AlertEvent[]
  pricing: { modelCount: number; updatedAt: number; source: string }
  fx: { usdCny: number; updatedAt?: number; source: 'auto' | 'manual' }
  templates: { usage: string; ledger: string }
  lastRefresh?: { at: number; status: 'ok' | 'error'; message?: string }
  logSources: LogSourceStatus[]
}

/**
 * 单个账户的 token 统计。today/month/all 是日历窗口；带 range 前缀的跟着
 * 界面所选区间（近一周/一月/一年）——卡片上的输入/输出/缓存/速度/首字就是这个口径。
 * last* 是最近一轮，不受区间影响。
 */
export interface TokenStats {
  todayTokens: number
  monthTokens: number
  allTokens: number
  rangeTokens: number
  rangeCalls: number
  /** 非缓存输入；展示“总输入”时须再加 rangeCacheRead 与 rangeCacheWrite。 */
  rangeInput: number
  rangeOutput: number
  rangeCacheRead: number
  rangeCacheWrite: number
  /** 区间内没有调用时为 undefined，界面显示 —。 */
  rangeCacheHitRate?: number
  ttftP50?: number
  speedP50?: number
  /** 有回合级或消息间隔样本时，不能称作纯输出速度。 */
  speedEstimated?: boolean
  speedSamples?: number
  lastModel?: string
  lastAt?: number
  lastDurationMs?: number
}

export interface QuotaDepletionForecast {
  windowKey: string
  depletesAt: number
  resetsAt: number
  sampleCount: number
  observedFrom: number
  observedTo: number
  remainingPctPerHour: number
}

/** 用「相邻快照间本机 token 增量 ÷ 百分比增量」反推出来的周额度下限。 */
export interface WeeklyQuotaEstimate {
  windowKey: string
  /** 窗口只覆盖某个模型时记录模型限定词，估算只计入匹配的调用。 */
  modelHint?: string
  /** 当前额度已用百分比（含其他设备）。 */
  usedPct: number
  /** 当前重置周期内、本机日志记录到的 token。 */
  usedTokens: number
  /** 真实周额度只会不低于这个值。 */
  estimatedTotalTokens: number
  /** 用于折算的最佳观测区间。 */
  observedFrom: number
  observedTo: number
  observedTokens: number
  observedPct: number
  /** 观测到百分比上涨、本机却没有记录的区间，可能还有其他设备在用。 */
  externalUsageDetected: boolean
  cycleStart: number
  resetsAt: number
}

export interface AccountSummary {
  accountId: string
  providerId: string
  providerName: string
  label: string
  enabled: boolean
  category: ProviderPreset['category']
  stability: Stability
  status: 'ok' | 'error' | 'never' | 'disabled'
  lastAt?: number
  error?: string
  kind?: Capability
  billingMode: BillingMode | 'mixed'
  balance?: number
  currency?: string
  balanceDisplay?: number
  windows?: QuotaWindow[]
  /** 额度窗口所用的成功快照时间，与 token 统计区间无关。 */
  quotaUpdatedAt?: number
  quotaForecasts?: QuotaDepletionForecast[]
  /** 周窗口的额度总量估算；缺少百分比、重置时间或本机日志时缺省。 */
  weeklyQuotaEstimates?: WeeklyQuotaEstimate[]
  planLabel?: string
  /** 套餐到期日：优先取接口返回的订阅结束时间，回退手动登记。 */
  planExpiresAt?: number
  todayUsd: number
  monthUsd: number
  /** 本月里厂商实际计费的部分；估算出来的金额不在界面上展示，只入库。 */
  monthActualUsd: number
  todayTokens: number
  monthTokens: number
  /** 余额 ÷ 近 7 天实际计费日均；只有真账单，全估算时不推算。 */
  daysLeft?: number
  planStats?: TokenStats & { credits: number }
  /** 按量账户归到本机日志的那部分 token 指标。 */
  apiStats?: TokenStats
  planTokenSparkline: number[]
  apiTokenSparkline: number[]
}

/** 模型维度的一行，按量与套餐共用同一形状，两个 Tab 才能用同一个组件渲染。 */
export interface ModelUsageRow {
  model: string
  tokens: number
  calls: number
  cacheRead: number
  cacheWrite: number
  ttftP50?: number
  speedP50?: number
  speedEstimated?: boolean
  /** 日志里带的厂商线索（如 ZCode 的 provider_id），用于归属提示。 */
  providers?: string[]
  costUsd: number
  actualUsd: number
  estimatedShare: number
}

export interface Overview {
  generatedAt: number
  totals: {
    balanceDisplay: number
    displayCurrency: Currency
    balanceByCurrency: Record<string, number>
    todayUsd: number
    todayDisplay: number
    /** 下面四个 *Actual* 只算厂商真给的钱（官方账单/中转/CSV/手动），不含价目表估算。 */
    todayActualUsd: number
    todayActualDisplay: number
    monthUsd: number
    monthDisplay: number
    monthActualUsd: number
    monthActualDisplay: number
    todayTokens: number
    monthTokens: number
    todayInput: number
    todayOutput: number
    todayCacheRead: number
    todayCacheWrite: number
    cacheHitRate: number
  }
  accounts: AccountSummary[]
  trend: Array<{
    date: string
    costUsd: number
    actualUsd: number
    tokens: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }>
  byModel: ModelUsageRow[]
  byAccount: Array<{ accountId: string; label: string; costUsd: number; actualUsd: number; tokens: number }>
  trendByAccount: Array<{ date: string; accountId: string; label: string; costUsd: number; tokens: number }>
  planTotals: {
    todayTokens: number
    monthTokens: number
    rangeTokens: number
    allTokens: number
    allCalls: number
    firstTs?: number
    lastTs?: number
    /** 以下都是所选区间口径（calls/input/output/缓存/首字/速度）。 */
    calls: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cacheHitRate: number
    credits: number
    ttftP50?: number
    speedP50?: number
    speedEstimated?: boolean
  }
  /** 今日 0-23 点按模型拆分的 token 分布，选「今日」区间时用来画堆叠柱状图。 */
  today: {
    api: Array<{ model: string; points: number[] }>
    plan: Array<{ model: string; points: number[] }>
  }
  planByModel: ModelUsageRow[]
  planTrend: Array<{ date: string; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number }>
  /** 按模型拆分的走势（Top N + 「其他」聚合），日期轴是所选区间；套餐与按量各一套。 */
  planTrendByModel: Array<{ model: string; points: Array<{ date: string; tokens: number }> }>
  apiTrendByModel: Array<{ model: string; points: Array<{ date: string; tokens: number }> }>
}

export interface RecordsQuery {
  from?: number
  to?: number
  accountId?: string
  model?: string
  source?: string
  billingMode?: BillingMode | 'all'
  page?: number
  pageSize?: number
}

export interface RecordsPage {
  total: number
  page: number
  pageSize: number
  items: UsageRecord[]
  /** actualUsd 只含厂商实际计费（官方账单/中转/CSV/手动），价目表估算不计入。 */
  sum: { costUsd: number; actualUsd: number; tokens: number }
}

export interface RefreshAccountResult {
  accountId: string
  label: string
  status: 'ok' | 'error'
  kind?: Capability
  message?: string
  snapshots: QuotaSnapshot[]
  usageAdded: number
  durationMs: number
}

export interface RefreshAllResult {
  at: number
  results: RefreshAccountResult[]
  alerts: AlertEvent[]
  skipped?: boolean
  logImport?: LogScanResult
}

export interface WebhookTestResult {
  id: string
  type: string
  ok: boolean
  error?: string
}

export interface CsvImportSummary {
  imported: number
  added: number
  duplicates: number
  errors: string[]
}

export interface Diagnostics {
  version: string
  mode: string
  dataDir: string
  accounts: number
  usageRecords: number
  snapshots: number
  ledgerEntries: number
  pricing: { modelCount: number; updatedAt: number; source: string }
  lastErrors: Array<{ at: number; accountId: string; message: string }>
}

export interface ExportAccount extends Omit<Account, 'auth'> {
  auth: Record<string, string>
}

export interface ExportBundle {
  schemaVersion: number
  exportedAt: number
  includeSecrets: boolean
  accounts?: AccountPublic[]
  plainAccounts?: ExportAccount[]
  settings: Settings
  usage?: UsageRecord[]
  snapshots?: QuotaSnapshot[]
  ledger?: LedgerEntry[]
}
