import { useMemo, useState } from 'react'
import { BookOpen, Pencil, Plus, RefreshCw, Trash2, Wallet } from 'lucide-react'
import type { AccountPublic } from '../../core/types'
import { services } from '../lib/api'
import { useApp } from '../lib/app-context'
import { Badge, EmptyState, Section, Spinner, StatusDot } from '../components/Common'
import { BrandIcon } from '../components/BrandIcon'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { CAPABILITY_LABELS, CATEGORY_LABELS, formatDateTime, STABILITY_LABELS } from '../lib/format'

export function AccountsPage() {
  const { bootstrap, openAccountModal, openLedger, reload, refreshing } = useApp()
  const toast = useToast()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<AccountPublic | null>(null)
  const [purge, setPurge] = useState(false)
  const [removing, setRemoving] = useState(false)

  const providers = useMemo(() => new Map(bootstrap.providers.map((provider) => [provider.id, provider])), [bootstrap.providers])
  const sync = bootstrap.sync

  const toggle = async (account: AccountPublic) => {
    setBusyId(account.id)
    try {
      await services.saveAccount({
        id: account.id,
        providerId: account.providerId,
        label: account.label,
        enabled: !account.enabled,
        auth: {},
        options: account.options,
      })
      await reload()
      toast.push(account.enabled ? '账户已停用' : '账户已启用', 'ok')
    } catch (caught) {
      toast.push(`操作失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const refreshOne = async (account: AccountPublic) => {
    setBusyId(account.id)
    try {
      const result = await services.refreshAccount(account.id)
      await reload()
      toast.push(
        result.status === 'ok' ? `${account.label} 已刷新` : `${account.label}：${result.message ?? '刷新失败'}`,
        result.status === 'ok' ? 'ok' : 'error',
      )
    } catch (caught) {
      toast.push(`刷新失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async () => {
    if (!deleting) return
    setRemoving(true)
    try {
      await services.deleteAccount(deleting.id, purge)
      await reload()
      toast.push('账户已删除', 'ok')
      setDeleting(null)
      setPurge(false)
    } catch (caught) {
      toast.push(`删除失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="space-y-4 p-3 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[12px] muted">
          共 {bootstrap.accounts.length} 个账户 · 已启用 {bootstrap.accounts.filter((account) => account.enabled).length} 个
        </div>
        <button type="button" className="btn btn-primary" onClick={() => openAccountModal()}>
          <Plus size={14} />
          添加账户
        </button>
      </div>

      <div className="rounded-xl border px-3 py-2 text-[11px] muted" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        密钥使用 AES-256-GCM 加密，只保存在本机；接口失败时保留上次成功数据，不会清空卡片。标记「实验性」的套餐接口可能随时变更。
      </div>

      {bootstrap.accounts.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Wallet}
            title="还没有账户"
            description="从预制厂商里选择即可，接口地址和余额查询路径已经填好；Gemini、Groq 等没有公开余额接口的厂商可用手动录入。"
            action={
              <button type="button" className="btn btn-primary" onClick={() => openAccountModal()}>
                <Plus size={14} />
                添加账户
              </button>
            }
          />
        </div>
      ) : (
        <Section title="账户列表" bodyClassName="p-0">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>账户</th>
                  <th>能力</th>
                  <th>凭证</th>
                  <th>最近状态</th>
                  <th className="text-right">启用</th>
                  <th className="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {bootstrap.accounts.map((account) => {
                  const preset = providers.get(account.providerId)
                  const state = sync[account.id]
                  const masked = Object.values(account.authMasked).filter(Boolean)
                  const busy = busyId === account.id || removing
                  return (
                    <tr key={account.id}>
                      <td>
                        <div className="flex items-center gap-2">
                          <BrandIcon
                            providerId={account.providerId}
                            label={account.label}
                            color="var(--accent-strong)"
                            size={32}
                            radius={9}
                          />
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium">{account.label}</div>
                            <div className="mt-0.5 text-[11px] muted">
                              {preset?.name ?? account.providerId} · {preset ? CATEGORY_LABELS[preset.category] : '—'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="flex max-w-[260px] flex-wrap gap-1">
                          {preset ? (
                            <Badge tone={preset.stability === 'experimental' ? 'warn' : preset.stability === 'manual' ? 'default' : 'accent'}>
                              {STABILITY_LABELS[preset.stability]}
                            </Badge>
                          ) : null}
                          {preset && preset.category !== 'manual'
                            ? preset.capabilities.map((capability) => <Badge key={capability}>{CAPABILITY_LABELS[capability]}</Badge>)
                            : null}
                          {account.options.manualPlan?.windows?.length ? <Badge>套餐 {account.options.manualPlan.windows.length}</Badge> : null}
                        </div>
                      </td>
                      <td className="max-w-[170px] truncate text-[11px] muted" title={masked.join(' / ')}>
                        {masked.length > 0 ? masked.join(' / ') : preset?.category === 'custom' ? '自定义请求头' : '手动录入'}
                      </td>
                      <td>
                        <div className="flex items-start gap-1.5">
                          <span className="mt-1"><StatusDot status={account.enabled ? state?.status ?? 'never' : 'disabled'} /></span>
                          <div className="min-w-0">
                            <div className="text-[11px]">{state?.at ? formatDateTime(state.at) : '未刷新'}</div>
                            {state?.message ? (
                              <div className="max-w-[260px] truncate text-[10px]" style={{ color: 'var(--danger)' }} title={state.message}>
                                {state.message}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className="text-right">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={account.enabled}
                          disabled={busy}
                          className="relative inline-block h-5 w-9 rounded-full align-middle transition-colors"
                          style={{ background: account.enabled ? 'var(--accent)' : 'var(--border-strong)' }}
                          onClick={() => void toggle(account)}
                        >
                          <span
                            className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
                            style={{ left: account.enabled ? 18 : 2 }}
                          />
                        </button>
                      </td>
                      <td className="text-right">
                        <div className="flex justify-end gap-0.5">
                          <button type="button" className="btn btn-ghost h-7 w-7 p-0" title="刷新" disabled={busy} onClick={() => void refreshOne(account)}>
                            {busyId === account.id || refreshing ? <Spinner size={13} /> : <RefreshCw size={13} />}
                          </button>
                          <button type="button" className="btn btn-ghost h-7 w-7 p-0" title="记账" onClick={() => openLedger(account)}>
                            <BookOpen size={13} />
                          </button>
                          <button type="button" className="btn btn-ghost h-7 w-7 p-0" title="编辑" onClick={() => openAccountModal(account)}>
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost h-7 w-7 p-0"
                            title="删除"
                            onClick={() => {
                              setPurge(false)
                              setDeleting(account)
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Modal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="删除账户"
        subtitle={deleting?.label}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setDeleting(null)}>取消</button>
            <button type="button" className="btn btn-danger" disabled={removing} onClick={() => void remove()}>
              {removing ? <Spinner size={13} /> : <Trash2 size={13} />}
              删除
            </button>
          </>
        }
      >
        <div className="space-y-3 text-[12px]">
          <p>删除后该账户将不再刷新，密钥会从配置中移除。</p>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={purge} onChange={(event) => setPurge(event.target.checked)} />
            <span>
              同时删除历史数据
              <span className="block text-[11px] faint">包括用量明细、余额快照和手动记账，删除后不可恢复。</span>
            </span>
          </label>
        </div>
      </Modal>
    </div>
  )
}
