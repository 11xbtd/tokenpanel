import type { Account, AccountPublic, LedgerEntry, QuotaWindow } from '../types'

export function manualBalanceOf(
  account: Account | AccountPublic,
  ledger: LedgerEntry[],
): { amount: number; currency: string } | null {
  const base = account.options.manualBalance
  const entries = ledger.filter((entry) => entry.accountId === account.id)
  const currency = base?.currency ?? entries[0]?.currency
  if (!currency || (!base && entries.length === 0)) return null
  let amount = base?.currency === currency ? base.amount : 0
  for (const entry of entries) {
    if (entry.currency !== currency) continue
    if (entry.kind === 'recharge') amount += entry.amount
    else if (entry.kind === 'expense') amount -= entry.amount
    else amount += entry.amount
  }
  return { amount, currency }
}

export function manualWindowsOf(account: Account | AccountPublic): QuotaWindow[] {
  const windows = account.options.manualPlan?.windows ?? []
  return windows.map((window, index) => {
    const pct = window.total > 0 ? Math.min(100, Math.max(0, (window.used / window.total) * 100)) : 0
    return {
      key: `manual-${index}`,
      label: window.label,
      used: window.used,
      total: window.total,
      unit: window.unit,
      usedPct: pct,
      remainingPct: 100 - pct,
      resetsAt: window.resetsAt,
    }
  })
}
