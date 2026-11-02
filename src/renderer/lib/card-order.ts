import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

/** 卡片需要的绑定：id 用于落点计算，dragging 用于占位样式。 */
export interface CardDragBinding {
  id: string
  dragging: boolean
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
}

/** 鼠标移动超过这个距离才算拖拽，保证点击、按钮和文字选择不受影响。 */
const START_THRESHOLD = 5
const ANIMATION_MS = 190

/**
 * 完整顺序 = 已保存的顺序（过滤掉已删除的账户）+ 其余账户的原有顺序。
 * 新增账户因此总是排在末尾，不会因为缺少排序记录而插到中间。
 */
export function resolveOrder<T extends { accountId: string }>(items: T[], saved?: string[]): string[] {
  const ids = items.map((item) => item.accountId)
  const kept = (saved ?? []).filter((id) => ids.includes(id))
  const known = new Set(kept)
  return [...kept, ...ids.filter((id) => !known.has(id))]
}

export function sortByOrder<T extends { accountId: string }>(items: T[], saved?: string[]): T[] {
  const rank = new Map(resolveOrder(items, saved).map((id, index) => [id, index]))
  return [...items].sort((a, b) => (rank.get(a.accountId) ?? 0) - (rank.get(b.accountId) ?? 0))
}

/** 把可见子集的新顺序写回完整顺序，不在当前标签页里的账户保持原位。 */
export function mergeVisibleOrder(base: string[], visible: string[], nextVisible: string[]): string[] {
  const subset = new Set(visible)
  let index = 0
  return base.map((id) => (subset.has(id) && index < nextVisible.length ? nextVisible[index++] : id))
}

export function moveId(list: string[], from: string, to: string): string[] {
  const fromIndex = list.indexOf(from)
  const toIndex = list.indexOf(to)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return list
  const next = [...list]
  next.splice(fromIndex, 1)
  next.splice(toIndex, 0, from)
  return next
}

interface Session {
  id: string
  container: HTMLElement
  order: string[]
  base: string[]
  pointerId: number
  grabX: number
  grabY: number
  ghost: HTMLElement
}

interface EngineDeps {
  order: { current: string[] }
  container: { current: HTMLElement | null }
  onChange: { current: (next: string[]) => void }
  onCommit: { current: (next: string[]) => void }
  setDraggingId: (id: string | null) => void
}

/**
 * 用布局坐标（offsetLeft/offsetTop）判断指针落在哪个卡位，
 * 这样卡片正在做位移动画时也不会因为 getBoundingClientRect 抖动而反复换位。
 */
function hitIndex(container: HTMLElement, cards: HTMLElement[], x: number, y: number): number {
  const root = container.getBoundingClientRect()
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  cards.forEach((card, index) => {
    const left = root.left + card.offsetLeft
    const top = root.top + card.offsetTop
    const dx = Math.max(left - x, 0, x - (left + card.offsetWidth))
    const dy = Math.max(top - y, 0, y - (top + card.offsetHeight))
    const distance = Math.hypot(dx, dy)
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  })
  return best
}

/** 拖拽引擎：用指针事件自己实现，才能有跟随鼠标的预览和拖动中的实时换位。 */
function createEngine(deps: EngineDeps) {
  let session: Session | null = null

  const placeGhost = (x: number, y: number) => {
    if (!session) return
    session.ghost.style.transform = `translate3d(${x - session.grabX}px, ${y - session.grabY}px, 0) rotate(1.2deg) scale(1.015)`
  }

  const reorderAt = (x: number, y: number) => {
    if (!session) return
    const cards = [...session.container.querySelectorAll<HTMLElement>('[data-card-id]')]
    const index = hitIndex(session.container, cards, x, y)
    const from = session.order.indexOf(session.id)
    if (index < 0 || from < 0 || index === from) return
    const next = [...session.order]
    next.splice(from, 1)
    next.splice(index, 0, session.id)
    session.order = next
    deps.onChange.current([...next])
  }

  const stop = (commit: boolean) => {
    const active = session
    session = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    window.removeEventListener('keydown', onKey)
    document.body.classList.remove('is-card-dragging')
    if (!active) return
    active.ghost.remove()
    deps.setDraggingId(null)
    if (commit) deps.onCommit.current(active.order)
    else deps.onChange.current(active.base)
  }

  const onMove = (event: PointerEvent) => {
    if (!session || event.pointerId !== session.pointerId) return
    event.preventDefault()
    placeGhost(event.clientX, event.clientY)
    reorderAt(event.clientX, event.clientY)
  }

  const onUp = (event: PointerEvent) => {
    if (!session || event.pointerId !== session.pointerId) return
    stop(true)
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') stop(false)
  }

  const begin = (id: string, element: HTMLElement, pointerId: number, x: number, y: number) => {
    const container = deps.container.current
    if (!container) return
    const rect = element.getBoundingClientRect()
    const ghost = element.cloneNode(true) as HTMLElement
    ghost.classList.add('card-ghost')
    ghost.removeAttribute('data-dragging')
    ghost.removeAttribute('data-card-id')
    ghost.removeAttribute('aria-busy')
    ghost.style.width = `${rect.width}px`
    ghost.style.height = `${rect.height}px`
    document.body.appendChild(ghost)
    document.body.classList.add('is-card-dragging')
    const base = [...deps.order.current]
    session = {
      id,
      container,
      order: base,
      base,
      pointerId,
      grabX: x - rect.left,
      grabY: y - rect.top,
      ghost,
    }
    deps.setDraggingId(id)
    placeGhost(x, y)
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('keydown', onKey)
  }

  const onPointerDown = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    // 触屏目前不支持拖拽排序：竖直滑动要留给页面滚动。
    if (event.pointerType === 'touch' || event.button !== 0 || session) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, a, input, textarea, select, [data-no-drag]')) return
    const element = event.currentTarget as HTMLElement
    const { pointerId, clientX, clientY } = event

    const onFirstMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      if (Math.hypot(moveEvent.clientX - clientX, moveEvent.clientY - clientY) < START_THRESHOLD) return
      detach()
      begin(id, element, pointerId, moveEvent.clientX, moveEvent.clientY)
    }
    const onFirstUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return
      detach()
    }
    const detach = () => {
      window.removeEventListener('pointermove', onFirstMove)
      window.removeEventListener('pointerup', onFirstUp)
      window.removeEventListener('pointercancel', onFirstUp)
    }
    window.addEventListener('pointermove', onFirstMove, { passive: false })
    window.addEventListener('pointerup', onFirstUp)
    window.addEventListener('pointercancel', onFirstUp)
  }

  return { onPointerDown }
}

export function useCardDrag({ order, containerRef, onChange, onCommit }: {
  order: string[]
  containerRef: { current: HTMLElement | null }
  onChange: (next: string[]) => void
  onCommit: (next: string[]) => void
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const orderRef = useRef(order)
  const onChangeRef = useRef(onChange)
  const onCommitRef = useRef(onCommit)
  orderRef.current = order
  onChangeRef.current = onChange
  onCommitRef.current = onCommit

  const engineRef = useRef<ReturnType<typeof createEngine> | null>(null)
  if (!engineRef.current) {
    engineRef.current = createEngine({
      order: orderRef,
      container: containerRef,
      onChange: onChangeRef,
      onCommit: onCommitRef,
      setDraggingId,
    })
  }
  const engine = engineRef.current

  const bind = (id: string): CardDragBinding => ({
    id,
    dragging: draggingId === id,
    onPointerDown: (event) => engine.onPointerDown(id, event),
  })

  return { draggingId, bind }
}

/**
 * 位置变化时用 FLIP 补一段位移动画，卡片换位是滑过去而不是瞬间跳过去。
 * 坐标记录在布局完成后读一次，动画本身走 transform，不影响后续命中判断。
 */
export function useFlip(containerRef: { current: HTMLElement | null }, signature: string) {
  const previous = useRef(new Map<string, { left: number; top: number }>())
  useLayoutEffect(() => {
    const root = containerRef.current
    if (!root) return
    const next = new Map<string, { left: number; top: number }>()
    for (const element of root.querySelectorAll<HTMLElement>('[data-card-id]')) {
      const id = element.dataset.cardId
      if (!id) continue
      const rect = element.getBoundingClientRect()
      next.set(id, { left: rect.left, top: rect.top })
      const before = previous.current.get(id)
      if (!before) continue
      const dx = before.left - rect.left
      const dy = before.top - rect.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      element.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: ANIMATION_MS, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
      )
    }
    previous.current = next
  }, [containerRef, signature])
}
