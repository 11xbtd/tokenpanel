import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ExternalLink, KeyRound, Plus, Trash2 } from 'lucide-react'
import type {
  AccountOptions,
  AccountPublic,
  CustomHttpConfig,
  ManualWindow,
  ProviderPreset,
} from '../../core/types'
import { isUtools, services } from '../lib/api'
import { Badge, Spinner } from './Common'
import { Modal } from './Modal'
import { CATEGORY_LABELS, STABILITY_LABELS } from '../lib/format'

function toLocalInput(ts?: number): string {
  if (!ts) return ''
  const offset = new Date(ts).getTimezoneOffset() * 60_000
  return new Date(ts - offset).toISOString().slice(0, 16)
}

function fromLocalInput(value: string): number | undefined {
  if (!value) return undefined
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : undefined
}

function Field({ label, hint, action, children }: { label: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      {action ? (
        <div className="flex items-center justify-between gap-2">
          <label className="label">{label}</label>
          {action}
        </div>
      ) : (
        <label className="label">{label}</label>
      )}
      {children}
      {hint ? <div className="mt-1 text-[10px] faint">{hint}</div> : null}
    </div>
  )
}

/** 一键跳到厂商控制台创建 / 复制 Key；uTools 里走外部浏览器打开。 */
function KeyLink({ url, compact = false }: { url: string; compact?: boolean }) {
  return (
    <a
      className="key-link"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title="前往厂商控制台创建 / 复制 Key"
      onClick={(event) => {
        if (isUtools) {
          event.preventDefault()
          services.openExternal(url)
        }
      }}
    >
      <KeyRound size={compact ? 10 : 11} />
      获取 Key
      <ExternalLink size={compact ? 9 : 10} />
    </a>
  )
}

const EMPTY_CUSTOM: CustomHttpConfig = { method: 'GET' }

/**
 * 到期日字段一直可填（新增时就能登记），只是叫法不同：
 * 有套餐窗口的厂商填「套餐到期日」，按量类填「充值包到期日」。
 */
export function expiryFieldLabel(preset: ProviderPreset): string {
  const hasPlanWindow =
    preset.category === 'plan' ||
    preset.category === 'manual' ||
    preset.category === 'custom' ||
    preset.capabilities.includes('plan')
  return hasPlanWindow ? '套餐到期日' : '充值包到期日'
}

export function AccountModal({
  open,
  account,
  providers,
  onClose,
  onSaved,
  onDeleted,
}: {
  open: boolean
  account?: AccountPublic
  providers: ProviderPreset[]
  onClose: () => void
  onSaved: (account: AccountPublic) => Promise<void> | void
  onDeleted?: () => void
}) {
  const [providerId, setProviderId] = useState('deepseek')
  const [label, setLabel] = useState('')
  const [auth, setAuth] = useState<Record<string, string>>({})
  const [baseUrl, setBaseUrl] = useState('')
  const [quotaPerUnit, setQuotaPerUnit] = useState('')
  const [balanceBelow, setBalanceBelow] = useState('')
  const [remainingBelow, setRemainingBelow] = useState('')
  const [manualAmount, setManualAmount] = useState('')
  const [manualCurrency, setManualCurrency] = useState<'CNY' | 'USD'>('CNY')
  const [planLabel, setPlanLabel] = useState('')
  const [planExpiresAt, setPlanExpiresAt] = useState('')
  const [windows, setWindows] = useState<ManualWindow[]>([])
  const [custom, setCustom] = useState<CustomHttpConfig>(EMPTY_CUSTOM)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!open) return
    const initialId = account?.providerId ?? 'deepseek'
    setProviderId(initialId)
    setLabel(account?.label ?? '')
    setAuth({})
    setBaseUrl(account?.options.baseUrl ?? '')
    setQuotaPerUnit(account?.options.quotaPerUnit ? String(account.options.quotaPerUnit) : '')
    setBalanceBelow(account?.options.thresholds?.balanceBelow !== undefined ? String(account.options.thresholds.balanceBelow) : '')
    setRemainingBelow(
      account?.options.thresholds?.remainingBelowPct !== undefined ? String(account.options.thresholds.remainingBelowPct) : '',
    )
    setManualAmount(account?.options.manualBalance ? String(account.options.manualBalance.amount) : '')
    setManualCurrency(account?.options.manualBalance?.currency ?? 'CNY')
    setPlanLabel(account?.options.manualPlan?.planLabel ?? '')
    setPlanExpiresAt(account?.options.planExpiresAt ? toLocalInput(account.options.planExpiresAt) : '')
    setWindows(account?.options.manualPlan?.windows?.map((window) => ({ ...window })) ?? [])
    setCustom(account?.options.custom ? { ...account.options.custom } : EMPTY_CUSTOM)
    setShowAdvanced(false)
    setError(null)
    setConfirmDelete(false)
  }, [open, account?.id])

  const preset = useMemo(() => providers.find((provider) => provider.id === providerId) ?? providers[0], [providers, providerId])
  const groups = useMemo(() => {
    const order = ['国内厂商', '订阅套餐', '国际厂商', '聚合与中转', '国内云厂商', '高级']
    return [...new Set(providers.map((provider) => provider.group))].sort((a, b) => {
      const left = order.indexOf(a)
      const right = order.indexOf(b)
      return (left === -1 ? 99 : left) - (right === -1 ? 99 : right)
    })
  }, [providers])
  const isManual = preset?.category === 'manual'
  const isCustom = preset?.category === 'custom'
  const expiryLabel = preset ? expiryFieldLabel(preset) : '套餐到期日'

  const changeProvider = (id: string) => {
    const next = providers.find((provider) => provider.id === id)
    setProviderId(id)
    setBaseUrl(next?.baseUrl ?? '')
    setQuotaPerUnit(next?.quotaPerUnit ? String(next.quotaPerUnit) : '')
    setAuth({})
    setWindows([])
    setPlanLabel('')
    setPlanExpiresAt('')
    setManualAmount('')
    setCustom(EMPTY_CUSTOM)
    setError(null)
  }

  const save = async () => {
    if (!preset) return
    setSaving(true)
    setError(null)
    try {
      const options: AccountOptions = {}
      if (baseUrl.trim()) options.baseUrl = baseUrl.trim()
      if (quotaPerUnit.trim()) {
        const value = Number(quotaPerUnit)
        if (Number.isFinite(value) && value > 0) options.quotaPerUnit = value
      }
      const expiry = fromLocalInput(planExpiresAt)
      if (expiry !== undefined) options.planExpiresAt = expiry

      const thresholds: NonNullable<AccountOptions['thresholds']> = {}
      if (balanceBelow.trim() !== '') thresholds.balanceBelow = Number(balanceBelow)
      if (remainingBelow.trim() !== '') thresholds.remainingBelowPct = Number(remainingBelow)
      if (Object.keys(thresholds).length > 0) options.thresholds = thresholds

      if (isManual) {
        if (manualAmount.trim() !== '') options.manualBalance = { amount: Number(manualAmount), currency: manualCurrency }
        const validWindows = windows
          .filter((window) => Number.isFinite(Number(window.total)) && Number(window.total) > 0)
          .map((window) => ({
            label: window.label?.trim() || '额度',
            total: Number(window.total),
            used: Number.isFinite(Number(window.used)) ? Number(window.used) : 0,
            unit: window.unit?.trim() || undefined,
            resetsAt: window.resetsAt,
          }))
        if (validWindows.length > 0) {
          options.manualPlan = { planLabel: planLabel.trim() || undefined, windows: validWindows }
        }
      }
      if (isCustom) {
        options.custom = {
          ...custom,
          method: custom.method === 'POST' ? 'POST' : 'GET',
          headers: custom.headers?.trim() || undefined,
          body: custom.body?.trim() || undefined,
        }
      }

      const authPayload: Record<string, string> = {}
      for (const field of preset.auth) {
        const value = auth[field.key]?.trim()
        if (value) authPayload[field.key] = value
      }

      const saved = await services.saveAccount({
        id: account?.id,
        providerId,
        label: label.trim() || undefined,
        enabled: account?.enabled ?? true,
        auth: authPayload,
        options,
      })
      await onSaved(saved)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!account) return
    setDeleting(true)
    setError(null)
    try {
      await services.deleteAccount(account.id, false)
      onDeleted?.()
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setDeleting(false)
    }
  }

  if (!preset) return null

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={account ? `编辑 ${account.label}` : '添加账户'}
      subtitle={preset.name}
      footer={
        <>
          {account ? (
            <button
              type="button"
              className={`btn mr-auto ${confirmDelete ? 'btn-danger' : 'btn-ghost'}`}
              disabled={deleting || saving}
              title="删除该账户（保留历史数据）"
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true)
                  return
                }
                void remove()
              }}
            >
              {deleting ? <Spinner size={13} /> : <Trash2 size={13} />}
              {confirmDelete ? '确认删除？' : '删除账户'}
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? <Spinner size={13} /> : null}
            保存
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={preset.stability === 'experimental' ? 'warn' : preset.stability === 'manual' ? 'default' : 'accent'}>
              {STABILITY_LABELS[preset.stability]}
            </Badge>
            <Badge>{CATEGORY_LABELS[preset.category]}</Badge>
            {preset.docsUrl ? (
              <button
                type="button"
                className="btn btn-ghost h-6 px-1.5 text-[11px]"
                onClick={() => services.openExternal(preset.docsUrl!)}
              >
                接口文档 <ExternalLink size={11} />
              </button>
            ) : null}
            {preset.keyUrl && preset.auth.length === 0 ? <KeyLink url={preset.keyUrl} compact /> : null}
          </div>
          {preset.notes ? <div className="mt-2 text-[11px] muted">{preset.notes}</div> : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="厂商">
            <select
              className="input"
              value={providerId}
              disabled={Boolean(account)}
              onChange={(event) => changeProvider(event.target.value)}
            >
              {groups.map((group) => (
                <optgroup key={group} label={group}>
                  {providers.filter((provider) => provider.group === group).map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="显示名称" hint="留空则使用厂商名称">
            <input className="input" value={label} placeholder={preset.name} onChange={(event) => setLabel(event.target.value)} />
          </Field>
        </div>

        <Field
          label={expiryLabel}
          hint="订阅到期 / 续费日。多数厂商的额度接口不返回订阅有效期（MiniMax 只在控制台显示），手动登记后卡片会显示到期倒计时。"
        >
          <input className="input" type="datetime-local" value={planExpiresAt} onChange={(event) => setPlanExpiresAt(event.target.value)} />
        </Field>

        {preset.auth.length > 0 ? (
          <div className="space-y-3">
            {preset.auth.map((field, index) => (
              <Field
                key={field.key}
                label={`${field.label}${field.required ? '' : '（可选）'}`}
                hint={field.help}
                action={index === 0 && preset.keyUrl ? <KeyLink url={preset.keyUrl} /> : undefined}
              >
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={auth[field.key] ?? ''}
                  placeholder={
                    account?.authMasked?.[field.key]
                      ? `${account.authMasked[field.key]}（已配置，留空不修改）`
                      : field.placeholder
                  }
                  onChange={(event) => setAuth((current) => ({ ...current, [field.key]: event.target.value }))}
                />
              </Field>
            ))}
          </div>
        ) : null}

        {isManual ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="手动余额" hint="之后可用「记账」增减">
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  placeholder="留空表示只记套餐"
                  value={manualAmount}
                  onChange={(event) => setManualAmount(event.target.value)}
                />
              </Field>
              <Field label="币种">
                <select className="input" value={manualCurrency} onChange={(event) => setManualCurrency(event.target.value as 'CNY' | 'USD')}>
                  <option value="CNY">CNY</option>
                  <option value="USD">USD</option>
                </select>
              </Field>
              <Field label="套餐名称">
                <input className="input" value={planLabel} placeholder="如 Coding Plan" onChange={(event) => setPlanLabel(event.target.value)} />
              </Field>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] font-semibold">套餐窗口（可选）</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setWindows((current) => [...current, { label: '每日请求', total: 0, used: 0, unit: '次' }])}
                >
                  <Plus size={12} />
                  添加窗口
                </button>
              </div>
              {windows.length === 0 ? (
                <div className="rounded-lg border px-3 py-3 text-[11px] faint" style={{ borderColor: 'var(--border)' }}>
                  例如：5 小时窗口 总 100 次 / 已用 42 次；每日请求 1200 / 420。
                </div>
              ) : (
                <div className="space-y-2">
                  {windows.map((window, index) => (
                    <div key={index} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] font-semibold">窗口 {index + 1}</span>
                        <button
                          type="button"
                          className="btn btn-ghost h-6 w-6 p-0"
                          onClick={() => setWindows((current) => current.filter((_, i) => i !== index))}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          className="input h-8 text-xs"
                          placeholder="名称"
                          value={window.label}
                          onChange={(event) =>
                            setWindows((current) => current.map((item, i) => (i === index ? { ...item, label: event.target.value } : item)))
                          }
                        />
                        <input
                          className="input h-8 text-xs"
                          placeholder="单位，如 次 / token"
                          value={window.unit ?? ''}
                          onChange={(event) =>
                            setWindows((current) => current.map((item, i) => (i === index ? { ...item, unit: event.target.value } : item)))
                          }
                        />
                        <input
                          className="input h-8 text-xs"
                          type="number"
                          placeholder="总量"
                          value={window.total || ''}
                          onChange={(event) =>
                            setWindows((current) => current.map((item, i) => (i === index ? { ...item, total: Number(event.target.value) } : item)))
                          }
                        />
                        <input
                          className="input h-8 text-xs"
                          type="number"
                          placeholder="已用"
                          value={window.used || ''}
                          onChange={(event) =>
                            setWindows((current) => current.map((item, i) => (i === index ? { ...item, used: Number(event.target.value) } : item)))
                          }
                        />
                        <input
                          className="input col-span-2 h-8 text-xs"
                          type="datetime-local"
                          value={toLocalInput(window.resetsAt)}
                          onChange={(event) =>
                            setWindows((current) =>
                              current.map((item, i) =>
                                i === index ? { ...item, resetsAt: fromLocalInput(event.target.value) } : item,
                              ),
                            )
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {isCustom ? (
          <div className="space-y-3 rounded-xl border p-3" style={{ borderColor: 'var(--border)' }}>
            <div className="text-[12px] font-semibold">接口与 JSON 路径</div>
            <Field label="请求 URL" hint="支持 {{apiKey}} 占位符">
              <input className="input" value={baseUrl} placeholder="https://your-api.example.com/balance" onChange={(event) => setBaseUrl(event.target.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="请求方法">
                <select className="input" value={custom.method} onChange={(event) => setCustom({ ...custom, method: event.target.value as 'GET' | 'POST' })}>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </select>
              </Field>
              <Field label="套餐名路径">
                <input className="input" value={custom.planLabelPath ?? ''} placeholder="data.plan" onChange={(event) => setCustom({ ...custom, planLabelPath: event.target.value })} />
              </Field>
              <Field label="余额路径" hint="点路径，如 data.balance">
                <input className="input" value={custom.balancePath ?? ''} placeholder="data.balance" onChange={(event) => setCustom({ ...custom, balancePath: event.target.value })} />
              </Field>
              <Field label="币种路径">
                <input className="input" value={custom.currencyPath ?? ''} placeholder="data.currency" onChange={(event) => setCustom({ ...custom, currencyPath: event.target.value })} />
              </Field>
              <Field label="套餐窗口数组路径">
                <input className="input" value={custom.windowsPath ?? ''} placeholder="data.windows" onChange={(event) => setCustom({ ...custom, windowsPath: event.target.value })} />
              </Field>
              <Field label="窗口名称路径">
                <input className="input" value={custom.windowLabelPath ?? ''} placeholder="label" onChange={(event) => setCustom({ ...custom, windowLabelPath: event.target.value })} />
              </Field>
              <Field label="窗口已用路径">
                <input className="input" value={custom.windowUsedPath ?? ''} placeholder="used" onChange={(event) => setCustom({ ...custom, windowUsedPath: event.target.value })} />
              </Field>
              <Field label="窗口总量路径">
                <input className="input" value={custom.windowTotalPath ?? ''} placeholder="total" onChange={(event) => setCustom({ ...custom, windowTotalPath: event.target.value })} />
              </Field>
              <Field label="窗口重置时间路径">
                <input className="input" value={custom.windowResetPath ?? ''} placeholder="resetsAt" onChange={(event) => setCustom({ ...custom, windowResetPath: event.target.value })} />
              </Field>
            </div>
            <Field label="请求头 JSON" hint='如 {"Authorization":"Bearer {{apiKey}}"}；请用占位符，直接粘贴的密钥会以明文保存在本地配置里'>
              <textarea className="input" rows={3} value={custom.headers ?? ''} onChange={(event) => setCustom({ ...custom, headers: event.target.value })} />
            </Field>
            {custom.method === 'POST' ? (
              <Field label="请求体" hint="支持 {{apiKey}} 占位符">
                <textarea className="input" rows={3} value={custom.body ?? ''} onChange={(event) => setCustom({ ...custom, body: event.target.value })} />
              </Field>
            ) : null}
          </div>
        ) : null}

        {!isManual ? (
          <div className="space-y-3">
            {!isCustom ? (
              <Field
                label={`Base URL${preset.baseUrlRequired ? '（必填）' : '（可选）'}`}
                hint="留空使用预设地址；MiniMax 国际站等可在这里覆盖"
              >
                <input className="input" value={baseUrl} placeholder={preset.baseUrl || 'https://...'} onChange={(event) => setBaseUrl(event.target.value)} />
              </Field>
            ) : null}
            <button
              type="button"
              className="flex items-center gap-1 text-[12px] font-medium"
              style={{ color: 'var(--text-muted)' }}
              onClick={() => setShowAdvanced((value) => !value)}
            >
              高级设置
              <ChevronDown size={14} style={{ transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
            </button>
            {showAdvanced ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {preset.quotaPerUnit || providerId === 'newapi' ? (
                  <Field label="quotaPerUnit" hint="New API / One API 默认 500000（50 万 quota = 1 美元）">
                    <input className="input" type="number" value={quotaPerUnit} placeholder={String(preset.quotaPerUnit ?? 500000)} onChange={(event) => setQuotaPerUnit(event.target.value)} />
                  </Field>
                ) : null}
                <Field label="余额低于多少告警" hint="按账户原币种，留空使用全局设置">
                  <input className="input" type="number" step="0.01" value={balanceBelow} onChange={(event) => setBalanceBelow(event.target.value)} />
                </Field>
                <Field label="套餐剩余低于 % 告警" hint="留空使用全局设置；卡片颜色在「设置 → 额度颜色」中配置">
                  <input className="input" type="number" min={0} max={100} value={remainingBelow} onChange={(event) => setRemainingBelow(event.target.value)} />
                </Field>
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div
            className="rounded-lg px-3 py-2 text-[12px]"
            style={{ background: 'color-mix(in srgb, var(--danger) 9%, transparent)', color: 'var(--danger)' }}
          >
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
