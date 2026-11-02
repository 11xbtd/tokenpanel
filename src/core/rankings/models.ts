import type { RankedModel, RankingMetric } from './types'

type ObjectData = Record<string, unknown>
const record = (value: unknown): ObjectData => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectData : {}
const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : ''
const number = (value: unknown, nonnegative = true): number | null => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e12 && (!nonnegative || value >= 0) ? value : null

/** Normalize only documented Free API fields; missing measurements stay null. */
export function normalizeRankedModel(value: unknown): RankedModel | undefined {
  const model = record(value)
  const id = text(model.id, 160)
  const name = text(model.name, 220)
  const slug = text(model.slug, 160)
  if (!id || !name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(slug)) return undefined
  const creator = record(model.model_creator)
  const evaluations = record(model.evaluations)
  const pricing = record(model.pricing)
  const performance = record(model.performance)
  const cost = record(record(model.artificial_analysis_intelligence_index_cost).cost_per_task)
  const release = text(model.release_date, 10)
  return {
    id, name, slug, creator: text(creator.name, 100) || '未标注厂商', creatorId: text(creator.id, 160),
    releasedAt: /^\d{4}-\d{2}-\d{2}$/.test(release) && Number.isFinite(Date.parse(release)) ? release : null,
    intelligence: number(evaluations.artificial_analysis_intelligence_index, false),
    outputSpeed: number(performance.median_output_tokens_per_second),
    firstTokenSeconds: number(performance.median_time_to_first_token_seconds),
    firstAnswerSeconds: number(performance.median_time_to_first_answer_token_seconds),
    inputPrice: number(pricing.price_1m_input_tokens), outputPrice: number(pricing.price_1m_output_tokens),
    cacheReadPrice: number(pricing.price_1m_cache_hit_tokens), costPerTask: number(cost.total_cost),
  }
}

export function sortedRankedModels(models: RankedModel[], metric: RankingMetric): RankedModel[] {
  const descending = metric === 'intelligence' || metric === 'outputSpeed'
  return [...models].sort((a, b) => {
    const av = a[metric], bv = b[metric]
    if (av === null && bv !== null) return 1
    if (bv === null && av !== null) return -1
    if (av !== null && bv !== null && av !== bv) return descending ? bv - av : av - bv
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  })
}

/** Branding and followed-topic matching are local metadata, not AA evaluation fields. */
export function rankedCreatorBrand(name: string): { providerId: string; topicId?: string } {
  const value = name.toLowerCase().replace(/[\s._-]/g, '')
  if (value === 'openai') return { providerId: 'openai-usage', topicId: 'openai' }
  if (value === 'anthropic') return { providerId: 'claude-plan', topicId: 'anthropic' }
  if (value === 'google' || value === 'googledeepmind') return { providerId: 'gemini', topicId: 'google' }
  if (value === 'deepseek') return { providerId: 'deepseek', topicId: 'deepseek' }
  if (['kimi', 'moonshot', 'moonshotai'].includes(value)) return { providerId: 'kimi-code-plan', topicId: 'kimi' }
  if (value === 'minimax' || value === 'minimaxai') return { providerId: 'minimax-plan', topicId: 'minimax' }
  if (['zai', 'zhipuai', 'zhipu'].includes(value)) return { providerId: 'glm-plan' }
  if (['alibaba', 'qwen', 'alibabacloud'].includes(value)) return { providerId: 'aliyun-bailian' }
  if (value === 'bytedance') return { providerId: 'volcengine-ark' }
  if (value === 'baidu') return { providerId: 'baidu-qianfan' }
  if (value === 'tencent') return { providerId: 'tencent-hunyuan' }
  if (value === 'mistral' || value === 'mistralai') return { providerId: 'mistral' }
  if (value === 'xai' || value === 'spacexai') return { providerId: 'xai' }
  return { providerId: `aa-${value}` }
}

export function rankedCreatorFollowed(name: string, followedTopicIds: string[]): boolean {
  const topicId = rankedCreatorBrand(name).topicId
  const tools: Record<string, string> = { codex: 'openai', 'claude-code': 'anthropic', 'kimi-code': 'kimi' }
  return Boolean(topicId && followedTopicIds.some(id => id === topicId || tools[id] === topicId))
}
