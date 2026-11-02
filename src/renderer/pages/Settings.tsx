import { useEffect, useState } from 'react'
import { Download, Plus, RefreshCw, Save, Trash2, Upload } from 'lucide-react'
import type { CsvImportSummary, Diagnostics, Settings, WebhookConfig } from '../../core/types'
import { DEFAULT_QUOTA_COLORS, quotaColorThresholds, validQuotaColors } from '../../core/util/quota'
import type { PriceOverride, PriceOverridesFile } from '../../core/pricing/types'
import { services } from '../lib/api'
import { useApp } from '../lib/app-context'
import { Badge, Section, Spinner } from '../components/Common'
import { Modal } from '../components/Modal'
import { LogSourcesSettings } from '../components/LogSourcesSettings'
import { useToast } from '../components/Toast'
import { formatDateTime } from '../lib/format'

interface PriceRow {
  model: string
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
  currency: 'CNY' | 'USD'
}

function toRows(file: PriceOverridesFile): PriceRow[] {
  return Object.entries(file.models).map(([model, price]) => ({
    model,
    input: String(price.inputPerM),
    output: String(price.outputPerM),
    cacheRead: price.cacheReadPerM !== undefined ? String(price.cacheReadPerM) : '',
    cacheWrite: price.cacheWritePerM !== undefined ? String(price.cacheWritePerM) : '',
    currency: price.currency,
  }))
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint ? <div className="mt-1 text-[10px] faint">{hint}</div> : null}
    </div>
  )
}

export function SettingsPage() {
  const { bootstrap, reload } = useApp()
  const toast = useToast()
  const [draft, setDraft] = useState<Settings>(() => ({ ...bootstrap.settings, quotaColors: quotaColorThresholds(bootstrap.settings.quotaColors) }))
  const colorsValid = validQuotaColors(draft.quotaColors)
  const [saving, setSaving] = useState(false)
  const [fxBusy, setFxBusy] = useState(false)
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [overrides, setOverrides] = useState<PriceOverridesFile | null>(null)
  const [rows, setRows] = useState<PriceRow[]>([])
  const [overridesSaving, setOverridesSaving] = useState(false)
  const [importType, setImportType] = useState<'usage' | 'ledger'>('usage')
  const [importText, setImportText] = useState('')
  const [importAccountId, setImportAccountId] = useState('')
  const [importResult, setImportResult] = useState<CsvImportSummary | null>(null)
  const [importing, setImporting] = useState(false)
  const [confirmSecrets, setConfirmSecrets] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)

  const loadDiagnostics = () => {
    services.getDiagnostics().then(setDiagnostics).catch((caught) => {
      toast.push(`诊断读取失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    })
  }

  useEffect(() => {
    services
      .getPriceOverrides()
      .then((file) => {
        setOverrides(file)
        setRows(toRows(file))
      })
      .catch((caught) => toast.push(`价目覆盖读取失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error'))
    loadDiagnostics()
  }, [])

  const saveSettings = async () => {
    setSaving(true)
    try {
      const next = await services.updateSettings(draft)
      setDraft(next)
      await reload()
      toast.push('设置已保存', 'ok')
    } catch (caught) {
      toast.push(`保存失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const refreshFx = async () => {
    setFxBusy(true)
    try {
      const info = await services.refreshFx(true)
      setDraft((current) => ({ ...current, fxUsdCny: info.rate, fxUpdatedAt: info.updatedAt }))
      await reload()
      toast.push(`汇率已更新：1 USD = ${info.rate.toFixed(4)} CNY`, 'ok')
    } catch (caught) {
      toast.push(`汇率更新失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    } finally {
      setFxBusy(false)
    }
  }

  const updateHook = (id: string, patch: Partial<WebhookConfig>) => {
    setDraft((current) => ({
      ...current,
      webhooks: current.webhooks.map((hook) => (hook.id === id ? { ...hook, ...patch } : hook)),
    }))
  }

  const testHook = async (hook: WebhookConfig) => {
    if (hook.id.startsWith('draft-') || !hook.url) {
      toast.push('请先保存设置，再测试新 Webhook', 'info')
      return
    }
    try {
      const results = await services.testWebhook(hook.id)
      const result = results[0]
      toast.push(result?.ok ? '测试消息已发送' : `发送失败：${result?.error ?? '未知错误'}`, result?.ok ? 'ok' : 'error')
    } catch (caught) {
      toast.push(`测试失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    }
  }

  const saveOverrides = async () => {
    const models: Record<string, PriceOverride> = {}
    for (const row of rows) {
      const model = row.model.trim()
      if (!model) continue
      const input = Number(row.input)
      const output = Number(row.output)
      if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
        toast.push(`${model} 的输入/输出价格无效`, 'error')
        return
      }
      const cacheRead = row.cacheRead.trim() === '' ? undefined : Number(row.cacheRead)
      const cacheWrite = row.cacheWrite.trim() === '' ? undefined : Number(row.cacheWrite)
      if ((cacheRead !== undefined && (!Number.isFinite(cacheRead) || cacheRead < 0)) || (cacheWrite !== undefined && (!Number.isFinite(cacheWrite) || cacheWrite < 0))) {
        toast.push(`${model} 的缓存价格无效`, 'error')
        return
      }
      models[model] = {
        inputPerM: input,
        outputPerM: output,
        cacheReadPerM: cacheRead,
        cacheWritePerM: cacheWrite,
        currency: row.currency,
      }
    }
    setOverridesSaving(true)
    try {
      const next = await services.savePriceOverrides({ updatedAt: Date.now(), models })
      setOverrides(next)
      setRows(toRows(next))
      toast.push('价目覆盖已保存，仅影响之后的新记录', 'ok')
    } catch (caught) {
      toast.push(`保存失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    } finally {
      setOverridesSaving(false)
    }
  }

  const doImport = async () => {
    if (!importText.trim()) {
      toast.push('请先粘贴 CSV 或选择文件', 'info')
      return
    }
    setImporting(true)
    setImportResult(null)
    try {
      const result =
        importType === 'usage'
          ? await services.importUsageCsv(importText, importAccountId || undefined)
          : await services.importLedgerCsv(importText)
      setImportResult(result)
      await reload()
      toast.push(`导入完成：新增 ${result.added} 条`, 'ok')
    } catch (caught) {
      toast.push(`导入失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    } finally {
      setImporting(false)
    }
  }

  const exportUsage = async () => {
    try {
      const csv = await services.exportUsageCsv()
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      await services.saveFile(`tokenpanel-usage-${stamp}.csv`, csv)
      toast.push('已导出用量 CSV', 'ok')
    } catch (caught) {
      toast.push(`导出失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    }
  }

  const exportBackup = async (includeSecrets: boolean) => {
    setBackupBusy(true)
    try {
      const json = await services.exportBackup(includeSecrets)
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      await services.saveFile(`tokenpanel-backup-${stamp}${includeSecrets ? '-with-secrets' : ''}.json`, json)
      toast.push('已导出备份', 'ok')
      setConfirmSecrets(false)
    } catch (caught) {
      toast.push(`导出失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    } finally {
      setBackupBusy(false)
    }
  }

  const importBackupFile = async (file: File) => {
    try {
      const text = await file.text()
      const result = await services.importBackup(text)
      await reload()
      loadDiagnostics()
      toast.push(`恢复完成：账户 ${result.accounts}、用量 ${result.usage}、快照 ${result.snapshots}、记账 ${result.ledger}`, 'ok')
    } catch (caught) {
      toast.push(`恢复失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    }
  }

  return (
    <div className="space-y-4 p-3 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] faint">设置修改后点右侧保存；密钥类配置请到账户页编辑。</div>
        <button type="button" className="btn btn-primary" disabled={saving || !colorsValid} onClick={() => void saveSettings()}>
          {saving ? <Spinner size={13} /> : <Save size={13} />}
          保存设置
        </button>
      </div>

      <Section title="额度颜色" extra={<button type="button" className="btn btn-sm" onClick={() => setDraft({ ...draft, quotaColors: { ...DEFAULT_QUOTA_COLORS } })}>恢复默认 50% / 20%</button>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="橙色 · 偏低（剩余 ≤ %）" hint="默认 50%；低于或等于此比例时显示橙色">
            <input className="input" aria-label="橙色偏低阈值" type="number" min={0} max={100} step={1} value={draft.quotaColors.warningPct} onChange={(event) => setDraft({ ...draft, quotaColors: { ...draft.quotaColors, warningPct: Number(event.target.value) } })} />
          </Field>
          <Field label="红色 · 将耗尽（剩余 ≤ %）" hint="默认 20%；低于或等于此比例时优先显示红色">
            <input className="input" aria-label="红色将耗尽阈值" type="number" min={0} max={100} step={1} value={draft.quotaColors.dangerPct} onChange={(event) => setDraft({ ...draft, quotaColors: { ...draft.quotaColors, dangerPct: Number(event.target.value) } })} />
          </Field>
        </div>
        {!colorsValid ? <div role="alert" className="mt-2 text-[11px]" style={{ color: 'var(--danger)' }}>阈值必须满足 0 ≤ 红色 &lt; 橙色 ≤ 100（%）。</div> : null}
        <div className="mt-3 text-[10.5px] faint">保存后统一应用到余量主数字、窗口文字、进度条和总览摘要。余量充足时使用厂商色；通知触发阈值在下方「告警」中设置。</div>
      </Section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="展示、汇率与刷新">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="展示币种">
              <select
                className="input"
                value={draft.displayCurrency}
                onChange={(event) => setDraft({ ...draft, displayCurrency: event.target.value as 'CNY' | 'USD' })}
              >
                <option value="CNY">CNY（人民币）</option>
                <option value="USD">USD（美元）</option>
              </select>
            </Field>
            <Field label="主题">
              <select
                className="input"
                value={draft.theme}
                onChange={(event) => setDraft({ ...draft, theme: event.target.value as Settings['theme'] })}
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </Field>
            <Field label="USD → CNY 汇率" hint="自动模式每 12 小时从 Frankfurter 拉取">
              <div className="flex gap-2">
                <input
                  className="input"
                  type="number"
                  step="0.0001"
                  value={draft.fxUsdCny}
                  onChange={(event) => setDraft({ ...draft, fxUsdCny: Number(event.target.value) })}
                />
                <button type="button" className="btn shrink-0" disabled={fxBusy} onClick={() => void refreshFx()}>
                  {fxBusy ? <Spinner size={13} /> : <RefreshCw size={13} />}
                  更新
                </button>
              </div>
            </Field>
            <Field label="自动刷新汇率">
              <label className="flex h-[34px] items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={draft.fxAuto}
                  onChange={(event) => setDraft({ ...draft, fxAuto: event.target.checked })}
                />
                每 12 小时自动更新
              </label>
            </Field>
            <Field label="自动刷新周期（分钟）" hint="打开面板时按此周期判断是否跳过；手动刷新总是执行">
              <input
                className="input"
                type="number"
                min={1}
                max={1440}
                value={draft.refreshTtlMin}
                onChange={(event) => setDraft({ ...draft, refreshTtlMin: Number(event.target.value) })}
              />
            </Field>
            <div className="text-[11px] text-muted">
              当前汇率更新于 {draft.fxUpdatedAt ? formatDateTime(draft.fxUpdatedAt) : '尚未自动更新'}
            </div>
          </div>
        </Section>

        <Section title="告警">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="启用告警">
              <label className="flex h-[34px] items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={draft.alerts.enabled}
                  onChange={(event) => setDraft({ ...draft, alerts: { ...draft.alerts, enabled: event.target.checked } })}
                />
                每次进入面板与刷新时评估余额、套餐与日消耗；告警不落库，只即时提示
              </label>
            </Field>
            <Field label="套餐剩余低于 % 告警" hint="通知按此阈值触发；卡片的橙色、红色阈值在上方「额度颜色」中设置">
              <input
                className="input"
                type="number"
                min={0}
                max={100}
                value={draft.alerts.remainingBelowPct}
                onChange={(event) =>
                  setDraft({ ...draft, alerts: { ...draft.alerts, remainingBelowPct: Number(event.target.value) } })
                }
              />
            </Field>
            <Field label="默认余额阈值" hint="账户未单独设置时使用，原币种">
              <input
                className="input"
                type="number"
                step="0.01"
                value={draft.alerts.balanceBelowDefault ?? ''}
                placeholder="留空不告警"
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    alerts: {
                      ...draft.alerts,
                      balanceBelowDefault: event.target.value === '' ? undefined : Number(event.target.value),
                    },
                  })
                }
              />
            </Field>
            <Field label="今日实际计费超过（折合展示币种）" hint="只按厂商实际账单/中转/导入的金额判定，价目表估算的消耗不触发">
              <input
                className="input"
                type="number"
                step="0.01"
                value={draft.alerts.dailySpendAbove ?? ''}
                placeholder="留空不告警"
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    alerts: {
                      ...draft.alerts,
                      dailySpendAbove: event.target.value === '' ? undefined : Number(event.target.value),
                    },
                  })
                }
              />
            </Field>
            <Field label="告警冷却（小时）" hint="Webhook 推送去重：同一账户同一项在该时间内只推一次（进程内计数）">
              <input
                className="input"
                type="number"
                min={1}
                max={168}
                value={draft.alerts.cooldownHours}
                onChange={(event) =>
                  setDraft({ ...draft, alerts: { ...draft.alerts, cooldownHours: Number(event.target.value) } })
                }
              />
            </Field>
          </div>

          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-semibold">Webhook</div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    webhooks: [
                      ...current.webhooks,
                      { id: `draft-${Date.now()}`, type: 'feishu', url: '', enabled: true },
                    ],
                  }))
                }
              >
                <Plus size={12} />
                添加
              </button>
            </div>
            {draft.webhooks.length === 0 ? (
              <div className="rounded-lg border px-3 py-3 text-[11px] faint" style={{ borderColor: 'var(--border)' }}>
                支持飞书群机器人、企业微信群机器人、通用 Webhook（POST JSON）。
              </div>
            ) : (
              <div className="space-y-2">
                {draft.webhooks.map((hook) => (
                  <div key={hook.id} className="flex flex-wrap items-center gap-1.5">
                    <select
                      className="input h-8 w-[92px] text-xs"
                      value={hook.type}
                      onChange={(event) => updateHook(hook.id, { type: event.target.value as WebhookConfig['type'] })}
                    >
                      <option value="feishu">飞书</option>
                      <option value="wecom">企微</option>
                      <option value="generic">通用</option>
                    </select>
                    <input
                      className="input h-8 min-w-[180px] flex-1 text-xs"
                      placeholder="https://..."
                      value={hook.url}
                      onChange={(event) => updateHook(hook.id, { url: event.target.value })}
                    />
                    <label className="flex items-center gap-1 text-[11px] muted">
                      <input
                        type="checkbox"
                        checked={hook.enabled}
                        onChange={(event) => updateHook(hook.id, { enabled: event.target.checked })}
                      />
                      启用
                    </label>
                    <button type="button" className="btn btn-sm" onClick={() => void testHook(hook)}>测试</button>
                    <button
                      type="button"
                      className="btn btn-ghost h-7 w-7 p-0"
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          webhooks: current.webhooks.filter((item) => item.id !== hook.id),
                        }))
                      }
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
                <div className="text-[10px] faint">新增 Webhook 请先保存设置，再点测试。</div>
              </div>
            )}
          </div>
        </Section>
      </div>

      <Section
        title="本机日志源（套餐 / 按量 token 明细）"
        extra={<span className="text-[11px] faint">只读 · 只存指标</span>}
      >
        <LogSourcesSettings
          settings={draft}
          onChange={(logSources) => setDraft((current) => ({ ...current, logSources }))}
          onSaved={(next) => setDraft(next)}
        />
      </Section>

      <Section
        title="价目覆盖"
        extra={
          <div className="flex items-center gap-2">
            {overrides?.updatedAt ? <span className="text-[11px] faint">更新于 {formatDateTime(overrides.updatedAt)}</span> : null}
            <button type="button" className="btn btn-sm" onClick={() => setRows((current) => [...current, { model: '', input: '', output: '', cacheRead: '', cacheWrite: '', currency: 'USD' }])}>
              <Plus size={12} />
              添加模型
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={overridesSaving} onClick={() => void saveOverrides()}>
              {overridesSaving ? <Spinner size={12} /> : <Save size={12} />}
              保存
            </button>
          </div>
        }
        bodyClassName="p-0"
      >
        <div className="border-b px-4 py-2 text-[11px] muted" style={{ borderColor: 'var(--border)' }}>
          内置 LiteLLM 快照 {bootstrap.pricing.modelCount} 个模型（{new Date(bootstrap.pricing.updatedAt).toLocaleDateString()} 生成）。
          这里的覆盖按「每 1M tokens」计价，只影响保存之后写入的新记录；更早的记录保留当时的单价。
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-[11px] faint">没有手动覆盖，全部使用内置价目表。</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>输入 / 1M</th>
                  <th>输出 / 1M</th>
                  <th>缓存读 / 1M</th>
                  <th>缓存写 / 1M</th>
                  <th>币种</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.model}-${index}`}>
                    <td>
                      <input
                        className="input h-8 text-xs"
                        value={row.model}
                        placeholder="模型名，如 deepseek-chat"
                        onChange={(event) =>
                          setRows((current) => current.map((item, i) => (i === index ? { ...item, model: event.target.value } : item)))
                        }
                      />
                    </td>
                    {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((field) => (
                      <td key={field}>
                        <input
                          className="input h-8 w-[86px] text-xs"
                          type="number"
                          step="0.0001"
                          value={row[field]}
                          onChange={(event) =>
                            setRows((current) =>
                              current.map((item, i) => (i === index ? { ...item, [field]: event.target.value } : item)),
                            )
                          }
                        />
                      </td>
                    ))}
                    <td>
                      <select
                        className="input h-8 w-[76px] text-xs"
                        value={row.currency}
                        onChange={(event) =>
                          setRows((current) =>
                            current.map((item, i) => (i === index ? { ...item, currency: event.target.value as 'CNY' | 'USD' } : item)),
                          )
                        }
                      >
                        <option value="USD">USD</option>
                        <option value="CNY">CNY</option>
                      </select>
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        className="btn btn-ghost h-7 w-7 p-0"
                        onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="导入">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <select className="input h-8 w-auto text-xs" value={importType} onChange={(event) => { setImportType(event.target.value as 'usage' | 'ledger'); setImportResult(null) }}>
                <option value="usage">用量 CSV</option>
                <option value="ledger">记账 CSV</option>
              </select>
              {importType === 'usage' ? (
                <select
                  className="input h-8 w-auto max-w-[190px] text-xs"
                  value={importAccountId}
                  onChange={(event) => setImportAccountId(event.target.value)}
                  title="账单里没有 account 列时，用这个账户接收（厂商账单导出通常没有）"
                >
                  <option value="">按账单里的 account 列</option>
                  {bootstrap.accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      全部记到「{account.label}」
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  void services.saveFile(
                    `tokenpanel-${importType}-template.csv`,
                    importType === 'usage' ? bootstrap.templates.usage : bootstrap.templates.ledger,
                  )
                }
              >
                <Download size={12} />
                下载模板
              </button>
              <label className="btn btn-sm cursor-pointer">
                <Upload size={12} />
                选择文件
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={async (event) => {
                    const file = event.target.files?.[0]
                    if (file) setImportText(await file.text())
                    event.target.value = ''
                  }}
                />
              </label>
            </div>
            <textarea
              className="input min-h-[120px] font-mono text-[11px]"
              placeholder={importType === 'usage' ? bootstrap.templates.usage : bootstrap.templates.ledger}
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-primary" disabled={importing} onClick={() => void doImport()}>
                {importing ? <Spinner size={12} /> : <Upload size={12} />}
                导入
              </button>
              <button type="button" className="btn" onClick={() => void exportUsage()}>
                <Download size={12} />
                导出全部用量
              </button>
            </div>
            {importResult ? (
              <div className="rounded-lg border px-3 py-2 text-[11px]" style={{ borderColor: 'var(--border)' }}>
                新增 {importResult.added} 条，跳过重复 {importResult.duplicates} 条
                {importResult.errors.length > 0 ? (
                  <ul className="mt-1 list-inside list-disc" style={{ color: 'var(--danger)' }}>
                    {importResult.errors.slice(0, 5).map((message) => <li key={message}>{message}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </Section>

        <Section title="备份与恢复">
          <div className="space-y-3 text-[12px]">
            <p className="muted">
              备份包含账户配置、用量明细、额度快照与记账。默认不含密钥，Webhook 地址与自定义请求头也会移除；迁移到另一台设备时需要导出含密钥版本，并妥善保管。
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn" disabled={backupBusy} onClick={() => void exportBackup(false)}>
                <Download size={12} />
                导出（不含密钥）
              </button>
              <button type="button" className="btn btn-danger" disabled={backupBusy} onClick={() => setConfirmSecrets(true)}>
                <Download size={12} />
                导出（含密钥）
              </button>
              <label className="btn cursor-pointer">
                <Upload size={12} />
                恢复备份
                <input
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={async (event) => {
                    const file = event.target.files?.[0]
                    if (file) await importBackupFile(file)
                    event.target.value = ''
                  }}
                />
              </label>
            </div>
            <div className="rounded-lg border px-3 py-2 text-[11px] muted" style={{ borderColor: 'var(--border)' }}>
              恢复采用增量合并：同 ID 的账户/记录会跳过，不会覆盖现有数据；设置会一并恢复，不含密钥的备份不会覆盖现有 Webhook。
            </div>
          </div>
        </Section>
      </div>

      <Section
        title="诊断与说明"
        extra={<button type="button" className="btn btn-sm" onClick={loadDiagnostics}><RefreshCw size={12} />刷新</button>}
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ['版本', `${bootstrap.version} · ${bootstrap.mode === 'utools' ? 'uTools' : '浏览器'}`],
            ['数据目录', bootstrap.dataDir],
            ['账户 / 用量', `${diagnostics?.accounts ?? '—'} / ${diagnostics?.usageRecords ?? '—'}`],
            ['快照 / 记账', `${diagnostics?.snapshots ?? '—'} / ${diagnostics?.ledgerEntries ?? '—'}`],
            ['价目模型数', `${bootstrap.pricing.modelCount}`],
            ['价目生成时间', formatDateTime(bootstrap.pricing.updatedAt)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border)' }}>
              <div className="text-[10px] uppercase tracking-wide faint">{label}</div>
              <div className="mt-1 break-all text-[12px]">{value}</div>
            </div>
          ))}
        </div>
        {diagnostics?.lastErrors?.length ? (
          <div className="mt-3">
            <div className="mb-1 text-[11px] font-semibold">最近错误</div>
            <div className="space-y-1">
              {diagnostics.lastErrors.map((error, index) => (
                <div key={`${error.at}-${index}`} className="rounded-lg px-2 py-1.5 text-[11px]" style={{ background: 'color-mix(in srgb, var(--danger) 7%, transparent)' }}>
                  {formatDateTime(error.at)} · {error.accountId} · {error.message}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="mt-3 space-y-1 text-[11px] muted">
          <div>· uTools 插件没有后台常驻进程：数据在打开面板时刷新，告警也在刷新时评估。</div>
          <div>· 标记「实验性」的套餐接口来自社区逆向，可能随时失效；失败会保留上次成功数据并给出错误提示。</div>
          <div>· 密钥使用 AES-256-GCM 加密存储，但无法防御本机恶意程序；请勿把数据目录同步到公共网盘。</div>
          <div>· 费用以美元为内部单位；人民币账户按汇率折算展示，单条记录保留写入时的价格与原始费用。</div>
        </div>
      </Section>

      <Modal
        open={confirmSecrets}
        onClose={() => setConfirmSecrets(false)}
        title="导出含密钥的备份？"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirmSecrets(false)}>取消</button>
            <button type="button" className="btn btn-danger" disabled={backupBusy} onClick={() => void exportBackup(true)}>
              {backupBusy ? <Spinner size={12} /> : <Download size={12} />}
              确认导出
            </button>
          </>
        }
      >
        <div className="space-y-2 text-[12px]">
          <p>备份文件会包含明文 API Key / Admin Key / OAuth Token，任何拿到文件的人都能使用你的额度。</p>
          <p className="muted">仅用于迁移到自己的另一台设备；导出后请立即移到安全位置，不要通过聊天工具或公共网盘传输。</p>
          <Badge tone="danger">高敏文件</Badge>
        </div>
      </Modal>
    </div>
  )
}
