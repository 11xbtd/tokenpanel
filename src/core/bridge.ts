import type {
  AccountInput,
  AccountPublic,
  Bootstrap,
  CsvImportSummary,
  Diagnostics,
  LedgerEntry,
  LogScanResult,
  Overview,
  RecordsPage,
  RecordsQuery,
  RefreshAccountResult,
  RefreshAllResult,
  Settings,
  WebhookTestResult,
} from './types'
import type { PriceOverridesFile } from './pricing/types'
import type { NewsOverview, NewsPreferencesInput } from './news/types'

export interface SaveFileResult {
  saved: boolean
  path?: string
  error?: string
}

export interface PanelServices {
  getBootstrap(): Promise<Bootstrap>
  saveAccount(input: AccountInput): Promise<AccountPublic>
  deleteAccount(id: string, purge: boolean): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  refreshAll(force: boolean): Promise<RefreshAllResult>
  refreshAccount(id: string): Promise<RefreshAccountResult>
  scanLogs(): Promise<LogScanResult>
  rebuildLogStats(): Promise<LogScanResult & { rebuilt: number }>
  getOverview(days: number): Promise<Overview>
  getNews(force?: boolean): Promise<NewsOverview>
  updateNewsPreferences(input: NewsPreferencesInput): Promise<NewsOverview>
  getRecords(query: RecordsQuery): Promise<RecordsPage>
  addLedger(entry: Omit<LedgerEntry, 'id'>): Promise<LedgerEntry>
  listLedger(accountId?: string): Promise<LedgerEntry[]>
  importUsageCsv(text: string, defaultAccountId?: string): Promise<CsvImportSummary>
  importLedgerCsv(text: string): Promise<CsvImportSummary>
  importBackup(text: string): Promise<{ accounts: number; usage: number; snapshots: number; ledger: number }>
  exportUsageCsv(): Promise<string>
  exportBackup(includeSecrets: boolean): Promise<string>
  getDiagnostics(): Promise<Diagnostics>
  getPriceOverrides(): Promise<PriceOverridesFile>
  savePriceOverrides(file: PriceOverridesFile): Promise<PriceOverridesFile>
  refreshFx(force: boolean): Promise<{ rate: number; updatedAt?: number; source: 'auto' | 'manual' }>
  testWebhook(id?: string): Promise<WebhookTestResult[]>
  saveFile(filename: string, content: string): Promise<SaveFileResult>
  openExternal(url: string): void
}

declare global {
  interface Window {
    services?: PanelServices
    tokenPanelMeta?: { mode: 'utools' | 'browser'; version: string }
  }
}
