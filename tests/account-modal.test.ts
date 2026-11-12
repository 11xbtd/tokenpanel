import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

// 弹窗用 portal 渲染，服务端渲染不支持，这里只替换外壳，保留弹窗真实结构。
vi.mock('../src/renderer/components/Modal', async () => {
  const { createElement } = await import('react')
  return {
    Modal: ({ open, title, children }: { open: boolean; title?: ReactNode; children?: ReactNode }) =>
      open ? createElement('section', { 'data-modal': 'true' }, title, children) : null,
  }
})

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { AccountModal } = await import('../src/renderer/components/AccountModal')
const { PROVIDERS } = await import('../src/core/providers/registry')

/** 新增流程：不传 account，厂商取默认值。 */
const renderAddForm = (): string =>
  renderToStaticMarkup(
    createElement(AccountModal, {
      open: true,
      providers: PROVIDERS,
      onClose: () => undefined,
      onSaved: () => undefined,
    }),
  )

describe('新增账户的到期日选择', () => {
  it('新增时直接提供到期日输入，不必先保存再编辑', () => {
    const html = renderAddForm()
    expect(html).toContain('type="datetime-local"')
    expect(html).toContain('到期日')
    expect(html).toContain('到期倒计时')
  })

  it('到期日排在密钥字段之前，打开表单就能看到', () => {
    const html = renderAddForm()
    const expiryAt = html.indexOf('type="datetime-local"')
    const secretAt = html.indexOf('type="password"')
    expect(expiryAt).toBeGreaterThan(-1)
    expect(secretAt).toBeGreaterThan(-1)
    expect(expiryAt).toBeLessThan(secretAt)
  })

  it('默认按量厂商用「充值包到期日」的叫法', () => {
    expect(renderAddForm()).toContain('充值包到期日')
  })
})
