import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { bodyLimit } from 'hono/body-limit'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TokenPanelApp } from '../core/services/app'
import { AppError } from '../core/errors'
import { redact } from '../core/util/redact'
import { VERSION } from '../core/storage/defaults'
import { defaultDataDir, legacyDataDirs } from '../core/paths'
import { migrateLegacyData } from '../core/storage/migrate'
import { createDemoFetch, seedDemo } from './demo'
import type { NewsPreferencesInput, NewsStream } from '../core/news/types'
import type { RankingsSettingsInput } from '../core/rankings/types'

const dataDir = defaultDataDir()
const migratedFrom = await migrateLegacyData(dataDir, legacyDataDirs())
if (migratedFrom) {
  console.log(`已把旧数据目录 ${migratedFrom} 迁移到 ${dataDir}`)
}
const port = Number(process.env.TOKENPANEL_PORT ?? 5188)
const host = process.env.TOKENPANEL_HOST ?? '127.0.0.1'
const password = process.env.TOKENPANEL_PASSWORD ?? ''
const demo = process.env.TOKENPANEL_DEMO === '1' || process.argv.includes('--demo')
const openEnv = process.env.TOKENPANEL_OPEN
const shouldOpen = openEnv === '0' ? false : openEnv === '1' || process.argv.includes('--open')

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('端口无效：TOKENPANEL_PORT 必须是 1-65535 的整数')
  process.exit(1)
}
if (host !== '127.0.0.1' && host !== 'localhost' && !password) {
  console.error('拒绝启动：监听非本机地址时必须设置 TOKENPANEL_PASSWORD（HTTP Basic 认证）')
  process.exit(1)
}

const service = await TokenPanelApp.create({
  dataDir,
  mode: 'browser',
  version: VERSION,
  fetchImpl: demo ? createDemoFetch() : undefined,
  enableLocalLogs: !demo,
})
if (demo) {
  await seedDemo(service)
  await service.refreshAll(true)
}

const app = new Hono()

app.use('/api/*', async (c, next) => {
  const started = Date.now()
  await next()
  console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - started}ms`)
})

app.use('*', async (c, next) => {
  if (!password || c.req.path === '/api/health') {
    await next()
    return
  }
  const header = c.req.header('authorization') ?? ''
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const pass = decoded.slice(decoded.indexOf(':') + 1)
    if (pass === password) {
      await next()
      return
    }
  }
  c.header('WWW-Authenticate', 'Basic realm="TokenPanel"')
  return c.text('Unauthorized', 401)
})

app.use(
  '/api/*',
  bodyLimit({
    maxSize: 20 * 1024 * 1024,
    onError: (c) => c.json({ error: { code: 'validation', message: '请求体超过 20MB' } }, 413),
  }),
)

app.onError((error, c) => {
  const status = error instanceof AppError ? error.status : 500
  const code = error instanceof AppError ? error.code : 'internal'
  const message = redact(error instanceof Error ? error.message : String(error))
  if (status >= 500) console.error(`[api] ${c.req.method} ${c.req.path} -> ${status} ${message}`)
  return c.json({ error: { code, message } }, status as 400)
})

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') throw new AppError('validation', '请求体必须是 JSON 对象')
  return body as T
}

const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '')

app.get('/api/health', (c) => c.json({ ok: true, version: VERSION, demo }))

app.get('/api/bootstrap', async (c) => c.json(await service.getBootstrap()))

app.get('/api/news', async (c) => c.json(await service.getNews(c.req.query('force') === '1', (c.req.query('stream') ?? 'official') as NewsStream, c.req.query('cached') === '1')))

app.post('/api/news/preferences', async (c) => c.json(await service.updateNewsPreferences(await readJson<NewsPreferencesInput>(c))))

app.get('/api/rankings', async (c) => c.json(await service.getRankings(c.req.query('force') === '1', c.req.query('cached') === '1')))

app.post('/api/rankings/settings', async (c) => c.json(await service.configureRankings(await readJson<RankingsSettingsInput>(c))))

app.post('/api/accounts', async (c) => c.json(await service.saveAccount(await readJson(c))))

app.patch('/api/accounts/:id', async (c) => {
  const body = await readJson<Record<string, unknown>>(c)
  return c.json(await service.saveAccount({ ...body, id: c.req.param('id') } as any))
})

app.delete('/api/accounts/:id', async (c) => {
  await service.deleteAccount(c.req.param('id'), c.req.query('purge') === '1')
  return c.json({ ok: true })
})

app.post('/api/accounts/:id/refresh', async (c) => c.json(await service.refreshAccount(c.req.param('id'))))

app.post('/api/logs/scan', async (c) => c.json(await service.scanLogs()))

app.post('/api/logs/rebuild', async (c) => c.json(await service.rebuildLogStats()))

app.post('/api/refresh-all', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  return c.json(await service.refreshAll(Boolean((body as any)?.force)))
})

app.get('/api/overview', async (c) => {
  const days = Number(c.req.query('days') ?? 30)
  return c.json(await service.getOverview(Number.isFinite(days) ? days : 30))
})

app.get('/api/usage', (c) => {
  const numberOrUndefined = (value?: string) => {
    if (!value) return undefined
    const num = Number(value)
    return Number.isFinite(num) ? num : undefined
  }
  return c.json(
    service.getRecords({
      from: numberOrUndefined(c.req.query('from')),
      to: numberOrUndefined(c.req.query('to')),
      accountId: c.req.query('accountId') || undefined,
      model: c.req.query('model') || undefined,
      source: c.req.query('source') || undefined,
      billingMode: (c.req.query('billingMode') as 'api' | 'plan' | 'all' | undefined) || undefined,
      page: numberOrUndefined(c.req.query('page')),
      pageSize: numberOrUndefined(c.req.query('pageSize')),
    }),
  )
})

app.get('/api/ledger', (c) => c.json(service.listLedger(c.req.query('accountId'))))

app.post('/api/ledger', async (c) => c.json(await service.addLedger(await readJson(c))))

app.post('/api/import/usage', async (c) => {
  const body = await readJson<{ text?: string; defaultAccountId?: string }>(c)
  if (typeof body.text !== 'string') throw new AppError('validation', '缺少 text 字段')
  return c.json(await service.importUsageCsv(body.text, body.defaultAccountId))
})

app.post('/api/import/ledger', async (c) => {
  const body = await readJson<{ text?: string }>(c)
  if (typeof body.text !== 'string') throw new AppError('validation', '缺少 text 字段')
  return c.json(await service.importLedgerCsv(body.text))
})

app.post('/api/import/backup', async (c) => {
  const body = await readJson<{ text?: string }>(c)
  if (typeof body.text !== 'string') throw new AppError('validation', '缺少 text 字段')
  return c.json(await service.importBackup(body.text))
})

app.get('/api/export/usage', (c) => {
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="tokenpanel-usage-${stamp()}.csv"`)
  return c.body(service.exportUsageCsv())
})

app.get('/api/export/backup', async (c) => {
  const json = await service.exportBackup(c.req.query('secrets') === '1')
  c.header('Content-Type', 'application/json; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="tokenpanel-backup-${stamp()}.json"`)
  return c.body(json)
})

app.post('/api/settings', async (c) => c.json(await service.updateSettings(await readJson(c))))

app.post('/api/fx/refresh', async (c) => c.json(await service.refreshFx(true)))

app.post('/api/webhook/test', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  return c.json(await service.testWebhook((body as any)?.id))
})

app.get('/api/diagnostics', (c) => c.json(service.diagnostics()))

app.get('/api/prices/overrides', (c) => c.json(service.getPriceOverrides()))

app.put('/api/prices/overrides', async (c) => c.json(await service.savePriceOverrides(await readJson(c))))

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web')
const hasWeb = await fs
  .access(path.join(webDir, 'index.html'))
  .then(() => true)
  .catch(() => false)

if (hasWeb) {
  app.use('*', serveStatic({ root: webDir }))
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: { code: 'not_found', message: '接口不存在' } }, 404)
    }
    const html = await fs.readFile(path.join(webDir, 'index.html'), 'utf8')
    return c.html(html)
  })
} else {
  app.get('/', (c) => c.text('前端未构建：运行 npm run build，或开发时使用 npm run dev 并访问 http://127.0.0.1:5173'))
}

app.notFound((c) => c.json({ error: { code: 'not_found', message: '接口不存在' } }, 404))

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${info.port}`
  console.log(`TokenPanel ${VERSION} 已启动：${url}`)
  console.log(`数据目录：${dataDir}${demo ? '（演示模式）' : ''}`)
  if (shouldOpen) openBrowser(url)
})

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用，请设置 TOKENPANEL_PORT 换一个端口`)
  } else {
    console.error('服务启动失败：', redact(error))
  }
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000)
  })
}

function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
}
