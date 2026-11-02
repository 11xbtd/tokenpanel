import { createContext, useContext } from 'react'
import type { AccountPublic, Bootstrap, Overview } from '../../core/types'

export type Page = 'overview' | 'usage' | 'records' | 'news' | 'rankings' | 'accounts' | 'settings'

export interface AppContextValue {
  bootstrap: Bootstrap
  overview: Overview
  page: Page
  navigate: (page: Page) => void
  /** 全站共用的时间区间（天）：总览和消耗分析看同一段数据。 */
  days: number
  setDays: (days: number) => void
  reload: () => Promise<void>
  refreshAll: (force?: boolean) => Promise<void>
  refreshing: boolean
  openAccountModal: (account?: AccountPublic) => void
  openLedger: (account: AccountPublic) => void
}

export const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('AppContext 未初始化')
  return value
}
