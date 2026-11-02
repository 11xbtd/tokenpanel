import { describe, expect, it } from 'vitest'
import { Pricing } from '../src/core/pricing/pricing'

const pricing = new Pricing({ updatedAt: 0, models: {} }, 7.2)

describe('Pricing', () => {
  it('按精确模型名匹配并用每百万 token 单价计费', () => {
    const cost = pricing.estimateCost({
      model: 'deepseek-chat',
      providerId: 'deepseek',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(cost.missingPrice).toBe(false)
    expect(cost.usdMicros).toBe(700_000)
    expect(cost.matchKey).toBe('deepseek-chat')
  })

  it('缓存读默认按输入价 10%', () => {
    const cost = pricing.estimateCost({
      model: 'deepseek-chat',
      providerId: 'deepseek',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    })
    expect(cost.usdMicros).toBe(308_000)
  })

  it('归一化日期后缀与 models/ 前缀', () => {
    const dated = pricing.lookup('DeepSeek-Chat-2025-01-01', 'deepseek')
    expect(dated?.matchKey).toBe('deepseek-chat')
    const prefixed = pricing.lookup('models/deepseek-chat', 'deepseek')
    expect(prefixed?.matchKey).toBe('deepseek-chat')
  })

  it('超过 200k 输入时切换到阶梯价', () => {
    const cost = pricing.estimateCost({
      model: 'claude-sonnet-4-5-20250929-v1:0',
      providerId: 'anthropic-usage',
      inputTokens: 300_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(cost.missingPrice).toBe(false)
    expect(cost.usdMicros).toBe(1_800_000)
  })

  it('手写覆盖优先，人民币价格按汇率换算', () => {
    const withOverride = new Pricing(
      {
        updatedAt: Date.now(),
        models: { 'my-model': { inputPerM: 7.2, outputPerM: 14.4, currency: 'CNY' } },
      },
      7.2,
    )
    const cost = withOverride.estimateCost({
      model: 'my-model',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(cost.usdMicros).toBe(1_000_000)
  })

  it('未匹配到价目时返回 missingPrice', () => {
    const cost = pricing.estimateCost({
      model: 'definitely-not-a-real-model-xyz',
      inputTokens: 100,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(cost.missingPrice).toBe(true)
    expect(cost.usdMicros).toBe(0)
  })
})
