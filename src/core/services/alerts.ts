import { randomUUID } from 'node:crypto'
import type { AccountPublic, AlertEvent, ProviderPreset, QuotaSnapshot, Settings, SyncState } from '../types'
import { dateKey } from '../util/time'

interface AlertArgs {
  accounts: AccountPublic[]
  providers: Map<string, ProviderPreset>
  latest: Map<string, QuotaSnapshot>
  sync: Record<string, SyncState>
  settings: Settings
  /** 今日实际计费金额（显示币种）；价目表估算的消耗不参与日限额告警。 */
  todayActualDisplay: number
  now?: number
}

export function evaluateAlerts(args: AlertArgs): AlertEvent[] {
  if (!args.settings.alerts.enabled) return []
  const now = args.now ?? Date.now()
  const events: AlertEvent[] = []
  const push = (event: Omit<AlertEvent, 'id' | 'at'>) => {
    events.push({ ...event, id: randomUUID(), at: now })
  }

  for (const account of args.accounts) {
    if (!account.enabled) continue
    const balanceSnapshot = args.latest.get(`${account.id}:balance`) ?? args.latest.get(`${account.id}:relay`)
    const planSnapshot = args.latest.get(`${account.id}:plan`)
    const balanceThreshold = account.options.thresholds?.balanceBelow ?? args.settings.alerts.balanceBelowDefault
    if (balanceThreshold !== undefined && balanceThreshold > 0 && balanceSnapshot?.balance !== undefined) {
      if (balanceSnapshot.balance < balanceThreshold) {
        const severity = balanceSnapshot.balance <= 0 ? 'danger' : 'warn'
        push({
          accountId: account.id,
          type: 'balance_low',
          severity,
          message: `${account.label} 余额 ${balanceSnapshot.balance.toFixed(2)} ${balanceSnapshot.currency ?? ''}，低于阈值 ${balanceThreshold}`,
          dedupeKey: `balance_low:${account.id}`,
        })
      }
    }
    const remainingThreshold =
      account.options.thresholds?.remainingBelowPct ?? args.settings.alerts.remainingBelowPct
    const windows = planSnapshot?.windows ?? balanceSnapshot?.windows ?? []
    for (const window of windows) {
      if (window.remainingPct === undefined) continue
      if (window.remainingPct < remainingThreshold) {
        push({
          accountId: account.id,
          type: 'plan_low',
          severity: window.remainingPct <= 5 ? 'danger' : 'warn',
          message: `${account.label} · ${window.label} 剩余 ${window.remainingPct.toFixed(0)}%，低于阈值 ${remainingThreshold}%`,
          dedupeKey: `plan_low:${account.id}:${window.key}`,
        })
      }
    }
    const sync = args.sync[account.id]
    if (sync?.status === 'error' && sync.message) {
      const auth = sync.code === 'auth'
      push({
        accountId: account.id,
        type: auth ? 'auth_error' : 'fetch_error',
        severity: auth ? 'danger' : 'warn',
        message: `${account.label} 刷新失败：${sync.message}`,
        dedupeKey: `${auth ? 'auth_error' : 'fetch_error'}:${account.id}`,
      })
    }
  }

  const daily = args.settings.alerts.dailySpendAbove
  if (daily !== undefined && daily > 0 && args.todayActualDisplay > daily) {
    push({
      type: 'spend_high',
      severity: 'warn',
      message: `今日实际计费 ${args.todayActualDisplay.toFixed(2)}，超过日限额 ${daily}`,
      dedupeKey: `spend_high:${dateKey(now)}`,
    })
  }

  return events
}
