import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PanelServices } from '../core/bridge'
import { defaultDataDir } from '../core/paths'
import { redact } from '../core/util/redact'

interface StartupState {
  logPath: string
  stage: string
  error?: string
}

export interface StartupTarget {
  services?: PanelServices
  tokenPanelMeta?: unknown
  tokenPanelStartup?: StartupState
  addEventListener?: (name: string, listener: (event: any) => void) => void
}

export interface StartupHost {
  onPluginReady?: (callback: () => void) => void
  onPluginEnter?: (callback: (action: { code: string }) => void) => void
  onPluginOut?: (callback: (isKill: boolean) => void) => void
}

/** The small entry point must survive a failure while loading the application bundle. */
export function startPreload(
  target: StartupTarget,
  loadCore: () => { installPreload: (trace?: (stage: string, detail?: unknown) => void) => void },
  host?: StartupHost,
  logDir = defaultDataDir(),
): StartupState {
  const state: StartupState = { logPath: path.join(logDir, 'startup.log'), stage: 'preload:start' }
  target.tokenPanelStartup = state
  let errorCount = 0
  const record = (stage: string, detail?: unknown) => {
    state.stage = stage
    const message = detail === undefined ? undefined : redact(detail instanceof Error ? detail.stack ?? detail.message : detail, 1800)
    if (stage.endsWith(':error')) {
      state.error = message
      if (++errorCount > 20) return
    }
    try {
      mkdirSync(logDir, { recursive: true })
      if (existsSync(state.logPath) && statSync(state.logPath).size > 512 * 1024) writeFileSync(state.logPath, '', 'utf8')
      appendFileSync(state.logPath, `${JSON.stringify({ at: new Date().toISOString(), stage, ...(message ? { message } : {}) })}\n`, 'utf8')
    } catch {
      // A diagnostic failure must never prevent the plugin from opening.
    }
  }

  record('preload:start', `node=${process.versions.node} electron=${process.versions.electron ?? 'unavailable'} chrome=${process.versions.chrome ?? 'unavailable'}`)
  target.addEventListener?.('error', event => record('renderer:error', event.error ?? event.message))
  target.addEventListener?.('unhandledrejection', event => record('promise:error', event.reason))
  try {
    host?.onPluginReady?.(() => record('plugin:ready'))
    host?.onPluginEnter?.(action => record('plugin:enter', `code=${action.code}`))
    host?.onPluginOut?.(isKill => record('plugin:out', `isKill=${isKill}`))
  } catch (error) {
    record('lifecycle:error', error)
  }

  try {
    loadCore().installPreload(record)
    if (typeof target.services?.getBootstrap !== 'function' || typeof target.services?.getOverview !== 'function') {
      throw new Error('preload 未完整注入 window.services')
    }
    const bridge = target.services as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const method of ['getBootstrap', 'getOverview']) {
      const original = bridge[method]
      bridge[method] = async (...args: unknown[]) => {
        record(`${method}:start`)
        try {
          const result = await original(...args)
          record(`${method}:ready`)
          return result
        } catch (error) {
          record(`${method}:error`, error)
          throw error
        }
      }
    }
    record('bridge:ready')
  } catch (error) {
    record('preload:error', error)
    const failure = new Error(`插件启动失败：${redact(error, 400)}；启动日志：${state.logPath}`)
    const fail = async () => { throw failure }
    // App.load already renders a retryable error page when either initial request fails.
    target.services = { getBootstrap: fail, getOverview: fail } as unknown as PanelServices
    target.tokenPanelMeta = { mode: 'utools', startupError: state.error }
  }
  return state
}
