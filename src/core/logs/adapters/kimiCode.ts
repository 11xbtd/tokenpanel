import os from 'node:os'
import path from 'node:path'
import type { LogFileStat, LogRecord, LogSourceAdapter } from '../types'
import { displayPath, exists, hashId, listFiles, numberValue, readJsonLines, statFile, timestampMs } from '../util'

function resolveHome(override?: string): string {
  return override ?? process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), '.kimi-code')
}

interface KimiCodeRequest {
  model?: string
  modelAlias?: string
  providerHint?: string
  turnStep?: string
  time?: number
}

/** 自定义 provider 的别名形如 `OpenCode Go/deepseek-v4.1-flash`，前缀是厂商线索。 */
function providerHintOf(alias?: string): string | undefined {
  if (!alias) return undefined
  const index = alias.indexOf('/')
  if (index <= 0) return undefined
  return alias.slice(0, index).trim() || undefined
}

export function createKimiCodeAdapter(homeOverride?: string): LogSourceAdapter {
  const root = resolveHome(homeOverride)
  const sessionsDir = path.join(root, 'sessions')

  return {
    id: 'kimi-code',
    name: 'Kimi Code CLI',
    description: '读取 Kimi Code CLI 会话日志，带 token、缓存、流式速度与首字耗时。',
    capabilities: { tokens: true, cache: true, speed: true, ttft: true },
    async detect() {
      return {
        available: await exists(sessionsDir),
        paths: [displayPath(sessionsDir)],
        note: '只读取 usage 与耗时字段，不保存对话内容。',
      }
    },
    async listFiles(): Promise<LogFileStat[]> {
      const files = await listFiles(sessionsDir, (name) => name === 'wire.jsonl', 6)
      const stats: LogFileStat[] = []
      for (const file of files) {
        const stat = await statFile(file)
        if (!stat) continue
        const sessionId = path.basename(path.dirname(path.dirname(path.dirname(file))))
        const agentId = path.basename(path.dirname(file))
        stats.push({ path: file, sessionId, agentId, size: stat.size, mtimeMs: stat.mtimeMs })
      }
      return stats
    },
    async parseFile(file: LogFileStat): Promise<LogRecord[]> {
      const lines = await readJsonLines(file.path)
      const stepEnds: LogRecord[] = []
      const fallback: LogRecord[] = []
      const aliases = new Map<string, string>()
      let lastRequest: KimiCodeRequest | undefined
      let usageOrdinal = 0

      for (const raw of lines) {
        const record = raw as Record<string, any>
        if (!record || typeof record !== 'object') continue
        if (record.type === 'llm.request') {
          const modelAlias = typeof record.modelAlias === 'string' ? record.modelAlias : undefined
          lastRequest = {
            model: typeof record.model === 'string' ? record.model : undefined,
            modelAlias,
            providerHint: providerHintOf(modelAlias),
            turnStep: typeof record.turnStep === 'string' ? record.turnStep : undefined,
            time: timestampMs(record.time),
          }
          if (lastRequest.model && lastRequest.modelAlias) aliases.set(lastRequest.modelAlias, lastRequest.model)
          continue
        }

        if (record.type === 'context.append_loop_event') {
          const event = record.event as Record<string, any> | undefined
          if (!event || event.type !== 'step.end' || !event.usage) continue
          const usage = event.usage as Record<string, unknown>
          const output = numberValue(usage.output)
          const input = numberValue(usage.inputOther)
          const cacheRead = numberValue(usage.inputCacheRead)
          const cacheWrite = numberValue(usage.inputCacheCreation)
          if (input + output + cacheRead + cacheWrite === 0) continue
          const ts = timestampMs(record.time) ?? lastRequest?.time ?? Date.now()
          const durationMs = numberValue(event.llmStreamDurationMs, 0) || undefined
          const ttftMs = numberValue(event.llmFirstTokenLatencyMs, 0) || undefined
          const model = lastRequest?.model ?? 'unknown'
          const providerHint = lastRequest?.providerHint
          const externalId = `kimi-code:${hashId(file.path, file.sessionId, file.agentId, event.turnId, event.step, ts)}`
          stepEnds.push({
            externalId,
            ts,
            model,
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            reasoningTokens: 0,
            ttftMs,
            durationMs,
            tokensPerSecond: durationMs && output > 0 ? output / (durationMs / 1000) : undefined,
            meta: {
              agent: file.agentId ?? 'main',
              ...(providerHint ? { provider: providerHint } : {}),
              ...(event.finishReason ? { finishReason: String(event.finishReason) } : {}),
              ...(numberValue(event.llmServerFirstTokenMs, 0) ? { serverTtftMs: numberValue(event.llmServerFirstTokenMs) } : {}),
            },
          })
          continue
        }

        if (record.type === 'usage.record' && record.usage) {
          const usage = record.usage as Record<string, unknown>
          const output = numberValue(usage.output)
          const input = numberValue(usage.inputOther)
          const cacheRead = numberValue(usage.inputCacheRead)
          const cacheWrite = numberValue(usage.inputCacheCreation)
          if (input + output + cacheRead + cacheWrite === 0) continue
          const alias = typeof record.model === 'string' ? record.model : undefined
          const providerHint = providerHintOf(alias) ?? lastRequest?.providerHint
          const ts = timestampMs(record.time) ?? lastRequest?.time ?? Date.now()
          usageOrdinal++
          fallback.push({
            externalId: `kimi-code:${hashId(file.path, file.sessionId, file.agentId, ts, usageOrdinal)}`,
            ts,
            model: (alias && aliases.get(alias)) || lastRequest?.model || alias || 'unknown',
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            reasoningTokens: 0,
            meta: { agent: file.agentId ?? 'main', ...(providerHint ? { provider: providerHint } : {}) },
          })
        }
      }

      // step.end 同时含 usage 和时序；有它就不再重复读 usage.record。
      return stepEnds.length > 0 ? stepEnds : fallback
    },
  }
}
