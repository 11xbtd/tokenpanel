import { ArrowUpRight, Check, X } from 'lucide-react'

export function SetupGuide({ hasAccounts, hasUsage, onAdd, onSources, onAnalysis, onClose }: {
  hasAccounts: boolean
  hasUsage: boolean
  onAdd: () => void
  onSources: () => void
  onAnalysis: () => void
  onClose?: () => void
}) {
  const steps = [
    { title: '添加厂商账户', description: '选择厂商，连接接口或手动录入余额', complete: hasAccounts, action: onAdd },
    { title: '接入用量明细', description: '启用本机日志，或导入厂商 CSV 账单', complete: hasUsage, action: onSources },
    { title: '查看消耗分析', description: '切换统计范围，查看模型用量与调用', complete: false, action: onAnalysis },
  ]
  return (
    <section className="card p-4" aria-label="接入指引">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-[13px] font-semibold">{hasAccounts ? '三步，让用量一目了然' : '从第一个 AI 账户开始'}</h2>
          <p className="mt-1 text-[11px] muted">余额与额度来自账户，token 明细来自用量接口、账单或本机日志。</p>
        </div>
        {onClose ? <button type="button" className="btn btn-ghost h-7 w-7 shrink-0 p-0" aria-label="收起接入指引" onClick={onClose}><X size={14} /></button> : null}
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {steps.map((step, index) => (
          <button key={step.title} type="button" className="setup-step" onClick={step.action}>
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold" style={{ background: step.complete ? 'var(--accent-soft)' : 'var(--bg-subtle)', color: step.complete ? 'var(--accent-strong)' : 'var(--text-muted)' }}>
              {step.complete ? <Check size={13} aria-label="已完成" /> : `0${index + 1}`}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-1 text-[12px] font-medium">{step.title}<ArrowUpRight size={12} className="faint" /></span>
              <span className="mt-1 block text-[10.5px] leading-relaxed muted">{step.description}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}
