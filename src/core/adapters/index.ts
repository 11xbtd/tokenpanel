import * as balance from './balance'
import * as plans from './plans'
import { anthropicUsage, openaiUsage } from './usage'
import { relayBalance, relayUsage } from './relay'
import { customQuota } from './custom'
import type { ProviderAdapter } from './types'

export const ADAPTERS: Record<string, ProviderAdapter> = {
  deepseek: { balance: balance.deepseekBalance },
  'kimi-cn': { balance: balance.kimiBalance },
  'kimi-global': { balance: balance.kimiBalance },
  stepfun: { balance: balance.stepfunBalance },
  '302ai': { balance: balance.ai302Balance },
  aihubmix: { balance: balance.aihubmixBalance },
  novita: { balance: balance.novitaBalance },
  openrouter: { balance: balance.openrouterBalance },
  xai: { balance: balance.xaiBalance },
  'openai-usage': { usage: openaiUsage },
  'anthropic-usage': { usage: anthropicUsage },
  'glm-plan': { plan: plans.glmPlan },
  'zai-plan': { plan: plans.zaiPlan },
  'minimax-plan': { plan: plans.minimaxPlan },
  'claude-plan': { plan: plans.claudePlan },
  'codex-plan': { plan: plans.codexPlan },
  'kimi-code-plan': { plan: plans.kimiCodePlan },
  'opencode-go': { plan: plans.openCodeGoPlan },
  newapi: { balance: relayBalance, usage: relayUsage },
  'custom-http': { custom: customQuota },
}

export function getAdapter(providerId: string): ProviderAdapter | undefined {
  return ADAPTERS[providerId]
}
