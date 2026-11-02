import type { ComponentType, ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

export type Tone = 'default' | 'accent' | 'ok' | 'warn' | 'danger'

const TONE_BADGE: Record<Tone, string> = {
  default: 'badge',
  accent: 'badge badge-accent',
  ok: 'badge badge-ok',
  warn: 'badge badge-warn',
  danger: 'badge badge-danger',
}

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: Tone }) {
  return <span className={TONE_BADGE[tone]}>{children}</span>
}

const STATUS_COLOR: Record<string, string> = {
  ok: 'var(--ok)',
  error: 'var(--danger)',
  never: 'var(--text-faint)',
  disabled: 'var(--text-faint)',
}

export function StatusDot({ status, title }: { status: string; title?: string }) {
  return (
    <span
      title={title}
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: STATUS_COLOR[status] ?? 'var(--text-faint)' }}
    />
  )
}

/**
 * 指标块。primary 放本页最该先看到的那个数，字号更大、位置更靠前，
 * 其余降一级，避免四个等大数字摊平成一排。
 */
export function Stat({
  label,
  value,
  sub,
  right,
  primary = false,
  tone,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  right?: ReactNode
  primary?: boolean
  tone?: 'ok' | 'warn' | 'danger'
}) {
  const longValue = typeof value === 'string' && value.length > 11
  return (
    <div
      className="flex min-w-0 flex-col justify-between gap-2 px-3.5 py-3.5 md:px-4 [&:not(:last-child)]:border-r"
      style={{
        borderColor: 'var(--border)',
        background: primary ? `color-mix(in srgb, var(--${tone ?? 'accent'}) 6%, transparent)` : undefined,
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="eyebrow truncate">{label}</div>
        {right}
      </div>
      <div
        className="truncate font-semibold leading-none num"
        title={typeof value === 'string' || typeof value === 'number' ? String(value) : undefined}
        style={{
          fontSize: primary
            ? `clamp(${longValue ? 16 : 22}px, 3vw, var(--fs-kpi))`
            : longValue ? 'clamp(16px, 1.8vw, 22px)' : 22,
          letterSpacing: '-0.03em',
          color: primary ? `var(--${tone ?? 'accent'})` : 'var(--text)',
        }}
      >
        {value}
      </div>
      {sub ? <div className="truncate text-[11.5px] faint">{sub}</div> : <div className="h-[15px]" />}
    </div>
  )
}

/** 一组 Stat 横向排在一个卡片里，用发丝线分隔，而不是多个盒子。 */
export function StatRow({ children }: { children: ReactNode }) {
  return (
    <div className="card stat-row grid grid-cols-2 gap-0 overflow-hidden lg:grid-cols-4 [&>*:nth-child(2n)]:border-r-0 lg:[&>*:nth-child(2n)]:border-r lg:[&>*:last-child]:border-r-0">{children}</div>
  )
}

export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  className = '',
  ariaLabel = '切换统计范围',
}: {
  value: T
  onChange: (value: T) => void
  options: Array<{ value: T; label: string }>
  className?: string
  ariaLabel?: string
}) {
  return (
    <div className={`tabs ${className}`} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin" />
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: ComponentType<{ size?: number; className?: string }>
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 px-6 py-12 text-center">
      <div
        className="flex h-8 w-8 items-center justify-center rounded-lg"
        style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)' }}
      >
        <Icon size={16} />
      </div>
      <div className="text-[13px] font-semibold">{title}</div>
      {description ? <div className="max-w-[440px] text-xs muted">{description}</div> : null}
      {action}
    </div>
  )
}

export function Section({
  title,
  extra,
  children,
  className = '',
  bodyClassName = '',
}: {
  title: ReactNode
  extra?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={`card overflow-hidden ${className}`}>
      <div
        className="flex min-h-[38px] items-center justify-between gap-3 border-b px-4 py-2"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="truncate text-[12.5px] font-semibold">{title}</div>
        {extra}
      </div>
      <div className={bodyClassName || 'p-4'}>{children}</div>
    </section>
  )
}
