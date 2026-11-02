import { promises as fs } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const iconDir = path.join(root, 'node_modules/@lobehub/icons-static-svg/icons')
const outFile = path.join(root, 'src/renderer/lib/brands.ts')

/** providerId → @lobehub/icons-static-svg 文件名（不含 .svg）。优先带 -color 的官方配色版。 */
const MAP = {
  deepseek: 'deepseek-color',
  'kimi-cn': 'kimi',
  'kimi-global': 'kimi',
  'kimi-code-plan': 'kimi',
  stepfun: 'stepfun-color',
  '302ai': 'ai302-color',
  aihubmix: 'aihubmix-color',
  novita: 'novita-color',
  openrouter: 'openrouter-color',
  xai: 'xai',
  'openai-usage': 'openai',
  'codex-plan': 'openai',
  'anthropic-usage': 'anthropic',
  'claude-plan': 'claude-color',
  'glm-plan': 'chatglm-color',
  'zhipu-balance': 'chatglm-color',
  'zai-plan': 'zai',
  'minimax-plan': 'minimax-color',
  'minimax-balance': 'minimax-color',
  newapi: 'newapi-color',
  'opencode-go': 'opencode',
  'opencode-balance': 'opencode',
  gemini: 'gemini-color',
  groq: 'groq',
  'aliyun-bailian': 'bailian-color',
  'volcengine-ark': 'volcengine-color',
  'baidu-qianfan': 'baiducloud-color',
  'tencent-hunyuan': 'hunyuan-color',
  sensenova: 'sensenova-color',
  together: 'together-color',
  fireworks: 'fireworks-color',
  mistral: 'mistral-color',
}

async function loadIcon(slug) {
  const file = path.join(iconDir, `${slug}.svg`)
  const raw = await fs.readFile(file, 'utf8').catch(() => null)
  if (!raw) return undefined
  const svg = raw
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace(/\s(?:width|height)="1em"/g, '')
    .replace(/\sstyle="[^"]*"/g, '')
    .trim()
  if (!svg.includes('viewBox')) return undefined
  // 部分彩色标识也用 currentColor 画黑色细节，不能因此把整张图变成单色。
  const mono = !/(?:fill|stop-color)="(?:#[0-9a-f]{3,8}|url\()/i.test(svg)
  // 彩色图固定其深色细节，配合 BrandIcon 的白底，不依赖 <img> 的 currentColor。
  const normalized = mono ? svg.replace(/\sfill="currentColor"/g, '') : svg.replace(/currentColor/g, '#20242b')
  return { svg: normalized, mono }
}

const entries = []
const missing = []
for (const [providerId, slug] of Object.entries(MAP)) {
  const icon = await loadIcon(slug)
  if (!icon) {
    missing.push(`${providerId} → ${slug}.svg`)
    continue
  }
  entries.push(
    `  ${JSON.stringify(providerId)}: { mono: ${icon.mono}, src: 'data:image/svg+xml;base64,${Buffer.from(icon.svg, 'utf8').toString('base64')}' },`,
  )
}

const banner = `// 由 scripts/build-brands.mjs 生成，请勿手改。
// 图标数据来自 @lobehub/icons-static-svg（MIT）；商标权归各厂商，仅用于在本机看板中标识对应服务商。
// mono: true 表示原图是单色（跟随 currentColor），渲染时走 CSS mask 上色。

export interface BrandMark {
  src: string
  mono: boolean
  /** 单色图自带的品牌色；缺失时用卡片色上色。 */
  tint?: string
}

export const BRAND_ICONS: Record<string, BrandMark> = {
`

await fs.writeFile(outFile, `${banner}${entries.join('\n')}\n}\n`, 'utf8')
const size = (await fs.stat(outFile)).size
console.log(`[brands] ${path.relative(root, outFile)} ${(size / 1024).toFixed(0)} KB，${entries.length} 个厂商图标`)
if (missing.length) console.log(`[brands] 缺图回退首字母：${missing.join('、')}`)
