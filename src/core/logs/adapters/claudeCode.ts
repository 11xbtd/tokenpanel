import os from 'node:os'
import path from 'node:path'
import type { LogFileStat, LogRecord, LogSourceAdapter } from '../types'
import { displayPath, exists, hashId, listFiles, numberValue, readJsonLines, statFile, timestampMs } from '../util'

function resolveHome(override?: string): string {
  return override ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
}

export function createClaudeCodeAdapter(homeOverride?: string): LogSourceAdapter {
  const root = resolveHome(homeOverride)
  const projectsDir = path.join(root, 'projects')

  return {
    id: 'claude-code',
    name: 'Claude Code',
    description: '读取 Claude Code 会话 JSONL；token/缓存可用，速度按相邻消息时间估算，不含首字耗时。',
    capabilities: { tokens: true, cache: true, speed: true, ttft: false },
    async detect() {
      return {
        available: await exists(projectsDir),
        paths: [displayPath(projectsDir)],
        note: 'GLM/MiniMax 等通过 Claude Code 接入时，也会写在这里，按模型名归属。',
      }
    },
    async listFiles(): Promise<LogFileStat[]> {
      const files = await listFiles(projectsDir, (name) => name.endsWith('.jsonl'), 4)
      const stats: LogFileStat[] = []
      for (const file of files) {
        const stat = await statFile(file)
        if (!stat) continue
        stats.push({
          path: file,
          sessionId: path.basename(file, '.jsonl'),
          project: path.basename(path.dirname(file)),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      }
      return stats
    },
    async parseFile(file: LogFileStat): Promise<LogRecord[]> {
      const lines = await readJsonLines(file.path)
      const byMessage = new Map<string, LogRecord>()
      let turnStart: number | undefined
      let ordinal = 0

      for (const raw of lines) {
        const entry = raw as Record<string, any>
        if (!entry || typeof entry !== 'object') continue
        const ts = timestampMs(entry.timestamp)
        if (entry.type === 'user' || entry.message?.role === 'user') {
          if (ts) turnStart = ts
          continue
        }
        if (entry.type !== 'assistant' || !entry.message?.usage) continue
        const usage = entry.message.usage as Record<string, unknown>
        const input = numberValue(usage.input_tokens)
        const output = numberValue(usage.output_tokens)
        const cacheRead = numberValue(usage.cache_read_input_tokens)
        const creation = (usage.cache_creation ?? {}) as Record<string, unknown>
        const cacheWrite =
          numberValue(usage.cache_creation_input_tokens) ||
          numberValue(creation.ephemeral_5m_input_tokens) + numberValue(creation.ephemeral_1h_input_tokens)
        if (input + output + cacheRead + cacheWrite === 0) continue
        const model = typeof entry.message.model === 'string' ? entry.message.model : 'unknown'
        const messageId = typeof entry.message.id === 'string' ? entry.message.id : undefined
        const recordTs = ts ?? Date.now()
        const duration =
          turnStart && recordTs > turnStart && recordTs - turnStart < 2 * 3_600_000 ? recordTs - turnStart : undefined
        ordinal++
        const record: LogRecord = {
          externalId: `claude-code:${messageId ?? hashId(file.path, recordTs, ordinal)}`,
          ts: recordTs,
          model,
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          reasoningTokens: 0,
          durationMs: duration,
          tokensPerSecond: duration && output > 0 ? output / (duration / 1000) : undefined,
          meta: {
            ...(duration ? { durationSource: 'message-gap' } : {}),
            ...(entry.isSidechain ? { sidechain: 1 } : {}),
          },
        }
        const key = messageId ?? record.externalId
        const previous = byMessage.get(key)
        // 同一 message.id 可能被多次写入；保留 token 更完整的一条，时间用最早一条。
        if (!previous || previous.outputTokens < output) {
          byMessage.set(key, previous ? { ...record, ts: previous.ts } : record)
        }
      }
      return [...byMessage.values()]
    },
  }
}
