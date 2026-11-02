import { describe, expect, it } from 'vitest'
import type { AccountPublic } from '../src/core/types'
import { Pricing } from '../src/core/pricing/pricing'
import { parseLedgerCsv, parseUsageCsv } from '../src/core/services/imports'
import { dateKey } from '../src/core/util/time'
import { parseCsv } from '../src/core/util/csv'

const pricing = new Pricing({ updatedAt: 0, models: {} }, 7.2)
const accounts: AccountPublic[] = [
  {
    id: 'acc-1',
    providerId: 'deepseek',
    label: 'DeepSeek',
    enabled: true,
    createdAt: 0,
    authMasked: { apiKey: 'sk-…abcd' },
    hasAuth: true,
    options: {},
  },
]

describe('CSV 解析', () => {
  it('日期按当天 00:05 落库，人民币费用按汇率转美元', () => {
    const result = parseUsageCsv(
      'account,date,model,input,output,cache_read,cache_write,cost,currency\nDeepSeek,2026-10-29,deepseek-chat,1000000,1000000,0,0,7.2,CNY',
      accounts,
      pricing,
      7.2,
    )
    expect(result.errors).toEqual([])
    expect(result.items).toHaveLength(1)
    const record = result.items[0]
    expect(dateKey(record.ts)).toBe('2026-10-29')
    expect(new Date(record.ts).getHours()).toBe(0)
    expect(record.costUsdMicros).toBe(1_000_000)
    expect(record.costEstimated).toBe(false)
    expect(record.nativeCost).toBe(7.2)
  })

  it('不传费用时按价目表估算并标记 estimated', () => {
    const result = parseUsageCsv(
      'account,date,model,input,output\nDeepSeek,2026-10-28,deepseek-chat,1000000,1000000',
      accounts,
      pricing,
      7.2,
    )
    expect(result.items[0].costUsdMicros).toBe(700_000)
    expect(result.items[0].costEstimated).toBe(true)
  })

  it('未知账户写入错误而不是抛异常', () => {
    const result = parseUsageCsv('account,model\nNope,deepseek-chat', accounts, pricing, 7.2)
    expect(result.items).toHaveLength(0)
    expect(result.errors[0]).toContain('找不到账户')
  })

  it('厂商账单（无 account 列、中文表头）按指定账户导入，费用列带"元"按人民币处理', () => {
    const csv = [
      '日期,模型,输入tokens(缓存命中),输入tokens(未命中),输出tokens,总消耗(元)',
      '2026-10-28,deepseek-chat,8000,12000,3400,0.0123',
      '2026-10-29,deepseek-reasoner,0,50000,2100,0.0456',
    ].join('\n')
    const result = parseUsageCsv(csv, accounts, pricing, 7.2, { defaultAccountId: 'acc-1' })
    expect(result.errors).toEqual([])
    expect(result.items).toHaveLength(2)
    const [first] = result.items
    expect(first.accountId).toBe('acc-1')
    expect(first.inputTokens).toBe(12000)
    expect(first.cacheReadTokens).toBe(8000)
    expect(first.outputTokens).toBe(3400)
    expect(first.nativeCost).toBe(0.0123)
    expect(first.nativeCurrency).toBe('CNY')
    expect(dateKey(first.ts)).toBe('2026-10-28')
  })

  it('既没有 account 列也没指定账户时明确报错', () => {
    expect(() => parseUsageCsv('日期,模型\n2026-10-28,deepseek-chat', accounts, pricing, 7.2)).toThrow(/account/)
  })

  it('记账类型支持中英文与负数调整', () => {
    const result = parseLedgerCsv(
      'account,date,kind,amount,currency,note\nDeepSeek,2026-10-01,充值,100,CNY,支付宝\nDeepSeek,2026-10-02,调整,-5,CNY,更正',
      accounts,
    )
    expect(result.items.map((item) => item.kind)).toEqual(['recharge', 'adjust'])
    expect(result.items[1].amount).toBe(-5)
  })

  it('CSV 解析支持引号与换行', () => {
    const rows = parseCsv('a,b\n"x,1","line\nbreak"')
    expect(rows[1][0]).toBe('x,1')
    expect(rows[1][1]).toContain('\n')
  })
})
