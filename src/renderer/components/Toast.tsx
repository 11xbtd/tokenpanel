import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react'

type ToastTone = 'ok' | 'warn' | 'error' | 'info'
interface ToastItem {
  id: number
  message: string
  tone: ToastTone
  persistent: boolean
  onClose?: () => void
}

export interface ToastOptions {
  /** 常驻不自动消失，只能手动关（比如额度告警）。 */
  persistent?: boolean
  onClose?: () => void
}

const ToastContext = createContext<{ push: (message: string, tone?: ToastTone, options?: ToastOptions) => void }>({
  push: () => undefined,
})

const ICONS = { ok: CheckCircle2, warn: TriangleAlert, error: AlertCircle, info: Info }
const COLORS = { ok: 'var(--ok)', warn: 'var(--warn)', error: 'var(--danger)', info: 'var(--accent)' }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number, onClose?: () => void) => {
    setItems((current) => current.filter((item) => item.id !== id))
    onClose?.()
  }, [])

  const push = useCallback((message: string, tone: ToastTone = 'info', options?: ToastOptions) => {
    const id = Date.now() + Math.random()
    const persistent = options?.persistent === true
    setItems((current) => [...current.slice(-3), { id, message, tone, persistent, onClose: options?.onClose }])
    if (!persistent) {
      setTimeout(() => {
        setItems((current) => current.filter((item) => item.id !== id))
      }, 4200)
    }
  }, [])

  // 上下文值必须稳定：否则每次弹提示都会换掉 useToast() 的引用，
  // 把依赖 toast 的 effect 全部重跑一遍。
  const value = useMemo(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {items.map((item) => {
          const Icon = ICONS[item.tone]
          return (
            <div
              key={item.id}
              role={item.tone === 'warn' || item.tone === 'error' ? 'alert' : 'status'}
              data-tone={item.tone}
              className="toast-enter pointer-events-auto flex items-start gap-2.5 rounded-lg border border-l-[3px] px-3 py-2.5 text-[12px] leading-relaxed"
              style={{
                background: `color-mix(in srgb, ${COLORS[item.tone]} 4%, var(--surface))`,
                borderColor: `color-mix(in srgb, ${COLORS[item.tone]} 25%, var(--border))`,
                borderLeftColor: COLORS[item.tone],
                boxShadow: 'var(--shadow-lift)',
              }}
            >
              <Icon size={16} style={{ color: COLORS[item.tone], marginTop: 1, flexShrink: 0 }} />
              <span className="min-w-0 flex-1 break-words">{item.message}</span>
              <button
                type="button"
                className="btn btn-ghost h-5 w-5 shrink-0 p-0"
                title="关闭"
                aria-label="关闭提醒"
                onClick={() => dismiss(item.id, item.onClose)}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
