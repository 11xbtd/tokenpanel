import { describe, expect, it } from 'vitest'
import { mergeVisibleOrder, moveId, resolveOrder, sortByOrder } from '../src/renderer/lib/card-order'

const items = (...ids: string[]) => ids.map((accountId) => ({ accountId }))

describe('卡片顺序', () => {
  it('保存的顺序里丢掉已删除的账户，新账户追加在末尾', () => {
    expect(resolveOrder(items('a', 'b', 'c'), ['c', 'gone', 'a'])).toEqual(['c', 'a', 'b'])
    expect(resolveOrder(items('a', 'b'), undefined)).toEqual(['a', 'b'])
    expect(resolveOrder(items('a', 'b'), [])).toEqual(['a', 'b'])
  })

  it('按保存的顺序排序', () => {
    expect(sortByOrder(items('a', 'b', 'c'), ['b', 'c', 'a']).map((item) => item.accountId)).toEqual(['b', 'c', 'a'])
    expect(sortByOrder(items('a', 'b'), undefined).map((item) => item.accountId)).toEqual(['a', 'b'])
  })

  it('只在当前标签页内换位时，其它账户保持原位', () => {
    expect(mergeVisibleOrder(['a', 'b', 'c', 'd', 'e'], ['b', 'd'], ['d', 'b'])).toEqual(['a', 'd', 'c', 'b', 'e'])
    expect(mergeVisibleOrder(['a', 'b', 'c'], ['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b'])
  })

  it('把一张卡移到另一张的位置', () => {
    expect(moveId(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
    expect(moveId(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
    expect(moveId(['a', 'b'], 'a', 'a')).toEqual(['a', 'b'])
    expect(moveId(['a', 'b'], 'x', 'a')).toEqual(['a', 'b'])
  })
})
