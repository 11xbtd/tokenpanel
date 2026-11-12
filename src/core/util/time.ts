export const DAY_MS = 86_400_000

const pad = (n: number) => String(n).padStart(2, '0')

export function dateKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function startOfMonth(ts: number): number {
  const d = new Date(ts)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function lastNDates(n: number, end = Date.now()): string[] {
  const out: string[] = []
  const endStart = startOfDay(end)
  for (let i = n - 1; i >= 0; i--) out.push(dateKey(endStart - i * DAY_MS))
  return out
}

export function formatDateTime(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = new Date()
  const sameDay = dateKey(ts) === dateKey(now.getTime())
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return sameDay ? `今天 ${time}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
}

export function formatCountdown(ts?: number): string {
  if (!ts) return ''
  const diff = ts - Date.now()
  if (diff <= 0) return '已重置'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} 小时 ${minutes % 60} 分`
  const days = Math.floor(hours / 24)
  return `${days} 天 ${hours % 24} 小时`
}

/** 耗时/首字统一写法：亚秒用 ms，秒级保留一位，分钟级不再显示秒。 */
export function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes} 分 ${Math.round((ms % 60_000) / 1000)} 秒`
}

export interface PlanExpiry {
  /** 剩余整天数（向上取整）；已到期为 0。 */
  days: number
  tone: 'ok' | 'warn' | 'danger'
  label: string
}

/** 套餐到期倒计时：7 天内预警，已到期标红。 */
export function planExpiry(expiresAt: number | undefined, now = Date.now()): PlanExpiry | null {
  if (!expiresAt || !Number.isFinite(expiresAt) || expiresAt <= 0) return null
  const diff = expiresAt - now
  if (diff <= 0) return { days: 0, tone: 'danger', label: '已到期' }
  const days = Math.ceil(diff / DAY_MS)
  return { days, tone: days <= 7 ? 'warn' : 'ok', label: `${days} 天后到期` }
}
