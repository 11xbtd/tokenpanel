import { promises as fs } from 'node:fs'
import path from 'node:path'

const SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const OUT = path.resolve('src/core/pricing/snapshot.json')
const ALLOWED_MODES = new Set(['chat', 'completion', 'responses'])
const TIER_RE = /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens$/

const round = (value) => Math.round(value * 1e6) / 1e6
const perM = (value) => (typeof value === 'number' && Number.isFinite(value) ? round(value * 1_000_000) : undefined)

async function main() {
  const force = process.argv.includes('--force')
  const exists = await fs.access(OUT).then(() => true).catch(() => false)
  if (exists && !force) {
    const stat = await fs.stat(OUT)
    const ageDays = (Date.now() - stat.mtimeMs) / 86_400_000
    if (ageDays < 7) {
      console.log(`[prices] 快照 ${ageDays.toFixed(1)} 天前生成，跳过下载（--force 可强制更新）`)
      return
    }
  }
  let raw
  try {
    const response = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    raw = await response.json()
  } catch (error) {
    const exists = await fs.access(OUT).then(() => true).catch(() => false)
    if (exists) {
      console.warn(`[prices] 下载失败（${error.message}），保留现有快照`)
      return
    }
    throw error
  }

  const models = {}
  let skippedMode = 0
  let skippedPrice = 0
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'sample_spec' || !value || typeof value !== 'object') continue
    const mode = typeof value.mode === 'string' ? value.mode : ''
    if (mode && !ALLOWED_MODES.has(mode)) {
      skippedMode++
      continue
    }
    const input = perM(value.input_cost_per_token)
    const output = perM(value.output_cost_per_token)
    if (input === undefined && output === undefined) {
      skippedPrice++
      continue
    }
    const tiers = new Map()
    for (const [field, price] of Object.entries(value)) {
      const match = TIER_RE.exec(field)
      if (!match || typeof price !== 'number' || !Number.isFinite(price)) continue
      const aboveTokens = Number(match[2]) * 1000
      const tier = tiers.get(aboveTokens) ?? { aboveTokens }
      if (match[1] === 'input_cost_per_token') tier.inputPerM = perM(price)
      if (match[1] === 'output_cost_per_token') tier.outputPerM = perM(price)
      if (match[1] === 'cache_read_input_token_cost') tier.cacheReadPerM = perM(price)
      if (match[1] === 'cache_creation_input_token_cost') tier.cacheWritePerM = perM(price)
      tiers.set(aboveTokens, tier)
    }
    models[key] = {
      model: key,
      provider: typeof value.litellm_provider === 'string' ? value.litellm_provider : undefined,
      inputPerM: input ?? output,
      outputPerM: output ?? input,
      cacheReadPerM: perM(value.cache_read_input_token_cost),
      cacheWritePerM: perM(value.cache_creation_input_token_cost),
      maxInputTokens: typeof value.max_input_tokens === 'number' ? value.max_input_tokens : undefined,
      mode: mode || undefined,
      tiers: tiers.size ? [...tiers.values()].sort((a, b) => a.aboveTokens - b.aboveTokens) : undefined,
    }
  }

  const snapshot = {
    generatedAt: Date.now(),
    source: SOURCE,
    models,
  }
  await fs.mkdir(path.dirname(OUT), { recursive: true })
  await fs.writeFile(OUT, JSON.stringify(snapshot), 'utf8')
  const stat = await fs.stat(OUT)
  console.log(
    `[prices] ${Object.keys(models).length} 个模型，跳过 mode ${skippedMode} / 无价格 ${skippedPrice}，${(stat.size / 1024).toFixed(0)} KB`,
  )
}

main().catch((error) => {
  console.error('[prices] 失败:', error.message)
  process.exit(1)
})
