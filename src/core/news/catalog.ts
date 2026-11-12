import type { AccountPublic, LogSourceSetting } from '../types'
import type { NewsStream, NewsTopic } from './types'

export interface NewsSource {
  id: string
  topicId: string
  stream?: NewsStream
  label: string
  url: string
  website: string
  parser: 'feed' | 'minimax' | 'kimi' | 'anthropic' | 'deepseek' | 'minimax-notes' | 'pricing'
  allowedHosts: string[]
  releasePrefix?: string
  watch?: { selector: string; tablesOnly?: boolean; excludeSections?: string[]; note?: string }
  feedPages?: number
  /** 订阅内容没有正文时，回源抓原文正文用的选择器。 */
  articleSelector?: string
}

export const NEWS_TOPICS: NewsTopic[] = [
  { id: 'openai', label: 'OpenAI', kind: 'vendor', providerId: 'codex-plan', description: '模型、ChatGPT 与 API 公告' },
  { id: 'anthropic', label: 'Anthropic', kind: 'vendor', providerId: 'claude-plan', description: 'Claude 模型与产品公告' },
  { id: 'google', label: 'Google DeepMind', kind: 'vendor', providerId: 'gemini', description: 'Gemini 模型与产品动态' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'vendor', providerId: 'deepseek', description: '模型、API 价格与更新日志' },
  { id: 'kimi', label: 'Kimi', kind: 'vendor', providerId: 'kimi-code-plan', description: 'Kimi 模型与官方研究发布' },
  { id: 'minimax', label: 'MiniMax', kind: 'vendor', providerId: 'minimax-plan', description: '模型与 MiniMax 产品更新' },
  { id: 'codex', label: 'Codex', kind: 'tool', providerId: 'codex-plan', description: '官方客户端版本与功能更新' },
  { id: 'claude-code', label: 'Claude Code', kind: 'tool', providerId: 'claude-plan', description: '官方 GitHub 发布记录' },
  { id: 'kimi-code', label: 'Kimi Code', kind: 'tool', providerId: 'kimi-code-plan', description: 'Kimi Code CLI 官方发布记录' },
  { id: 'opencode', label: 'OpenCode', kind: 'tool', providerId: 'opencode-go', description: '官方客户端发布记录' },
]

const release = (id: string, label: string, repo: string): NewsSource => ({
  id, topicId: id, label: `${label} Releases`, url: `https://github.com/${repo}/releases.atom`,
  website: `https://github.com/${repo}/releases`, parser: 'feed', allowedHosts: ['github.com'],
  releasePrefix: `/${repo}/releases/tag/`,
})

const pricing = (id: string, topicId: string, label: string, url: string, selector: string, tablesOnly = true, excludeSections?: string[], note?: string): NewsSource => ({
  id, topicId, label, url, website: url, parser: 'pricing', allowedHosts: [new URL(url).hostname], watch: { selector, tablesOnly, excludeSections, note },
})

export const NEWS_SOURCES: NewsSource[] = [
  { id: 'openai-news', topicId: 'openai', label: 'OpenAI 官方公告', url: 'https://openai.com/news/rss.xml', website: 'https://openai.com/news/', parser: 'feed', allowedHosts: ['openai.com', 'www.openai.com'] },
  { id: 'anthropic-news', topicId: 'anthropic', label: 'Anthropic Newsroom', url: 'https://www.anthropic.com/news', website: 'https://www.anthropic.com/news', parser: 'anthropic', allowedHosts: ['www.anthropic.com', 'anthropic.com'] },
  { id: 'google-news', topicId: 'google', label: 'Google DeepMind 官方博客', url: 'https://deepmind.google/blog/rss.xml', website: 'https://deepmind.google/blog/', parser: 'feed', allowedHosts: ['deepmind.google', 'blog.google'] },
  { id: 'deepseek-news', topicId: 'deepseek', label: 'DeepSeek 官方更新日志', url: 'https://api-docs.deepseek.com/updates/', website: 'https://api-docs.deepseek.com/updates/', parser: 'deepseek', allowedHosts: ['api-docs.deepseek.com'] },
  { id: 'kimi-news', topicId: 'kimi', label: 'Kimi 官方博客', url: 'https://www.kimi.com/en/blog/', website: 'https://www.kimi.com/en/blog/', parser: 'kimi', allowedHosts: ['www.kimi.com', 'kimi.com'] },
  { id: 'minimax-news', topicId: 'minimax', label: 'MiniMax Research', url: 'https://www.minimax.io/blog', website: 'https://www.minimax.io/blog', parser: 'minimax', allowedHosts: ['www.minimax.io', 'minimax.io'] },
  release('codex', 'Codex', 'openai/codex'),
  release('claude-code', 'Claude Code', 'anthropics/claude-code'),
  release('kimi-code', 'Kimi Code', 'MoonshotAI/kimi-code'),
  release('opencode', 'OpenCode', 'anomalyco/opencode'),
  { id: 'minimax-notes', topicId: 'minimax', label: 'MiniMax 模型更新日志', url: 'https://platform.minimax.io/docs/release-notes/models', website: 'https://platform.minimax.io/docs/release-notes/models', parser: 'minimax-notes', allowedHosts: ['platform.minimax.io'] },
  pricing('openai-pricing', 'openai', 'OpenAI API 定价', 'https://developers.openai.com/api/docs/pricing', 'article'),
  pricing('anthropic-pricing', 'anthropic', 'Claude API 定价', 'https://platform.claude.com/docs/en/about-claude/pricing', 'article'),
  pricing('google-pricing', 'google', 'Gemini API 定价', 'https://ai.google.dev/gemini-api/docs/pricing', 'main'),
  pricing('deepseek-pricing', 'deepseek', 'DeepSeek API 定价', 'https://api-docs.deepseek.com/quick_start/pricing/', 'article'),
  pricing('kimi-pricing', 'kimi', 'Kimi API 计费说明', 'https://platform.kimi.com/docs/pricing/chat', '.mdx-content', false, undefined, 'Kimi 目前仅比较说明正文，动态价格表和限速表请到原文核对。'),
  pricing('kimi-limits', 'kimi', 'Kimi API 限速说明', 'https://platform.kimi.com/docs/pricing/limits', '.mdx-content', false, undefined, 'Kimi 目前仅比较说明正文，动态价格表和限速表请到原文核对。'),
  pricing('minimax-pricing', 'minimax', 'MiniMax API 定价', 'https://platform.minimax.io/docs/pricing/overview', '.mdx-content'),
  pricing('minimax-plan', 'minimax', 'MiniMax M Plan 额度规则', 'https://platform.minimax.io/docs/m-plan/intro', '.mdx-content', false, ['supported-products']),
  pricing('codex-pricing', 'codex', 'Codex 套餐与用量规则', 'https://learn.chatgpt.com/docs/pricing', 'article', false, ['invite-friends-and-coworkers', 'feature-availability']),
  { id: 'qbitai', topicId: 'all', stream: 'media', label: '量子位', url: 'https://www.qbitai.com/feed', website: 'https://www.qbitai.com/', parser: 'feed', feedPages: 4, allowedHosts: ['www.qbitai.com', 'qbitai.com'], articleSelector: '.article' },
  { id: 'ithome', topicId: 'all', stream: 'media', label: 'IT之家', url: 'https://www.ithome.com/rss/', website: 'https://www.ithome.com/', parser: 'feed', allowedHosts: ['www.ithome.com', 'ithome.com'], articleSelector: '.post_content' },
  { id: 'tmtpost', topicId: 'all', stream: 'media', label: '钛媒体', url: 'https://www.tmtpost.com/rss.xml', website: 'https://www.tmtpost.com/', parser: 'feed', allowedHosts: ['www.tmtpost.com', 'tmtpost.com'], articleSelector: 'article' },
  { id: 'zhidx', topicId: 'all', stream: 'media', label: '智东西', url: 'https://www.zhidx.com/rss', website: 'https://www.zhidx.com/', parser: 'feed', allowedHosts: ['zhidx.com', 'www.zhidx.com'], articleSelector: '.post-content' },
]

/** 媒体源会混进大量与 AI 无关的科技新闻（汽车、耳机、促销），媒体流只保留 AI 相关报道。 */
const AI_MEDIA_PATTERN = /(?<![A-Za-z])(AI|AIGC|AGI|LLM|GPT|GLM|RLHF|RAG|MCP|GPU|NPU|TPU|NVIDIA|OpenAI|Anthropic|Claude|Gemini|DeepSeek|Kimi|MiniMax|Qwen|Grok|Llama|Copilot|Cursor|Cline|Codex|OpenCode|Windsurf|Devin|Transformer|Sora|Diffusion|Runway|Midjourney|Agent|Opus|Sonnet|Haiku|Seedream|Seedance|SiliconFlow|Moonshot|Manus)(?![A-Za-z])|大模型|大语言模型|大语言|人工智能|机器学习|深度学习|神经网络|生成式|智能体|多模态|提示词|具身智能|机器人|自动驾驶|智能驾驶|算力|智算|向量数据库|微调|蒸馏|推理模型|基础模型|深度求索|智谱|通义|千问|文心|豆包|混元|元宝|月之暗面|海螺|稀宇|英伟达|黄仁勋|编程助手|代码助手|AI编程|数字人|语音克隆|图像生成|视频生成|机器翻译|机器视觉|无人驾驶|算力中心|智算中心|训练集群|推理卡|智能芯片|硅基流动|寒武纪|液冷/i

/** 媒体流按 AI 相关性取舍，不受关注对象限制。 */
export function isAiMediaArticle(text: string): boolean {
  return AI_MEDIA_PATTERN.test(text)
}

/** Match the article itself rather than unrelated uses of vendor and tool names. */
export function matchingNewsTopics(text: string): string[] {
  const patterns: Record<string, RegExp> = {
    openai: /OpenAI|ChatGPT|\bGPT[-\s]?\d/i, anthropic: /Anthropic|Claude|克劳德/i,
    google: /Gemini|DeepMind|谷歌.*(?:模型|AI)|Google\s+AI/i, deepseek: /DeepSeek|深度求索/i,
    kimi: /\bKimi\b|月之暗面/i, minimax: /\bMiniMax\b|海螺\s*AI|稀宇/i,
    codex: /\bCodex\b/i, 'claude-code': /Claude\s*Code/i, 'kimi-code': /Kimi[\s-]*(?:Code|CLI)/i, opencode: /\bOpenCode\b/i,
  }
  const ambiguous = new Set<string>()
  if (/minimax\s+(?:algorithm|search|tree)|alpha[- ]beta|tic[- ]tac[- ]toe|极小极大算法/i.test(text) && !/MiniMax[-\s]?(?:M|H)\d|MiniMaxAI|海螺|稀宇/i.test(text)) ambiguous.add('minimax')
  if (/gemini\s+protocol|geminispace|gemini\s+capsules?/i.test(text) && !/Google|DeepMind|\bLLM\b/i.test(text)) ambiguous.add('google')
  if (/kimi\s+r[aä]ikk[oö]nen|kimi\s+antonelli/i.test(text) && !/Moonshot|月之暗面|Kimi[-\s]?(?:K\d|Code|CLI)/i.test(text)) ambiguous.add('kimi')
  if (/codex\s+(?:sinaiticus|alimentarius)|aztec\s+codex/i.test(text) && !/OpenAI|ChatGPT|\bCLI\b/i.test(text)) { ambiguous.add('codex'); ambiguous.add('openai') }
  const ids = NEWS_TOPICS.filter(topic => patterns[topic.id].test(text) && !ambiguous.has(topic.id)).map(topic => topic.id)
  if (ids.includes('codex') && !ids.includes('openai')) ids.push('openai')
  return ids
}

export function suggestedNewsTopics(accounts: AccountPublic[], logSources: LogSourceSetting[]): { ids: string[]; mode: 'accounts' | 'recommended' } {
  const ids = new Set<string>()
  for (const account of accounts.filter(account => account.enabled)) {
    const provider = account.providerId
    if (['openai-usage', 'codex-plan'].includes(provider)) ids.add('openai')
    if (provider === 'codex-plan') ids.add('codex')
    if (['anthropic-usage', 'claude-plan'].includes(provider)) ids.add('anthropic')
    if (provider === 'gemini') ids.add('google')
    if (provider === 'deepseek') ids.add('deepseek')
    if (provider.startsWith('kimi-')) ids.add('kimi')
    if (provider === 'kimi-code-plan') ids.add('kimi-code')
    if (provider.startsWith('minimax-')) ids.add('minimax')
    if (provider.startsWith('opencode-')) ids.add('opencode')
  }
  for (const source of logSources.filter(source => source.enabled)) {
    if (['codex', 'claude-code', 'kimi-code', 'opencode'].includes(source.id)) ids.add(source.id)
  }
  return ids.size ? { ids: [...ids], mode: 'accounts' } : { ids: ['openai', 'kimi', 'minimax', 'codex'], mode: 'recommended' }
}
