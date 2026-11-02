import { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import type { AccountPublic, LedgerEntry } from '../../core/types'
import { services } from '../lib/api'
import { Modal } from './Modal'
import { Spinner } from './Common'
import { useToast } from './Toast'
import { formatDateTime, formatMoney } from '../lib/format'

function toLocalInput(ts: number): string {
  const date = new Date(ts)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(ts - offset).toISOString().slice(0, 16)
}

export function LedgerModal({
  open,
  account,
  onClose,
  onChanged,
}: {
  open: boolean
  account: AccountPublic | null
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const toast = useToast()
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [kind, setKind] = useState<LedgerEntry['kind']>('recharge')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<'CNY' | 'USD'>('CNY')
  const [note, setNote] = useState('')
  const [when, setWhen] = useState(toLocalInput(Date.now()))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !account) return
    setLoading(true)
    setError(null)
    services
      .listLedger(account.id)
      .then(setEntries)
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false))
    setCurrency(account.options.manualBalance?.currency ?? 'CNY')
    setAmount('')
    setNote('')
    setWhen(toLocalInput(Date.now()))
  }, [open, account])

  const computed = useMemo(() => {
    if (!account) return null
    const base = account.options.manualBalance
    const firstCurrency = base?.currency ?? entries[0]?.currency ?? 'CNY'
    let total = base?.currency === firstCurrency ? base.amount : 0
    for (const entry of entries) {
      if (entry.currency !== firstCurrency) continue
      if (entry.kind === 'expense') total -= entry.amount
      else total += entry.amount
    }
    return { amount: total, currency: firstCurrency }
  }, [account, entries])

  if (!account) return null

  const submit = async () => {
    const value = Number(amount)
    if (!Number.isFinite(value) || value === 0 || (kind !== 'adjust' && value < 0)) {
      setError(kind === 'adjust' ? '调整金额不能为 0' : '请输入大于 0 的金额')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await services.addLedger({
        accountId: account.id,
        ts: new Date(when).getTime() || Date.now(),
        kind,
        amount: value,
        currency,
        note: note.trim() || undefined,
      })
      const next = await services.listLedger(account.id)
      setEntries(next)
      setAmount('')
      setNote('')
      await onChanged()
      toast.push('记账已保存', 'ok')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="手动记账"
      subtitle={`${account.label} · 充值 / 消费 / 调整`}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>关闭</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void submit()}>
            {saving ? <Spinner size={13} /> : <Plus size={13} />}
            记一笔
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border p-3 text-[11px] muted" style={{ borderColor: 'var(--border)' }}>
          手动账户的余额 = 手动余额 + 充值 − 消费 ± 调整。自动接口账户的记账仅作备注，不会覆盖接口余额。
          {computed ? (
            <div className="mt-1 text-[12px]" style={{ color: 'var(--text)' }}>
              当前计算余额：<span className="num font-semibold">{formatMoney(computed.amount, computed.currency)}</span>
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">类型</label>
            <select className="input" value={kind} onChange={(event) => setKind(event.target.value as LedgerEntry['kind'])}>
              <option value="recharge">充值</option>
              <option value="expense">消费</option>
              <option value="adjust">调整（可负）</option>
            </select>
          </div>
          <div>
            <label className="label">时间</label>
            <input type="datetime-local" className="input" value={when} onChange={(event) => setWhen(event.target.value)} />
          </div>
          <div>
            <label className="label">金额</label>
            <input
              className="input"
              type="number"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>
          <div>
            <label className="label">币种</label>
            <select className="input" value={currency} onChange={(event) => setCurrency(event.target.value as 'CNY' | 'USD')}>
              <option value="CNY">CNY</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="label">备注</label>
            <input className="input" value={note} placeholder="可选，如「支付宝充值」" onChange={(event) => setNote(event.target.value)} />
          </div>
        </div>

        {error ? <div className="text-xs" style={{ color: 'var(--danger)' }}>{error}</div> : null}

        <div>
          <div className="mb-2 text-[12px] font-semibold">最近记录</div>
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-xs muted"><Spinner size={13} /> 加载中</div>
          ) : entries.length === 0 ? (
            <div className="py-6 text-center text-xs muted">还没有记账记录</div>
          ) : (
            <div className="max-h-[240px] overflow-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th className="text-right">金额</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.slice(0, 30).map((entry) => (
                    <tr key={entry.id}>
                      <td className="whitespace-nowrap text-[11px] muted">{formatDateTime(entry.ts)}</td>
                      <td className="text-[11px]">{entry.kind === 'recharge' ? '充值' : entry.kind === 'expense' ? '消费' : '调整'}</td>
                      <td
                        className="text-right num"
                        style={{ color: entry.kind === 'expense' || (entry.kind === 'adjust' && entry.amount < 0) ? 'var(--danger)' : 'var(--ok)' }}
                      >
                        {entry.kind === 'expense' || (entry.kind === 'adjust' && entry.amount < 0) ? '-' : '+'}
                        {formatMoney(Math.abs(entry.amount), entry.currency)}
                      </td>
                      <td className="max-w-[160px] truncate text-[11px] muted" title={entry.note}>{entry.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
