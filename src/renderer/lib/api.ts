import type { PanelServices } from '../../core/bridge'

const bridge = (globalThis as any).window?.services as PanelServices | undefined
/** uTools 以 file:// 加载页面；桥接缺失说明 preload 加载失败，此时不能再退回 HTTP。 */
const pluginWithoutBridge =
  typeof window !== 'undefined' && window.location?.protocol === 'file:' && !bridge

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (pluginWithoutBridge) {
    throw new Error('插件桥接未加载：preload.js 执行失败，请检查产物目录 package.json 是否声明 "type": "commonjs"')
  }
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body = JSON.parse(text)
      message = body?.error?.message ?? message
    } catch {
      // 保留 HTTP 状态
    }
    throw new Error(message)
  }
  return (text ? JSON.parse(text) : undefined) as T
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

async function downloadText(filename: string, content: string): Promise<void> {
  const blob = new Blob([content], {
    type: filename.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const httpServices: PanelServices = {
  getBootstrap: () => request('/api/bootstrap'),
  saveAccount: (input) =>
    request(input.id ? `/api/accounts/${encodeURIComponent(input.id)}` : '/api/accounts', {
      method: input.id ? 'PATCH' : 'POST',
      body: JSON.stringify(input),
    }),
  deleteAccount: async (id, purge) => {
    await request(`/api/accounts/${encodeURIComponent(id)}${purge ? '?purge=1' : ''}`, { method: 'DELETE' })
  },
  updateSettings: (patch) => request('/api/settings', { method: 'POST', body: JSON.stringify(patch) }),
  refreshAll: (force) => request('/api/refresh-all', { method: 'POST', body: JSON.stringify({ force }) }),
  refreshAccount: (id) => request(`/api/accounts/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
  scanLogs: () => request('/api/logs/scan', { method: 'POST' }),
  rebuildLogStats: () => request('/api/logs/rebuild', { method: 'POST' }),
  getOverview: (days) => request(`/api/overview${query({ days })}`),
  getNews: (force) => request(`/api/news${force ? '?force=1' : ''}`),
  updateNewsPreferences: (input) => request('/api/news/preferences', { method: 'POST', body: JSON.stringify(input) }),
  getRecords: (filters) =>
    request(
      `/api/usage${query({
        from: filters.from,
        to: filters.to,
        accountId: filters.accountId,
        model: filters.model,
        source: filters.source,
        billingMode: filters.billingMode,
        page: filters.page,
        pageSize: filters.pageSize,
      })}`,
    ),
  addLedger: (entry) => request('/api/ledger', { method: 'POST', body: JSON.stringify(entry) }),
  listLedger: (accountId) => request(`/api/ledger${query({ accountId })}`),
  importUsageCsv: (text, defaultAccountId) =>
    request('/api/import/usage', { method: 'POST', body: JSON.stringify({ text, defaultAccountId }) }),
  importLedgerCsv: (text) => request('/api/import/ledger', { method: 'POST', body: JSON.stringify({ text }) }),
  importBackup: (text) => request('/api/import/backup', { method: 'POST', body: JSON.stringify({ text }) }),
  exportUsageCsv: async () => {
    const response = await fetch('/api/export/usage')
    if (!response.ok) throw new Error(`导出失败：HTTP ${response.status}`)
    return response.text()
  },
  exportBackup: async (includeSecrets) => {
    const response = await fetch(`/api/export/backup${includeSecrets ? '?secrets=1' : ''}`)
    if (!response.ok) throw new Error(`导出失败：HTTP ${response.status}`)
    return response.text()
  },
  getDiagnostics: () => request('/api/diagnostics'),
  getPriceOverrides: () => request('/api/prices/overrides'),
  savePriceOverrides: (file) => request('/api/prices/overrides', { method: 'PUT', body: JSON.stringify(file) }),
  refreshFx: (force) => request('/api/fx/refresh', { method: 'POST', body: JSON.stringify({ force }) }),
  testWebhook: (id) => request('/api/webhook/test', { method: 'POST', body: JSON.stringify({ id }) }),
  saveFile: (filename, content) => {
    downloadText(filename, content)
    return Promise.resolve({ saved: true })
  },
  openExternal: (url) => {
    if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
  },
}

export const services: PanelServices = bridge ?? httpServices
export const isUtools = Boolean(bridge)
