import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startPreload, type StartupTarget } from '../src/node/startup'
import type { PanelServices } from '../src/core/bridge'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenpanel-startup-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('uTools 启动故障记录', () => {
  it('核心模块加载失败时保留可读错误桥接，并对日志中的密钥脱敏', async () => {
    const target: StartupTarget = {}
    startPreload(target, () => { throw new Error('failed sk-test1234567890') }, undefined, dir)
    await expect(target.services!.getBootstrap()).rejects.toThrow('插件启动失败')
    const log = await fs.readFile(path.join(dir, 'startup.log'), 'utf8')
    expect(log).toContain('preload:error')
    expect(log).toContain('[已脱敏]')
    expect(log).not.toContain('sk-test1234567890')
  })

  it('异步初始化失败不会伪装成启动成功，记录后仍将错误交给页面', async () => {
    const target: StartupTarget = {}
    startPreload(target, () => ({ installPreload() {
      target.services = {
        getBootstrap: async () => { throw new Error('config unreadable') },
        getOverview: async () => ({}),
      } as unknown as PanelServices
    } }), undefined, dir)
    await expect(target.services!.getBootstrap()).rejects.toThrow('config unreadable')
    const log = await fs.readFile(path.join(dir, 'startup.log'), 'utf8')
    expect(log).toContain('getBootstrap:error')
    expect(log).not.toContain('getBootstrap:ready')
  })

  it('区分后台退出与结束运行，同时记录渲染错误而不拦截默认行为', async () => {
    const callbacks: Record<string, (value: any) => void> = {}
    const target: StartupTarget = { addEventListener: (name, callback) => { callbacks[name] = callback } }
    startPreload(target, () => ({ installPreload() {
      target.services = { getBootstrap: async () => ({}), getOverview: async () => ({}) } as unknown as PanelServices
    } }), { onPluginOut: callback => { callbacks.out = callback } }, dir)
    callbacks.out(false)
    callbacks.out(true)
    callbacks.error({ message: 'render failure' })
    const log = await fs.readFile(path.join(dir, 'startup.log'), 'utf8')
    expect(log).toContain('isKill=false')
    expect(log).toContain('isKill=true')
    expect(log).toContain('renderer:error')
    expect(log).toContain('render failure')
  })

  it('日志目录无法写入也不影响正常桥接', async () => {
    const blockedPath = path.join(dir, 'file')
    await fs.writeFile(blockedPath, 'file', 'utf8')
    const target: StartupTarget = {}
    startPreload(target, () => ({ installPreload() {
      target.services = { getBootstrap: async () => ({ mode: 'utools' }), getOverview: async () => ({}) } as unknown as PanelServices
    } }), undefined, blockedPath)
    await expect(target.services!.getBootstrap()).resolves.toEqual({ mode: 'utools' })
  })
})
