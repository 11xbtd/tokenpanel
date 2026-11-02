import { useEffect, useRef, useState } from 'react'
import type { AccountPublic, AccountSummary } from '../../core/types'
import { services } from '../lib/api'
import { useApp } from '../lib/app-context'
import { mergeVisibleOrder, resolveOrder, sortByOrder, useCardDrag, useFlip } from '../lib/card-order'
import { useToast } from './Toast'
import { UsageCard } from './UsageCard'

/** 账户卡片网格：按保存的顺序排列，拖动卡片本体即可换位并写回设置。 */
export function AccountCards({ accounts, accountMap, statsSource, onRefresh, onEdit, refreshingId, refreshing }: {
  accounts: AccountSummary[]
  accountMap: Map<string, AccountPublic>
  statsSource: 'api' | 'plan'
  onRefresh: (id: string) => void
  onEdit: (account: AccountPublic) => void
  refreshingId: string | null
  refreshing: boolean
}) {
  const { bootstrap, reload } = useApp()
  const toast = useToast()
  const containerRef = useRef<HTMLDivElement | null>(null)
  // 拖动过程中先用本地顺序渲染，落库成功后再交还给 settings。
  const [pending, setPending] = useState<string[] | null>(null)
  const savedIds = resolveOrder(accounts.map((account) => ({ accountId: account.accountId })), bootstrap.settings.accountOrder)
  const ids = pending ?? savedIds
  const ordered = sortByOrder(accounts, ids)
  const draggable = accounts.length > 1

  const commitOrder = async (next: string[]) => {
    // 顺序按账户全局保存，所以要把当前标签页内的新顺序写回完整列表。
    const base = resolveOrder(
      bootstrap.accounts.map((account) => ({ accountId: account.id })),
      bootstrap.settings.accountOrder,
    )
    try {
      await services.updateSettings({ accountOrder: mergeVisibleOrder(base, savedIds, next) })
      await reload()
    } catch (error) {
      setPending(null)
      toast.push(`保存卡片顺序失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  const { bind } = useCardDrag({
    order: ids,
    containerRef,
    onChange: setPending,
    onCommit: (next) => void commitOrder(next),
  })
  useFlip(containerRef, ids.join('|'))

  // 落库后 bootstrap 会带着新顺序回来，这时松开临时顺序，避免多留一份状态。
  useEffect(() => {
    if (pending && pending.join('|') === savedIds.join('|')) setPending(null)
  }, [pending, savedIds])

  return (
    <div className="account-grid" ref={containerRef}>
      {ordered.map((summary) => (
        <UsageCard
          key={summary.accountId}
          summary={summary}
          account={accountMap.get(summary.accountId)}
          statsSource={statsSource}
          onRefresh={onRefresh}
          onEdit={onEdit}
          refreshing={refreshingId === summary.accountId || refreshing}
          drag={draggable ? bind(summary.accountId) : undefined}
        />
      ))}
    </div>
  )
}
