import type { AccountPublic, BillingMode, LogSourceBinding, LogSourceSetting } from '../types'
import { getProvider } from '../providers/registry'

/**
 * 按模型名归属：只认模型名里自带厂商的（kimi、glm、minimax、deepseek…）。
 * 每个厂商给一串**候选账户**，按顺序取第一个已存在的：
 * 先套餐后按量——同一个模型既可能是订阅调用（Kimi Code），
 * 也可能是按量 API key 调用（在客户端里配的 DeepSeek key），由你建了哪种账户决定。
 * Qoder 的 dfmodel/qfmodel 这类是客户端内部 key，同一个 key 可能指向任何厂商
 * （用户自配的 MiniMax 就叫 dfmodel），写死规则会算错，所以不在这里认，交给日志源里显式绑定。
 */
const MODEL_RULES: Array<{ pattern: RegExp; providerIds: string[] }> = [
  // 订阅专用模型名：只可能来自套餐客户端，只认套餐账户（避免把订阅调用算成按量）。
  { pattern: /kimi-for-coding|kimi-code\/|k3-/i, providerIds: ['kimi-code-plan'] },
  { pattern: /codex/i, providerIds: ['codex-plan'] },
  // 通用厂商模型名：先匹配套餐账户，没有再匹配按量账户。
  { pattern: /kimi|moonshot/i, providerIds: ['kimi-code-plan', 'kimi-cn', 'kimi-global'] },
  { pattern: /glm|zhipu|bigmodel/i, providerIds: ['glm-plan', 'zai-plan', 'zhipu-balance'] },
  { pattern: /minimax/i, providerIds: ['minimax-plan', 'minimax-balance'] },
  { pattern: /claude|anthropic/i, providerIds: ['claude-plan'] },
  { pattern: /gpt-|^o[134]/i, providerIds: ['codex-plan'] },
  // 按量厂商：客户端里配的 API key 调用。
  { pattern: /deepseek/i, providerIds: ['deepseek'] },
  { pattern: /qwen|qwq|dashscope/i, providerIds: ['aliyun-bailian'] },
  { pattern: /gemini/i, providerIds: ['gemini'] },
  { pattern: /grok/i, providerIds: ['xai'] },
  { pattern: /step-?fun/i, providerIds: ['stepfun'] },
  { pattern: /groq/i, providerIds: ['groq'] },
  { pattern: /mistral/i, providerIds: ['mistral'] },
  { pattern: /hunyuan/i, providerIds: ['tencent-hunyuan'] },
  { pattern: /ernie|qianfan/i, providerIds: ['baidu-qianfan'] },
  { pattern: /doubao|volcengine/i, providerIds: ['volcengine-ark'] },
  { pattern: /sensenova/i, providerIds: ['sensenova'] },
]

/**
 * 按日志里的厂商线索归属：ZCode 的 model_usage.provider_id 直接写着套餐来源
 * （builtin:bigmodel-start-plan = 智谱 GLM 编程套餐，builtin:bigmodel = 按量 BigModel），
 * 比模型名更可靠，模型名被用户改过时也能认出来。
 */
const PROVIDER_HINT_RULES: Array<{ pattern: RegExp; providerIds: string[] }> = [
  { pattern: /bigmodel-start-plan/i, providerIds: ['glm-plan', 'zai-plan'] },
  { pattern: /bigmodel/i, providerIds: ['zhipu-balance'] },
  { pattern: /zhipu/i, providerIds: ['zhipu-balance', 'glm-plan'] },
  { pattern: /minimax/i, providerIds: ['minimax-plan', 'minimax-balance'] },
  { pattern: /moonshot|kimi/i, providerIds: ['kimi-code-plan', 'kimi-cn', 'kimi-global'] },
  { pattern: /anthropic|claude/i, providerIds: ['claude-plan'] },
  { pattern: /openai|gpt|codex/i, providerIds: ['codex-plan'] },
  { pattern: /openrouter/i, providerIds: ['openrouter'] },
  { pattern: /deepseek/i, providerIds: ['deepseek'] },
  { pattern: /google|gemini/i, providerIds: ['gemini'] },
  { pattern: /groq/i, providerIds: ['groq'] },
  { pattern: /opencode/i, providerIds: ['opencode-go', 'opencode-balance'] },
  { pattern: /mistral/i, providerIds: ['mistral'] },
  { pattern: /xai|grok/i, providerIds: ['xai'] },
]

/** 账户落在哪个页签：订阅套餐预设与登记了窗口的手动账户都算套餐侧。 */
export function accountBillingMode(account: AccountPublic): BillingMode | 'mixed' {
  const preset = getProvider(account.providerId)
  if (preset?.category === 'plan' || preset?.defaultBillingMode === 'plan') return 'plan'
  if (preset?.category === 'manual') {
    const hasPlan = (account.options.manualPlan?.windows?.length ?? 0) > 0
    const hasBalance = Boolean(account.options.manualBalance)
    if (hasPlan && hasBalance) return 'mixed'
    if (hasPlan) return 'plan'
  }
  return 'api'
}

/** 本机日志记录归属到账户后的计费侧：日志只有 token，没有厂商金额，所以倾向套餐。 */
export function logBillingModeForAccount(account: AccountPublic): BillingMode {
  const preset = getProvider(account.providerId)
  if (preset?.category === 'plan' || preset?.defaultBillingMode === 'plan') return 'plan'
  if ((account.options.manualPlan?.windows?.length ?? 0) > 0) return 'plan'
  return 'api'
}

function patternMatches(model: string, pattern?: string): boolean {
  if (!pattern) return false
  const text = pattern.trim()
  if (!text) return false
  try {
    return new RegExp(text, 'i').test(model)
  } catch {
    return model.toLowerCase().includes(text.toLowerCase())
  }
}

export function autoAccountForSource(sourceId: string, accounts: AccountPublic[]): string | undefined {
  const preferred: Record<string, string[]> = {
    'kimi-code': ['kimi-code-plan'],
    'kimi-cli': ['kimi-code-plan'],
    'claude-code': ['claude-plan'],
    codex: ['codex-plan'],
    opencode: ['opencode-go', 'opencode-balance'],
  }
  for (const providerId of preferred[sourceId] ?? []) {
    const account = accounts.find((item) => item.providerId === providerId)
    if (account) return account.id
  }
  return undefined
}

/** 新发现的来源先按客户端suggest一条默认归属，用户可以再加细分规则。 */
export function defaultBindingsFor(sourceId: string, accounts: AccountPublic[]): LogSourceBinding[] {
  const accountId = autoAccountForSource(sourceId, accounts)
  return accountId ? [{ accountId }] : []
}

/** 这个模型的自动规则指向哪些预设（按优先级）；没命中规则返回空数组。 */
export function suggestedProviders(model: string, hint?: string): string[] {
  // 厂商线索比模型名硬：ZCode 里 builtin:bigmodel（按量）与 builtin:bigmodel-start-plan（套餐）
  // 指向同一批模型，只有 provider_id 能分清。
  if (hint) {
    const byHint = PROVIDER_HINT_RULES.find((rule) => rule.pattern.test(hint))?.providerIds
    if (byHint) return byHint
  }
  return MODEL_RULES.find((rule) => rule.pattern.test(model))?.providerIds ?? []
}

export function resolveAccountForRecord(
  model: string,
  setting: LogSourceSetting | undefined,
  accounts: AccountPublic[],
  hint?: string,
): { account?: AccountPublic; via: 'manual' | 'auto' | 'provider' | 'none' } {
  const bindings = setting?.bindings ?? []
  const byAccount = (accountId?: string) => (accountId ? accounts.find((item) => item.id === accountId) : undefined)
  const byProvider = (providerId: string) => accounts.find((item) => item.providerId === providerId)

  // 1. 显式“绑定账户 + 模型匹配”优先，可写多条，让一个客户端同时喂给多个套餐。
  for (const binding of bindings) {
    if (binding.modelPattern && patternMatches(model, binding.modelPattern)) {
      const account = byAccount(binding.accountId)
      if (account) return { account, via: 'manual' }
      // 用户明确指定了归属账户，但账户没了：宁可不落，也别乱归。
      return { via: 'none' }
    }
  }
  // 2. 日志自带的厂商线索（ZCode 的 provider_id 等）比模型名更硬：
  // builtin:bigmodel（按量 BigModel）和 builtin:bigmodel-start-plan（GLM 编程套餐）
  // 用的是同一批模型名，只有 provider_id 能分清。
  if (hint) {
    for (const rule of PROVIDER_HINT_RULES) {
      if (!rule.pattern.test(hint)) continue
      for (const providerId of rule.providerIds) {
        const account = byProvider(providerId)
        if (account) return { account, via: 'provider' }
      }
      return { via: 'none' }
    }
  }
  // 3. 模型规则：候选预设按优先级取第一个已存在的账户
  //（先套餐后按量：订阅调用归套餐，按量 API key 调用归按量账户）。
  for (const rule of MODEL_RULES) {
    if (!rule.pattern.test(model)) continue
    for (const providerId of rule.providerIds) {
      const account = byProvider(providerId)
      if (account) return { account, via: 'auto' }
    }
    // 模型名明确是别家的，却没有对应账户：不落库，
    // 更不能落到默认绑定上——那等于把别家的调用算进这个套餐。
    return { via: 'none' }
  }
  // 4. 没有任何规则命中的模型（自定义 key），走不带模型匹配的默认绑定。
  for (const binding of bindings) {
    if (binding.modelPattern) continue
    const account = byAccount(binding.accountId)
    if (account) return { account, via: 'manual' }
  }
  return { via: 'none' }
}

export function bindingsChanged(before: LogSourceBinding[], after: LogSourceBinding[]): boolean {
  if (before.length !== after.length) return true
  return before.some((binding, index) => {
    const other = after[index]
    return binding.accountId !== other?.accountId || binding.modelPattern !== other?.modelPattern
  })
}

/** 归属映射变过的来源：已导入记录要清掉重扫，否则同一个 externalId 会既算未归属又算进账户。 */
export function reboundSources(previous: LogSourceSetting[], next: LogSourceSetting[]): LogSourceSetting[] {
  return next.filter((source) => {
    const old = previous.find((item) => item.id === source.id)
    return old !== undefined && bindingsChanged(old.bindings, source.bindings)
  })
}

/** 同一账户只需一条默认规则；再补带模型匹配的细分规则。 */
export function bindingKey(binding: LogSourceBinding): string {
  const pattern = binding.modelPattern?.trim()
  return pattern ? `pattern:${pattern}` : `default:${binding.accountId ?? ''}`
}
