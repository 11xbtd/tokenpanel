import { build } from 'esbuild'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadSharedRankingsApiKey } from './rankings-shared-key.mjs'

const root = process.cwd()
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))

const pluginJson = {
  name: 'token-panel',
  pluginName: 'TokenPanel',
  description: 'AI Token 用量、余额/套餐额度、AI 动态与模型排行看板，数据只存本机。',
  author: 'TokenPanel contributors',
  version: pkg.version,
  logo: 'logo.png',
  main: 'index.html',
  preload: 'preload.js',
  title: 'TokenPanel',
  // 默认窗口贴合常见屏幕（含 720p，可用高度约 672）；uTools 会记住用户手动调整后的尺寸。
  pluginSetting: { single: true, width: 980, height: 620, minWidth: 620, minHeight: 420 },
  features: [
    {
      code: 'token-panel',
      explain: '打开 AI Token 用量、AI 动态与模型排行看板',
      cmds: ['token', 'tokenpanel', 'AI余额', 'AI动态', '模型排行'],
    },
  ],
  platform: ['win32', 'darwin', 'linux'],
}

async function main() {
  const sharedApiKey = await loadSharedRankingsApiKey(root)
  const define = { __TOKENPANEL_AA_SHARED_API_KEY__: JSON.stringify(sharedApiKey) }
  await fs.rm(path.join(root, 'dist/server'), { recursive: true, force: true })
  await fs.rm(path.join(root, 'dist/utools'), { recursive: true, force: true })
  await build({
    entryPoints: [path.join(root, 'src/node/server.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: path.join(root, 'dist/server/server.mjs'),
    loader: { '.json': 'json' },
    define,
    logLevel: 'info',
  })
  await build({
    entryPoints: [path.join(root, 'src/node/preload.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // uTools preload follows CommonJS; do not leave native import() calls in it.
    supported: { 'dynamic-import': false },
    outfile: path.join(root, 'dist/utools/preload-core.js'),
    loader: { '.json': 'json' },
    define,
    logLevel: 'info',
  })
  await build({
    entryPoints: [path.join(root, 'src/node/preload-loader.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(root, 'dist/utools/preload.js'),
    external: ['./preload-core.js'],
    logLevel: 'info',
  })
  await fs.mkdir(path.join(root, 'dist/utools'), { recursive: true })
  await fs.cp(path.join(root, 'dist/web'), path.join(root, 'dist/utools'), { recursive: true })
  await fs.writeFile(path.join(root, 'dist/utools/plugin.json'), `${JSON.stringify(pluginJson, null, 2)}\n`, 'utf8')
  const logo = path.join(root, 'logo.png')
  const hasLogo = await fs
    .access(logo)
    .then(() => true)
    .catch(() => false)
  if (hasLogo) {
    await fs.copyFile(logo, path.join(root, 'dist/utools/logo.png'))
  } else {
    console.warn('[build] 缺少 logo.png，uTools 导入时会提示缺少图标')
  }
  for (const file of ['LICENSE', 'NOTICE.md', 'README.md']) {
    const source = path.join(root, file)
    const exists = await fs
      .access(source)
      .then(() => true)
      .catch(() => false)
    if (exists) await fs.copyFile(source, path.join(root, 'dist/utools', file))
  }
  // uTools 的 preload.js 必须是 CommonJS。项目根 package.json 是 "type": "module"，
  // Node 会向上查找把它当成 ESM 加载（require 未定义，桥接注入失败）。
  // 在产物目录放一个 commonjs 标记，Node 就不会再往上找了。
  await fs.writeFile(
    path.join(root, 'dist/utools/package.json'),
    `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
    'utf8',
  )
  const preloadSize = (await fs.stat(path.join(root, 'dist/utools/preload-core.js'))).size
  console.log(`[build] uTools 产物已生成，preload 核心 ${(preloadSize / 1024).toFixed(0)} KB`)
  console.log(`[build] AA 默认共享 Key ${sharedApiKey ? '已启用' : '未配置'}`)
  await assertPreloadLoadsAsCommonJs(root, Boolean(sharedApiKey))
}

/** 检查最终入口、桥接注入和首次读取；任何异常或非零退出都必须阻止交付。 */
async function assertPreloadLoadsAsCommonJs(root, hasSharedKey) {
  const { spawnSync } = await import('node:child_process')
  const args = [path.join(root, 'scripts/check-utools-preload.cjs'), path.join(root, 'dist/utools')]
  if (hasSharedKey) args.push('--expect-shared')
  const result = spawnSync(process.execPath, args, {
    cwd: path.join(root, 'dist/utools'),
    encoding: 'utf8',
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error || result.status !== 0) {
    throw new Error(`[build] uTools preload 启动检查失败：${result.error?.message ?? output}`)
  }
  console.log(output.trim())
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
