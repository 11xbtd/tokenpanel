import os from 'node:os'
import path from 'node:path'
import type { LogFileStat, LogRecord, LogSourceAdapter } from '../types'
import { displayPath, exists, hashId, listFiles, numberValue, readJsonLines, statFile, timestampMs } from '../util'

function resolveHome(override?: string): string {
  return override ?? process.env.KIMI_SHARE_DIR ?? path.join(os.homedir(), '.kimi')
}

function usageOf(payload: Record<string, any>): Record<string, unknown> | undefined {
  return (payload.token_usage && typeof payload.token_usage === 'object'
    ? payload.token_usage
    : payload.usage && typeof payload.usage === 'object'
      ? payload.usage
      : undefined) as Record<string, unknown> | undefined
}

export function createKimiCliAdapter(homeOverride?: string): LogSourceAdapter {
  const root = resolveHome(homeOverride)
  const sessionsDir = path.join(root, 'sessions')

  return {
    id: 'kimi-cli',
    name: 'Kimi CLI（旧版）',
    description: '读取 ~/.kimi 的会话日志；token/缓存可用，日志不含逐请求耗时。',
    capabilities: { tokens: true, cache: true, speed: false, ttft: false },
    async detect() {
      return {
        available: await exists(sessionsDir),
        paths: [displayPath(sessionsDir)],
        note: '旧版 Kimi CLI 日志字段，未在本机验证。',
      }
    },
    async listFiles(): Promise<LogFileStat[]> {
      const files = await listFiles(sessionsDir, (name) => name === 'wire.jsonl', 6)
      const stats: LogFileStat[] = []
      for (const file of files) {
        const stat = await statFile(file)
        if (!stat) continue
        stats.push({
          path: file,
          sessionId: path.basename(path.dirname(file)),
          agentId: path.basename(path.dirname(path.dirname(file))),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      }
      return stats
    },
    async parseFile(file: LogFileStat): Promise<LogRecord[]> {
      const lines = await readJsonLines(file.path)
      const records: LogRecord[] = []
      let index = 0
      for (const raw of lines) {
        const record = raw as Record<string, any>
        if (!record || record.type !== 'StatusUpdate' || !record.payload) continue
        const usage = usageOf(record.payload)
        if (!usage) continue
        const cacheRead = numberValue(usage.input_cache_read ?? usage.cache_read_input_tokens ?? usage.cached_input_tokens)
        const cacheWrite = numberValue(usage.input_cache_creation ?? usage.cache_creation_input_tokens)
        let input = numberValue(usage.input_other ?? usage.input_tokens)
        if (input === 0) input = Math.max(0, numberValue(usage.input) - cacheRead - cacheWrite)
        const output = numberValue(usage.output ?? usage.output_tokens)
        if (input + output + cacheRead + cacheWrite === 0) continue
        const ts = timestampMs(record.timestamp) ?? Date.now()
        index++
        records.push({
          externalId: `kimi-cli:${hashId(file.path, record.payload.message_id, ts, index)}`,
          ts,
          model: String(record.payload.model ?? record.payload.model_name ?? 'kimi-unknown'),
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          reasoningTokens: 0,
          meta: { agent: path.basename(file.sessionId) },
        })
      }
      return records
    },
  }
}
