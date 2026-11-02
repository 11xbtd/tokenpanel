import type { AccountPublic, LogSourceSetting } from '../types'
import type { NewsTopic } from './types'

export interface NewsSource {
  id: string
  topicId: string
  label: string
  url: string
  website: string
  parser: 'feed' | 'minimax' | 'kimi' | 'anthropic' | 'deepseek'
  allowedHosts: string[]
  releasePrefix?: string
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
]

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
