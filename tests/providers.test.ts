import { describe, expect, it } from 'vitest'
import { PROVIDERS } from '../src/core/providers/registry'
import { expiryFieldLabel } from '../src/renderer/components/AccountModal'

describe('厂商 Key 控制台链接', () => {
  it('所有 keyUrl 都是合法的 https 地址', () => {
    for (const provider of PROVIDERS) {
      if (!provider.keyUrl) continue
      const url = new URL(provider.keyUrl)
      expect(url.protocol, provider.id).toBe('https:')
      expect(url.hostname, provider.id).toContain('.')
    }
  })

  it('常用按量 / 订阅厂商都配了获取 Key 入口', () => {
    const expected = ['deepseek', 'kimi-cn', 'minimax-plan', 'opencode-go', 'openrouter', 'glm-plan', 'gemini', 'groq']
    for (const id of expected) {
      const provider = PROVIDERS.find((entry) => entry.id === id)
      expect(provider?.keyUrl, id).toBeTruthy()
    }
  })

  it('登录态 / 自建类预设不误导用户去控制台拿 Key', () => {
    for (const id of ['claude-plan', 'codex-plan', 'newapi', 'custom-http']) {
      const provider = PROVIDERS.find((entry) => entry.id === id)
      expect(provider?.keyUrl, id).toBeUndefined()
    }
  })

  it('新增账户时每家厂商都能登记到期日，标签按是否含套餐区分', () => {
    for (const provider of PROVIDERS) {
      expect(expiryFieldLabel(provider), provider.id).toMatch(/到期日$/)
    }
    const labelOf = (id: string) => expiryFieldLabel(PROVIDERS.find((entry) => entry.id === id)!)
    expect(labelOf('minimax-plan')).toBe('套餐到期日')
    expect(labelOf('claude-plan')).toBe('套餐到期日')
    expect(labelOf('custom-http')).toBe('套餐到期日')
    expect(labelOf('deepseek')).toBe('充值包到期日')
    expect(labelOf('openai-usage')).toBe('充值包到期日')
  })
})
