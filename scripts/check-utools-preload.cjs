const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const pluginDir = path.resolve(process.argv[2] || path.join(root, 'dist/utools'))
const tempRoot = path.join(root, '.dev')
fs.mkdirSync(tempRoot, { recursive: true })
const dataDir = fs.mkdtempSync(path.join(tempRoot, 'preload-smoke-'))

;(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'))
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
  assert.equal(packageJson.type, 'commonjs', 'preload 必须按 CommonJS 加载')
  for (const name of [manifest.preload, manifest.main, manifest.logo]) assert.ok(name && fs.existsSync(path.join(pluginDir, name)), `缺少插件入口资源：${name}`)
  for (const name of [manifest.preload, 'preload-core.js']) {
    const code = fs.readFileSync(path.join(pluginDir, name), 'utf8')
    assert.ok(!/\bimport\s*\(/.test(code), `${name} 仍含原生动态 import()，未完全转成 CommonJS`)
  }

  process.env.TOKENPANEL_DATA_DIR = dataDir
  globalThis.fetch = async () => new Response('{}', { status: 503 })
  globalThis.utools = {
    getPath: () => dataDir,
    onPluginReady() {}, onPluginEnter() {}, onPluginOut() {},
    showNotification() {}, shellOpenExternal() {},
  }
  globalThis.window = { utools: globalThis.utools, addEventListener() {} }
  require(path.join(pluginDir, manifest.preload))
  assert.equal(window.tokenPanelStartup.error, undefined, window.tokenPanelStartup.error)
  const services = window.services
  assert.equal(typeof services?.getBootstrap, 'function', 'window.services 未注入')
  assert.equal(typeof services?.getOverview, 'function', 'window.services 不完整')
  assert.equal(typeof services?.getNews, 'function', 'AI 动态桥接缺失')
  assert.equal(typeof services?.updateNewsPreferences, 'function', '资讯关注桥接缺失')
  const [bootstrap, overview] = await Promise.all([services.getBootstrap(), services.getOverview(30)])
  assert.equal(bootstrap.mode, 'utools')
  assert.equal(bootstrap.dataDir, dataDir)
  assert.deepEqual(bootstrap.accounts, [])
  assert.deepEqual(overview.accounts, [])
  await services.updateNewsPreferences({ followedTopicIds: [] })
  const news = await services.getNews()
  assert.deepEqual(news.followedTopicIds, [])
  assert.deepEqual(news.items, [])
  assert.ok(news.topics.length > 0)
  assert.equal(window.tokenPanelStartup.error, undefined, window.tokenPanelStartup.error)
  console.log('[build] uTools preload CommonJS 加载、桥接注入和首次读取检查通过（非 uTools 实机验证）')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  const resolvedTarget = fs.realpathSync(dataDir)
  const resolvedParent = fs.realpathSync(tempRoot)
  if (!resolvedTarget.startsWith(resolvedParent + path.sep)) throw new Error('拒绝清理工作区外的测试目录')
  fs.rmSync(resolvedTarget, { recursive: true, force: true })
})
