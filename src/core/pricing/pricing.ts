import snapshot from './snapshot.json'
import type { ModelPrice, PriceOverridesFile, SnapshotFile } from './types'

const DATA = snapshot as unknown as SnapshotFile

const PROVIDER_ALIASES: Record<string, string[]> = {
  deepseek: ['deepseek'],
  'kimi-cn': ['moonshot', 'moonshotai'],
  'kimi-global': ['moonshot', 'moonshotai'],
  stepfun: ['stepfun', 'stepfun-ai'],
  '302ai': ['302ai'],
  aihubmix: ['aihubmix'],
  novita: ['novita'],
  openrouter: ['openrouter'],
  xai: ['xai'],
  'openai-usage': ['openai', 'azure', 'azure_ai'],
  'anthropic-usage': ['anthropic', 'vertex_ai', 'bedrock'],
  'glm-plan': ['zhipu', 'zhipuai', 'bigmodel'],
  'zai-plan': ['zai', 'zhipu'],
  'zhipu-balance': ['zhipu', 'zhipuai', 'bigmodel'],
  'minimax-plan': ['minimax'],
  'minimax-balance': ['minimax'],
  'claude-plan': ['anthropic'],
  'codex-plan': ['openai'],
  'kimi-code-plan': ['moonshot'],
  gemini: ['gemini', 'google'],
  groq: ['groq'],
  mistral: ['mistral'],
  'aliyun-bailian': ['alibaba', 'qwen', 'dashscope', 'aliyun'],
  'volcengine-ark': ['volcengine', 'ark', 'doubao', 'bytedance'],
  'baidu-qianfan': ['baidu', 'qianfan', 'ernie'],
  'tencent-hunyuan': ['tencent', 'hunyuan'],
  sensenova: ['sensenova', 'sensetime'],
  together: ['together', 'togetherai'],
  fireworks: ['fireworks', 'fireworks_ai'],
}

const RESELLER_PROVIDERS = new Set(['openrouter', 'azure', 'azure_ai', 'bedrock', 'vertex_ai', 'cloudflare', 'fireworks_ai', 'together_ai'])

function stripSuffix(value: string): string {
  return value
    .replace(/:(free|nitro|extended|online|floor)$/i, '')
    .replace(/@[a-z0-9._-]+$/i, '')
    .replace(/-(latest)$/i, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/i, '')
    .replace(/-\d{8}$/i, '')
}

function normalize(value: string): string {
  let model = value.trim().toLowerCase()
  model = model.replace(/^models\//, '').split('?')[0]
  model = stripSuffix(model)
  return model
}

function baseName(value: string): string {
  const parts = value.split('/')
  return parts[parts.length - 1] ?? value
}

interface Candidate {
  price: ModelPrice
  key: string
  base: string
  provider?: string
}

export interface PriceMatch {
  price: ModelPrice
  matchKey: string
  overridden: boolean
  confidence: 'exact' | 'base' | 'prefix'
}

export class Pricing {
  private candidates: Candidate[] = []
  private exact = new Map<string, Candidate[]>()
  private byBase = new Map<string, Candidate[]>()
  private overrides: PriceOverridesFile
  private fx: number

  constructor(overrides: PriceOverridesFile, fxUsdCny: number) {
    this.overrides = overrides
    this.fx = fxUsdCny > 0 ? fxUsdCny : 7.2
    for (const price of Object.values(DATA.models)) {
      this.addCandidate({
        price,
        key: normalize(price.model),
        base: normalize(baseName(price.model)),
        provider: price.provider,
      })
    }
  }

  private addCandidate(candidate: Candidate): void {
    if (!candidate.key) return
    this.candidates.push(candidate)
    const exact = this.exact.get(candidate.key) ?? []
    exact.push(candidate)
    this.exact.set(candidate.key, exact)
    const base = this.byBase.get(candidate.base) ?? []
    base.push(candidate)
    this.byBase.set(candidate.base, base)
  }

  get modelCount(): number {
    return Object.keys(DATA.models).length
  }

  get updatedAt(): number {
    return DATA.generatedAt
  }

  get source(): string {
    return DATA.source
  }

  get fxRate(): number {
    return this.fx
  }

  setFx(rate: number): void {
    if (Number.isFinite(rate) && rate > 0) this.fx = rate
  }

  setOverrides(overrides: PriceOverridesFile): void {
    this.overrides = overrides
  }

  private providerMatches(provider: string | undefined, providerId?: string): boolean {
    if (!provider || !providerId) return false
    const aliases = PROVIDER_ALIASES[providerId] ?? [providerId]
    return aliases.some((alias) => provider === alias || provider.startsWith(`${alias}/`) || provider.includes(alias))
  }

  private overrideFor(model: string): ModelPrice | undefined {
    const key = model.trim().toLowerCase()
    for (const [name, override] of Object.entries(this.overrides.models)) {
      if (name.trim().toLowerCase() !== key) continue
      const factor = override.currency === 'CNY' ? 1 / this.fx : 1
      return {
        model: name,
        inputPerM: override.inputPerM * factor,
        outputPerM: override.outputPerM * factor,
        cacheReadPerM: override.cacheReadPerM !== undefined ? override.cacheReadPerM * factor : undefined,
        cacheWritePerM: override.cacheWritePerM !== undefined ? override.cacheWritePerM * factor : undefined,
      }
    }
    return undefined
  }

  lookup(model: string, providerId?: string): PriceMatch | undefined {
    const override = this.overrideFor(model)
    if (override) return { price: override, matchKey: model, overridden: true, confidence: 'exact' }

    const key = normalize(model)
    const base = normalize(baseName(model))

    const score = (candidate: Candidate, kind: 'exact' | 'base' | 'prefix'): number => {
      let value = kind === 'exact' ? 100 : kind === 'base' ? 80 : 55
      if (this.providerMatches(candidate.provider, providerId)) value += 20
      else if (candidate.provider && RESELLER_PROVIDERS.has(candidate.provider)) value -= 12
      if (candidate.price.maxInputTokens && candidate.price.maxInputTokens > 200_000) value += 1
      return value
    }

    const consider = (candidates: Candidate[] | undefined, kind: 'exact' | 'base' | 'prefix'): Candidate | undefined => {
      if (!candidates?.length) return undefined
      return [...candidates].sort((a, b) => score(b, kind) - score(a, kind))[0]
    }

    const exact = consider(this.exact.get(key), 'exact')
    if (exact) return { price: exact.price, matchKey: exact.price.model, overridden: false, confidence: 'exact' }

    const baseExact = consider(this.byBase.get(base), 'base')
    if (baseExact) return { price: baseExact.price, matchKey: baseExact.price.model, overridden: false, confidence: 'base' }

    if (base.length >= 4) {
      const prefixes = this.candidates.filter((candidate) => {
        if (candidate.base.length < 4) return false
        if (candidate.base.startsWith(`${base}-`)) return true
        if (base.startsWith(`${candidate.base}-`)) return true
        return false
      })
      const match = consider(prefixes, 'prefix')
      if (match) return { price: match.price, matchKey: match.price.model, overridden: false, confidence: 'prefix' }
    }
    return undefined
  }

  estimateCost(usage: {
    model: string
    providerId?: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }): { usdMicros: number; estimated: boolean; missingPrice: boolean; matchKey?: string } {
    const match = this.lookup(usage.model, usage.providerId)
    if (!match) {
      return { usdMicros: 0, estimated: true, missingPrice: true }
    }
    const price = match.price
    const input = Math.max(0, usage.inputTokens)
    const output = Math.max(0, usage.outputTokens)
    const cacheRead = Math.max(0, usage.cacheReadTokens)
    const cacheWrite = Math.max(0, usage.cacheWriteTokens)

    let inputPerM = price.inputPerM
    let outputPerM = price.outputPerM
    let cacheReadPerM = price.cacheReadPerM
    let cacheWritePerM = price.cacheWritePerM
    const tier = [...(price.tiers ?? [])]
      .filter((item) => input >= item.aboveTokens)
      .sort((a, b) => b.aboveTokens - a.aboveTokens)[0]
    if (tier) {
      inputPerM = tier.inputPerM ?? inputPerM
      outputPerM = tier.outputPerM ?? outputPerM
      cacheReadPerM = tier.cacheReadPerM ?? cacheReadPerM
      cacheWritePerM = tier.cacheWritePerM ?? cacheWritePerM
    }
    const readRate = cacheReadPerM ?? inputPerM * 0.1
    const writeRate = cacheWritePerM ?? inputPerM * 1.25

    const usd =
      (input * inputPerM + output * outputPerM + cacheRead * readRate + cacheWrite * writeRate) / 1_000_000
    return {
      usdMicros: Math.round(usd * 1_000_000),
      estimated: !match.overridden && match.confidence !== 'exact',
      missingPrice: false,
      matchKey: match.matchKey,
    }
  }
}
