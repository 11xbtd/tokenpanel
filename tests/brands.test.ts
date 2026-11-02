import { describe, expect, it } from 'vitest'
import { PROVIDERS } from '../src/core/providers/registry'
import { BRAND_ICONS } from '../src/renderer/lib/brands'

/** 没有官方标识可用的预设：继续用首字母色块，不拿别的品牌图凑数。 */
const UNMAPPED = new Set(['custom-http'])

describe('厂商图标', () => {
  it('每个预设都有对应图标，未映射的只有明示的那几个', () => {
    const missing = PROVIDERS.filter((provider) => !BRAND_ICONS[provider.id] && !UNMAPPED.has(provider.id)).map(
      (provider) => provider.id,
    )
    expect(missing).toEqual([])
    expect(UNMAPPED.has('deepseek')).toBe(false)
  })

  it('图标是可直接内联的 SVG data URI', () => {
    for (const [providerId, mark] of Object.entries(BRAND_ICONS)) {
      expect(mark.src, providerId).toMatch(/^data:image\/svg\+xml;base64,/)
      const svg = Buffer.from(mark.src.split('base64,')[1], 'base64').toString('utf8')
      expect(svg, providerId).toContain('viewBox="0 0 24 24"')
      expect(svg, providerId).toContain('<path')
      expect(svg, providerId).not.toMatch(/<script|onerror=/i)
    }
  })

  it('彩色图标保留品牌色，单色图标走 mask 上色', () => {
    for (const [providerId, mark] of Object.entries(BRAND_ICONS)) {
      const svg = Buffer.from(mark.src.split('base64,')[1], 'base64').toString('utf8')
      if (mark.mono) {
        expect(svg, providerId).not.toMatch(/#[0-9a-fA-F]{6}/)
      } else {
        expect(svg, providerId).toMatch(/#[0-9a-fA-F]{6}/)
        // 黑色细节原来用 currentColor，内联后要换成固定深色，否则在深色底上看不见。
        expect(svg, providerId).not.toContain('currentColor')
      }
    }
    expect(BRAND_ICONS['opencode-go'].mono).toBe(true)
  })
})
