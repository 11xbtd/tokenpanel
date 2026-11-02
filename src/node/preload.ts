import { promises as fs } from 'node:fs'
import path from 'node:path'
import { TokenPanelApp } from '../core/services/app'
import type { PanelServices } from '../core/bridge'
import { VERSION } from '../core/storage/defaults'
import { redact } from '../core/util/redact'
import { defaultDataDir, legacyDataDirs } from '../core/paths'
import { migrateLegacyData } from '../core/storage/migrate'

declare const window: Window & { services?: PanelServices; tokenPanelMeta?: unknown }

const utools = (globalThis as any).utools as
  | {
      getPath?: (name: string) => string
      showNotification?: (message: string) => void
      shellOpenExternal?: (url: string) => void
      showSaveDialog?: (options: Record<string, unknown>) => string | Promise<string>
    }
  | undefined

function legacyDirs(): string[] {
  const dirs = legacyDataDirs()
  try {
    const userData = utools?.getPath?.('userData')
    if (userData) dirs.unshift(path.join(userData, 'token-panel-data'))
  } catch {
    // 旧版 uTools 目录拿不到就跳过
  }
  return dirs
}

function dataDir(): string {
  return defaultDataDir()
}

let appPromise: Promise<TokenPanelApp> | undefined
let startupTrace: ((stage: string, detail?: unknown) => void) | undefined

function getApp(): Promise<TokenPanelApp> {
  if (!appPromise) {
    appPromise = (async () => {
      const dir = dataDir()
      await migrateLegacyData(dir, legacyDirs())
      return TokenPanelApp.create({
        dataDir: dir,
        mode: 'utools',
        version: VERSION,
        startupTrace: (stage, detail) => startupTrace?.(stage, detail),
        notify: (title) => {
          try {
            utools?.showNotification?.(title)
          } catch {
            // 通知失败不影响刷新
          }
        },
      })
    })()
    appPromise.catch(() => {
      appPromise = undefined
    })
  }
  return appPromise
}

const services: PanelServices = {
  getBootstrap: async () => (await getApp()).getBootstrap(),
  saveAccount: async (input) => (await getApp()).saveAccount(input),
  deleteAccount: async (id, purge) => (await getApp()).deleteAccount(id, purge),
  updateSettings: async (patch) => (await getApp()).updateSettings(patch),
  refreshAll: async (force) => (await getApp()).refreshAll(force),
  refreshAccount: async (id) => (await getApp()).refreshAccount(id),
  scanLogs: async () => (await getApp()).scanLogs(),
  rebuildLogStats: async () => (await getApp()).rebuildLogStats(),
  getOverview: async (days) => (await getApp()).getOverview(days),
  getNews: async (force) => (await getApp()).getNews(force),
  updateNewsPreferences: async (input) => (await getApp()).updateNewsPreferences(input),
  getRecords: async (query) => (await getApp()).getRecords(query),
  addLedger: async (entry) => (await getApp()).addLedger(entry),
  listLedger: async (accountId) => (await getApp()).listLedger(accountId),
  importUsageCsv: async (text, defaultAccountId) => (await getApp()).importUsageCsv(text, defaultAccountId),
  importLedgerCsv: async (text) => (await getApp()).importLedgerCsv(text),
  importBackup: async (text) => (await getApp()).importBackup(text),
  exportUsageCsv: async () => (await getApp()).exportUsageCsv(),
  exportBackup: async (includeSecrets) => (await getApp()).exportBackup(includeSecrets),
  getDiagnostics: async () => (await getApp()).diagnostics(),
  getPriceOverrides: async () => (await getApp()).getPriceOverrides(),
  savePriceOverrides: async (file) => (await getApp()).savePriceOverrides(file),
  refreshFx: async (force) => (await getApp()).refreshFx(force),
  testWebhook: async (id) => (await getApp()).testWebhook(id),
  saveFile: async (filename, content) => {
    try {
      if (typeof utools?.showSaveDialog !== 'function') {
        return { saved: false, error: '当前 uTools 版本不支持保存对话框' }
      }
      const target = await Promise.resolve(
        utools.showSaveDialog({ title: '导出 TokenPanel 数据', defaultPath: filename, buttonLabel: '保存' }),
      )
      if (!target) return { saved: false }
      await fs.writeFile(target, content, 'utf8')
      return { saved: true, path: target }
    } catch (error) {
      return { saved: false, error: redact(error) }
    }
  },
  openExternal: (url) => {
    if (!/^https?:\/\//i.test(url)) return
    try {
      utools?.shellOpenExternal?.(url)
    } catch {
      window.open(url, '_blank', 'noopener')
    }
  },
}

export function installPreload(trace?: (stage: string, detail?: unknown) => void): void {
  startupTrace = trace
  window.services = services
  window.tokenPanelMeta = { mode: 'utools', version: VERSION }
}
