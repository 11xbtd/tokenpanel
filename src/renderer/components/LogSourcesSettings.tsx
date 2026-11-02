import { useState } from 'react'
import { Database, Plus, RefreshCw, RotateCcw, Save, X } from 'lucide-react'
import type { LogScanResult, LogSourceBinding, LogSourceSetting, Settings } from '../../core/types'
import { services } from '../lib/api'
import { useApp } from '../lib/app-context'
import { Badge, Spinner } from './Common'
import { useToast } from './Toast'
import { formatDateTime, formatTokens } from '../lib/format'

export function LogSourcesSettings({
  settings,
  onChange,
  onSaved,
}: {
  settings: Settings
  onChange: (sources: LogSourceSetting[]) => void
  /** 保存成功后把服务端归一化的完整设置回写给父级，避免父级 draft 过期。 */
  onSaved?: (next: Settings) => void
}) {
  const { bootstrap, reload } = useApp()
  const toast = useToast()
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState(false)

  const supported = bootstrap.logSources.filter((source) => source.supported)
  const unadapted = bootstrap.logSources.filter((source) => !source.supported)
  const accountLabel = (binding: LogSourceBinding) =>
    bootstrap.accounts.find((account) => account.id === binding.accountId)?.label ?? binding.accountId ?? ''

  const update = (id: string, patch: Partial<LogSourceSetting>) => {
    const current = settings.logSources.find((source) => source.id === id) ?? { id, enabled: false, bindings: [] }
    const next = settings.logSources.some((source) => source.id === id)
      ? settings.logSources.map((source) => (source.id === id ? { ...source, ...patch } : source))
      : [...settings.logSources, { ...current, ...patch }]
    onChange(next)
  }

  const patchBinding = (id: string, index: number, patch: Partial<LogSourceBinding>) => {
    const source = settings.logSources.find((item) => item.id === id)
    if (!source) return
    const bindings = source.bindings.map((binding, position) =>
      position === index ? { ...binding, ...patch } : binding,
    )
    update(id, { bindings })
  }

  const save = async (scan: boolean) => {
    setSaving(true)
    try {
      // 保存整份设置草稿（不只 logSources），省得再去点页面上的「保存设置」。
      const next = await services.updateSettings(settings)
      if (onSaved) onSaved(next)
      else onChange(next.logSources)
      if (scan) {
        const result = await services.scanLogs()
        toast.push(scanMessage(result), result.imported > 0 || (result.updated ?? 0) > 0 ? 'ok' : 'info')
      } else {
        toast.push('设置已保存', 'ok')
      }
      await reload()
    } catch (caught) {
      toast.push(`保存失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const scanOnly = async () => {
    setScanning(true)
    try {
      const result = await services.scanLogs()
      await reload()
      toast.push(scanMessage(result), result.imported > 0 || (result.updated ?? 0) > 0 ? 'ok' : 'info')
    } catch (caught) {
      toast.push(`扫描失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    } finally {
      setScanning(false)
    }
  }

  /** 重建：清掉已导入的本机日志记录再全量重扫，让归属规则改动生效。 */
  const rebuild = async () => {
    if (!window.confirm('重建会删除已导入的本机日志记录，然后按当前归属规则重新扫描。继续？')) return
    setScanning(true)
    try {
      const result = await services.rebuildLogStats()
      await reload()
      toast.push(
        `已重建：清理 ${result.rebuilt} 条旧记录，重新导入 ${result.imported} 条${result.unattributed > 0 ? `，${result.unattributed} 条没匹配上归属（未入库）` : ''}`,
        'ok',
      )
    } catch (caught) {
      toast.push(`重建失败：${caught instanceof Error ? caught.message : String(caught)}`, 'error')
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] muted">
          日志按客户端存放，不是按套餐厂商存放；一个客户端可以写多条归属规则，按模型分给不同套餐。
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn btn-sm" disabled={scanning || saving} onClick={() => void scanOnly()}>
            {scanning ? <Spinner size={12} /> : <RefreshCw size={12} />}
            扫描
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={scanning || saving}
            title="删除已导入的本机日志记录并按当前归属规则重扫"
            onClick={() => void rebuild()}
          >
            {scanning ? <Spinner size={12} /> : <RotateCcw size={12} />}
            重建
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={saving || scanning} onClick={() => void save(true)}>
            {saving ? <Spinner size={12} /> : <Save size={12} />}
            保存并扫描
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {supported.map((source) => {
          const setting = settings.logSources.find((item) => item.id === source.id) ?? {
            id: source.id,
            enabled: false,
            bindings: source.bindings,
          }
          return (
            <div
              key={source.id}
              className="rounded-lg border p-3"
              style={{ borderColor: 'var(--border)', opacity: source.available ? 1 : 0.65 }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Database size={14} className="shrink-0 faint" />
                  <span className="text-[12px] font-semibold">{source.name}</span>
                  {source.available ? <Badge tone="accent">已检测</Badge> : <Badge>未检测</Badge>}
                  {source.capabilities.ttft ? <Badge tone="ok">首字耗时</Badge> : null}
                  {source.capabilities.speed ? <Badge>速度</Badge> : null}
                  {source.capabilities.cache ? <Badge>缓存</Badge> : null}
                </div>
                <label className="flex items-center gap-1.5 text-[11px] muted">
                  <input
                    type="checkbox"
                    checked={setting.enabled}
                    onChange={(event) => update(source.id, { enabled: event.target.checked })}
                  />
                  自动扫描
                </label>
              </div>
              <div className="mt-1 text-[10px] faint">{source.description}</div>

              <div className="mt-2 space-y-1.5">
                {setting.bindings.map((binding, index) => (
                  <div key={`${source.id}-${index}`} className="grid gap-2 sm:grid-cols-[1fr_180px_24px]">
                    <select
                      className="input h-8 text-xs"
                      value={binding.accountId ?? ''}
                      onChange={(event) => patchBinding(source.id, index, { accountId: event.target.value || undefined })}
                    >
                      <option value="">选择归属套餐账户</option>
                      {bootstrap.accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.label} · {account.providerId}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input h-8 text-xs"
                      placeholder="模型匹配，如 glm|kimi（正则，留空=其余全部）"
                      value={binding.modelPattern ?? ''}
                      onChange={(event) => patchBinding(source.id, index, { modelPattern: event.target.value || undefined })}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost h-8 w-8 p-0"
                      title={`移除 ${accountLabel(binding) || '该条'} 归属`}
                      onClick={() => update(source.id, { bindings: setting.bindings.filter((_, i) => i !== index) })}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-ghost h-7 gap-1 px-2 text-[11px]"
                  onClick={() => update(source.id, { bindings: [...setting.bindings, {}] })}
                >
                  <Plus size={12} />
                  添加归属账户
                </button>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[10px] faint">
                <span className="truncate" title={source.paths.join('\n')}>
                  {source.paths.join(' · ') || source.note || '路径不存在'}
                </span>
                <span>
                  已导入 {source.imported} 条 / {formatTokens(source.importedTokens)} tokens ·{' '}
                  {source.unattributed > 0 ? `${source.unattributed} 条未归属（未入库）` : '全部已归属'} ·{' '}
                  {source.lastScanAt ? `上次扫描 ${formatDateTime(source.lastScanAt)}` : '未扫描'}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {unadapted.length > 0 ? (
        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
          <div className="text-[11px] font-semibold">发现但暂未适配</div>
          <div className="mt-1 space-y-1">
            {unadapted.map((source) => (
              <div key={source.id} className="text-[10px] muted">
                {source.name} · {source.paths.join(' · ')} — {source.note}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="text-[10px] faint">
        只读日志，只保存模型/时间/token/耗时/缓存，不保存对话内容；只覆盖经过本机客户端的调用。
        Kimi Code、新版 Codex 等日志明确提供首字耗时时会展示；缺失时显示 —。Codex 回合均速包含思考与工具等待，会标注为估算。
        归属规则顺序：带模型匹配的绑定 → 模型名自动规则 → 日志自带的厂商线索（ZCode 的 provider_id）→ 不带模型匹配的默认绑定。
        都匹配不上就不入库：宁可不统计，也不把别家的调用算进某个套餐。
        Qoder 的 dfmodel/qfmodel 是客户端内部 key、不带厂商信息（同一个 key 也可能是你自配的 MiniMax），想固定归到某个套餐就写一条模型匹配，例如 <code>dfmodel|qfmodel</code>。
        更改归属后会清空该来源记录并重新扫描，避免同一调用算两次。
      </div>
    </div>
  )
}

function scanMessage(result: Awaited<ReturnType<typeof services.scanLogs>>): string {
  return `日志扫描：新增 ${result.imported} 条${result.updated ? `，补齐 ${result.updated} 条计时数据` : ''}${result.unattributed > 0 ? `，${result.unattributed} 条没匹配上归属（未入库）` : ''}`
}
