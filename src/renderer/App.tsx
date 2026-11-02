import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  LayoutDashboard,
  Moon,
  Newspaper,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Sun,
  Table2,
  Wallet,
} from 'lucide-react'
import type { AccountPublic, Bootstrap, Overview as OverviewData } from '../core/types'
import appLogo from '../../logo.png'
import { quotaColorThresholds } from '../core/util/quota'
import { isUtools, services } from './lib/api'
import { AppContext, type Page } from './lib/app-context'
import { DarkContext, useResolvedDark } from './lib/theme'
import { formatDateTime } from './lib/format'
import { useToast } from './components/Toast'
import { Spinner } from './components/Common'
import { AccountModal } from './components/AccountModal'
import { LedgerModal } from './components/LedgerModal'
import { OverviewPage } from './pages/Overview'
import { UsagePage } from './pages/Usage'
import { RecordsPage } from './pages/Records'
import { AccountsPage } from './pages/Accounts'
import { SettingsPage } from './pages/Settings'
import { NewsPage } from './pages/News'

const NAV: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: '总览', icon: LayoutDashboard },
  { id: 'usage', label: '消耗分析', icon: BarChart3 },
  { id: 'records', label: '调用明细', icon: Table2 },
  { id: 'news', label: 'AI 动态', icon: Newspaper },
  { id: 'accounts', label: '账户', icon: Wallet },
  { id: 'settings', label: '设置', icon: SettingsIcon },
]

const PAGE_META: Record<Page, { title: string; subtitle: string }> = {
  overview: { title: '总览', subtitle: '余额、套餐窗口与 token 消耗' },
  usage: { title: '消耗分析', subtitle: '按天、账户、模型拆 token，金额只列实际账单' },
  records: { title: '调用明细', subtitle: '逐笔用量记录，可筛选与导出' },
  news: { title: 'AI 动态', subtitle: '关注厂商与工具的新模型、价格额度和客户端更新' },
  accounts: { title: '账户', subtitle: '厂商接口、订阅套餐、中转站与手动录入' },
  settings: { title: '设置', subtitle: '汇率、告警、价目与数据导入导出' },
}

export type RangeDays = 1 | 7 | 30 | 365

function pageFromHash(): Page {
  const hash = window.location.hash.replace(/^#/, '')
  return NAV.some((item) => item.id === hash) ? (hash as Page) : 'overview'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [overview, setOverview] = useState<OverviewData | null>(null)
  const [page, setPage] = useState<Page>(pageFromHash)
  const [days, setDays] = useState<RangeDays>(30)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [modal, setModal] = useState<{ open: boolean; account?: AccountPublic }>({ open: false })
  const [ledgerAccount, setLedgerAccount] = useState<AccountPublic | null>(null)
  const autoRan = useRef(false)
  const toast = useToast()

  const load = useCallback(async (silent = false) => {
    try {
      const [nextBootstrap, nextOverview] = await Promise.all([
        services.getBootstrap(),
        services.getOverview(days),
      ])
      setBootstrap({ ...nextBootstrap, settings: { ...nextBootstrap.settings, quotaColors: quotaColorThresholds(nextBootstrap.settings.quotaColors) } })
      setOverview(nextOverview)
      setError(null)
    } catch (caught) {
      if (!silent) setError(errorMessage(caught))
      throw caught
    }
  }, [days])

  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((next: Page) => {
    setPage(next)
    if (window.location.hash !== `#${next}`) window.location.hash = next
  }, [])

  useEffect(() => {
    void load().catch(() => undefined)
  }, [load])

  // 只有卸载才作废进行中的异步结果；依赖变化（bootstrap/load/toast 更新）不该打断，
  // 否则 finally 里的 setRefreshing(false) 会被跳过，刷新按钮永远转圈。
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  useEffect(() => {
    if (!bootstrap || autoRan.current) return
    autoRan.current = true
    void (async () => {
      setRefreshing(true)
      try {
        const result = await services.refreshAll(false)
        if (!mountedRef.current) return
        if (result.results.length > 0 || (result.logImport?.imported ?? 0) > 0 || (result.logImport?.updated ?? 0) > 0) {
          await load(true)
          const failed = result.results.filter((item) => item.status === 'error')
          if (failed.length > 0) toast.push(`自动刷新：${failed.length} 个账户失败，详见账户卡片`, 'error')
        }
      } catch (caught) {
        if (mountedRef.current) toast.push(`自动刷新失败：${errorMessage(caught)}`, 'error')
      } finally {
        if (mountedRef.current) setRefreshing(false)
      }
    })()
  }, [bootstrap, load, toast])

  const refreshAll = useCallback(
    async (force = true) => {
      if (refreshing) return
      setRefreshing(true)
      try {
        const result = await services.refreshAll(force)
        if (result.results.length > 0 || (result.logImport?.imported ?? 0) > 0 || (result.logImport?.updated ?? 0) > 0) await load(true)
        const failed = result.results.filter((item) => item.status === 'error')
        const logCount = result.logImport?.imported ?? 0
        const updatedTimings = result.logImport?.updated ?? 0
        const logText = `${logCount > 0 ? `，本机日志 +${logCount}` : ''}${updatedTimings > 0 ? `，补齐 ${updatedTimings} 条计时数据` : ''}`
        if (result.skipped) toast.push(`额度仍在刷新间隔内${logText || '，已跳过接口请求'}`, logCount > 0 || updatedTimings > 0 ? 'ok' : 'info')
        else if (failed.length > 0) {
          toast.push(`刷新完成：${result.results.length - failed.length} 成功，${failed.length} 失败${logText}`, 'error')
        } else {
          toast.push(
            result.results.length > 0 ? `刷新完成：${result.results.length} 个账户${logText}` : `没有启用的账户${logText}`,
            'ok',
          )
        }
      } catch (caught) {
        toast.push(`刷新失败：${errorMessage(caught)}`, 'error')
      } finally {
        setRefreshing(false)
      }
    },
    [refreshing, load, toast],
  )

  const theme = bootstrap?.settings.theme ?? 'system'
  const dark = useResolvedDark(theme)

  // 告警不落库：每次进来按当前状态现算，有就提示一次，用户手动关掉。
  const alertedRef = useRef(new Set<string>())
  useEffect(() => {
    if (!bootstrap) return
    const fresh = (bootstrap.alerts ?? []).filter((alert) => !alertedRef.current.has(alert.dedupeKey))
    if (fresh.length === 0) return
    for (const alert of fresh) {
      alertedRef.current.add(alert.dedupeKey)
      toast.push(alert.message, alert.severity === 'danger' ? 'error' : 'warn', { persistent: true })
    }
  }, [bootstrap, toast])

  const toggleTheme = useCallback(async () => {
    if (!bootstrap) return
    const next = dark ? 'light' : 'dark'
    setBootstrap({ ...bootstrap, settings: { ...bootstrap.settings, theme: next } })
    try {
      await services.updateSettings({ theme: next })
    } catch (caught) {
      toast.push(`主题保存失败：${errorMessage(caught)}`, 'error')
    }
  }, [bootstrap, dark, toast])

  const handleSaved = useCallback(
    async (saved: AccountPublic) => {
      setModal({ open: false })
      toast.push('账户已保存', 'ok')
      await load(true)
      const preset = bootstrap?.providers.find((provider) => provider.id === saved.providerId)
      if (preset && preset.category !== 'manual' && preset.category !== 'custom' && saved.enabled) {
        try {
          const result = await services.refreshAccount(saved.id)
          await load(true)
          toast.push(
            result.status === 'ok' ? `${saved.label} 已刷新` : `${saved.label} 刷新失败：${result.message ?? '未知错误'}`,
            result.status === 'ok' ? 'ok' : 'error',
          )
        } catch (caught) {
          toast.push(`刷新失败：${errorMessage(caught)}`, 'error')
        }
      }
    },
    [bootstrap, load, toast],
  )

  const lastRefreshAt = useMemo(() => {
    if (!bootstrap) return undefined
    if (bootstrap.lastRefresh?.at) return bootstrap.lastRefresh.at
    const values = Object.values(bootstrap.sync).map((item) => item.at)
    return values.length ? Math.max(...values) : undefined
  }, [bootstrap])

  if (error && !bootstrap) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl" style={{ background: 'color-mix(in srgb, var(--danger) 12%, transparent)', color: 'var(--danger)' }}>
          <AlertTriangle size={22} />
        </div>
        <div>
          <div className="text-sm font-semibold">读取出错</div>
          <div className="mt-1 max-w-[460px] text-xs muted">{error}</div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setError(null)
            void load().catch(() => undefined)
          }}
        >
          重试
        </button>
      </div>
    )
  }

  if (!bootstrap || !overview) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Spinner size={22} />
        <div className="text-xs muted">正在读取本地数据…</div>
      </div>
    )
  }

  const meta = PAGE_META[page]
  const contextValue = {
    bootstrap,
    overview,
    page,
    navigate,
    days,
    setDays: (next: number) => setDays(next as RangeDays),
    reload: () => load(true),
    refreshAll,
    refreshing,
    openAccountModal: (account?: AccountPublic) => setModal({ open: true, account }),
    openLedger: (account: AccountPublic) => setLedgerAccount(account),
  }

  return (
    <DarkContext.Provider value={dark}>
      <AppContext.Provider value={contextValue}>
        <div className="flex h-full min-h-0">
          <aside
            className="hidden w-[72px] shrink-0 flex-col border-r md:flex xl:w-[188px]"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          >
            <div className="flex h-[64px] items-center justify-center gap-2.5 px-2 xl:justify-start xl:px-4">
              <img src={appLogo} alt="TokenPanel" width={32} height={32} className="h-8 w-8 shrink-0" />
              <div className="hidden xl:block">
                <div className="text-[13px] font-semibold leading-none">TokenPanel</div>
                <div className="mt-1 text-[10.5px] faint">AI 额度与用量</div>
              </div>
            </div>
            <div className="hidden px-5 pb-2 pt-3 text-[10px] faint xl:block">工作空间</div>
            <nav className="flex flex-col gap-1 px-2 py-1" aria-label="主导航">
              {NAV.map((item) => {
                const Icon = item.icon
                const active = page === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                    aria-current={active ? 'page' : undefined}
                    title={item.label}
                    className="nav-item group flex h-[50px] flex-col items-center justify-center gap-1 rounded-lg px-1 text-[10.5px] leading-none transition-colors xl:h-9 xl:flex-row xl:justify-start xl:gap-2.5 xl:px-3 xl:text-[12.5px]"
                    style={
                      active
                        ? { background: 'var(--accent-soft)', color: 'var(--accent-strong)', fontWeight: 600 }
                        : { color: 'var(--text-muted)' }
                    }
                  >
                    <Icon size={17} strokeWidth={active ? 2.1 : 1.7} />
                    <span className="truncate">{item.label}</span>
                  </button>
                )
              })}
            </nav>
            <div className="mt-auto space-y-1.5 border-t p-3 text-[10.5px] faint xl:p-4" style={{ borderColor: 'var(--border)' }}>
              <div className="hidden truncate xl:block" title={`数据目录：${bootstrap.dataDir}`}>
                {isUtools ? 'uTools 插件' : '浏览器版'} · v{bootstrap.version}
              </div>
              <div className="hidden items-center gap-1.5 xl:flex"><span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--ok)' }} />本地运行 · 数据只存本机</div>
              <button
                type="button"
                className="btn btn-ghost h-8 w-full justify-center px-0 xl:justify-start xl:px-2"
                title={dark ? '浅色模式' : '深色模式'}
                onClick={() => void toggleTheme()}
              >
                {dark ? <Sun size={15} /> : <Moon size={15} />}
                <span className="hidden xl:inline">{dark ? '浅色模式' : '深色模式'}</span>
              </button>
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header
              className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4 md:h-16 md:px-5"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
            >
              <div className="min-w-0">
                <div className="text-[15px] font-semibold">{meta.title}</div>
                <div className="mt-1 hidden truncate text-[10.5px] muted sm:block">{meta.subtitle}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {page !== 'news' ? <><span className="hidden text-[11px] muted lg:inline">
                  {lastRefreshAt ? `上次刷新 ${formatDateTime(lastRefreshAt)}` : '尚未刷新'}
                </span>
                <button type="button" className="btn btn-sm" onClick={() => void refreshAll(true)} disabled={refreshing}>
                  {refreshing ? <Spinner size={13} /> : <RefreshCw size={13} />}
                  {refreshing ? '刷新中' : '全部刷新'}
                </button>
                <button type="button" className="btn btn-primary btn-sm hidden sm:inline-flex" onClick={() => setModal({ open: true })}><Plus size={13} />添加账户</button></> : <span className="hidden items-center gap-1.5 text-[11px] muted sm:flex"><Newspaper size={13} />你的 AI 更新简报</span>}
                <button type="button" className="btn btn-ghost h-8 w-8 p-0 md:hidden" aria-label={dark ? '切换浅色模式' : '切换深色模式'} onClick={() => void toggleTheme()}>
                  {dark ? <Sun size={16} /> : <Moon size={16} />}
                </button>
              </div>
            </header>

            <nav
              className="flex shrink-0 gap-1 border-b px-2 py-1 md:hidden"
              aria-label="主导航"
              style={{ borderColor: 'var(--border)' }}
            >
              {NAV.map((item) => {
                const Icon = item.icon
                const active = page === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                    aria-current={active ? 'page' : undefined}
                    className="nav-item flex h-10 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[10.5px] leading-none sm:h-8 sm:flex-row sm:gap-1.5 sm:text-xs"
                    style={active ? { background: 'var(--accent-soft)', color: 'var(--accent-strong)', fontWeight: 600 } : { color: 'var(--text-muted)' }}
                  >
                    <Icon size={14} />
                    {item.label}
                  </button>
                )
              })}
            </nav>

            <main className="min-h-0 flex-1 overflow-auto">
              {page === 'overview' ? <OverviewPage /> : null}
              {page === 'usage' ? <UsagePage /> : null}
              {page === 'records' ? <RecordsPage /> : null}
              {page === 'news' ? <NewsPage /> : null}
              {page === 'accounts' ? <AccountsPage /> : null}
              {page === 'settings' ? <SettingsPage /> : null}
            </main>
          </div>
        </div>

        <AccountModal
          open={modal.open}
          account={modal.account}
          providers={bootstrap.providers}
          onClose={() => setModal({ open: false })}
          onSaved={handleSaved}
        />
        <LedgerModal
          open={Boolean(ledgerAccount)}
          account={ledgerAccount}
          onClose={() => setLedgerAccount(null)}
          onChanged={async () => {
            await load(true)
          }}
        />
      </AppContext.Provider>
    </DarkContext.Provider>
  )
}
