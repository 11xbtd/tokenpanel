import os from 'node:os'
import path from 'node:path'
import type { LogFileStat, LogRecord, LogSourceAdapter } from '../types'
import { displayPath, exists, hashId, listFiles, numberValue, readJsonLines, statFile, timestampMs } from '../util'

function resolveRoot(override?: string): string {
  return override ?? process.env.QWEN_DATA_DIR ?? path.join(os.homedir(), '.qwen', 'projects')
}

export function createQwenAdapter(homeOverride?: string): LogSourceAdapter {
  const root = resolveRoot(homeOverride)

  return {
    id: 'qwen-code',
    name: 'Qwen Code',
    description: '读取 Qwen Code 会话 JSONL；token/缓存可用，日志不含耗时。',
    capabilities: { tokens: true, cache: true, speed: false, ttft: false },
    async detect() {
      return { available: await exists(root), paths: [displayPath(root)] }
    },
    async listFiles(): Promise<LogFileStat[]> {
      const files = await listFiles(root, (name) => name.endsWith('.jsonl'), 4)
      const stats: LogFileStat[] = []
      for (const file of files) {
        const stat = await statFile(file)
        if (!stat) continue
        stats.push({
          path: file,
          sessionId: path.basename(file, '.jsonl'),
          project: path.basename(path.dirname(path.dirname(file))),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      }
      return stats
    },
    async parseFile(file: LogFileStat): Promise<LogRecord[]> {
      const records: LogRecord[] = []
      let index = 0
      for (const raw of await readJsonLines(file.path)) {
        const entry = raw as Record<string, any>
        if (entry?.type !== 'assistant' || !entry.usageMetadata) continue
        const usage = entry.usageMetadata
        const prompt = numberValue(usage.promptTokenCount)
        const cached = numberValue(usage.cachedContentTokenCount)
        const input = Math.max(0, prompt - cached)
        const output = numberValue(usage.candidatesTokenCount)
        const reasoning = numberValue(usage.thoughtsTokenCount)
        if (input + cached + output + reasoning === 0) continue
        index++
        records.push({
          externalId: `qwen:${hashId(entry.sessionId, entry.uuid, index)}`,
          ts: timestampMs(entry.timestamp) ?? Date.now(),
          model: String(entry.model ?? 'qwen-auto'),
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
          reasoningTokens: reasoning,
          meta: { client: 'qwen-code' },
        })
      }
      return records
    },
  }
}
