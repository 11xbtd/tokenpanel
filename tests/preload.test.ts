import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let dir = ''
let services: any

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenpanel-preload-'))
  process.env.TOKENPANEL_DATA_DIR = dir
  ;(globalThis as any).fetch = async () => new Response('{}', { status: 404 })
  ;(globalThis as any).utools = {
    getPath: () => dir,
    showNotification: () => undefined,
    shellOpenExternal: () => undefined,
  }
  ;(globalThis as any).window = {}
  const { installPreload } = await import('../src/node/preload')
  installPreload()
  services = (globalThis as any).window.services
})

afterAll(async () => {
  delete process.env.TOKENPANEL_DATA_DIR
  await fs.rm(dir, { recursive: true, force: true })
})

describe('uTools preload 桥', () => {
  it('暴露 window.services，并能完成手动账户的存取与刷新', async () => {
    const bootstrap = await services.getBootstrap()
    expect(bootstrap.mode).toBe('utools')
    expect(bootstrap.accounts).toHaveLength(0)

    await services.saveAccount({
      providerId: 'gemini',
      label: 'Preload 测试',
      options: { manualBalance: { amount: 12, currency: 'USD' } },
    })
    const result = await services.refreshAll(true)
    expect(result.results[0].status).toBe('ok')

    const overview = await services.getOverview(30)
    expect(overview.accounts[0].balance).toBe(12)

    const meta = (globalThis as any).window.tokenPanelMeta
    expect(meta.mode).toBe('utools')
  })
})
