import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  wide = false,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className={`card fade-in relative flex max-h-[88vh] w-full flex-col overflow-hidden ${wide ? 'max-w-[760px]' : 'max-w-[560px]'}`}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold">{title}</div>
            {subtitle ? <div className="mt-0.5 text-xs muted">{subtitle}</div> : null}
          </div>
          <button type="button" className="btn btn-ghost h-7 w-7 shrink-0 p-0" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t px-5 py-3" style={{ borderColor: 'var(--border)' }}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
