import os from 'node:os'
import path from 'node:path'
import type { LogFileStat, LogRecord, LogSourceAdapter } from '../types'
import { displayPath, exists, hashId, listFiles, numberValue, readJsonFile, readJsonLines, statFile, timestampMs } from '../util'

function resolveHome(override?: string): string {
  return override ?? process.env.GEMINI_HOME ?? path.join(os.homedir(), '.gemini')
}

interface GeminiSession {
  sessionId?: string
  startTime?: string
  messages?: Array<Record<string, any>>
}

export function createGeminiAdapter(homeOverride?: string): LogSourceAdapter {
  const root = resolveHome(homeOverride)
  const tmpDir = path.join(root, 'tmp')

  return {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    description: '读取 Gemini CLI chats；token/缓存可用，日志不含逐请求耗时和首字耗时。',
    capabilities: { tokens: true, cache: true, speed: false, ttft: false },
    async detect() {
      return { available: await exists(tmpDir), paths: [displayPath(tmpDir)] }
    },
    async listFiles(): Promise<LogFileStat[]> {
      const files = await listFiles(
        tmpDir,
        (name) => name.startsWith('session-') && (name.endsWith('.json') || name.endsWith('.jsonl')),
        4,
      )
      const stats: LogFileStat[] = []
      for (const file of files) {
        const stat = await statFile(file)
        if (!stat) continue
        stats.push({
          path: file,
          sessionId: path.basename(file).replace(/\.jsonl?$/, ''),
          project: path.basename(path.dirname(path.dirname(file))),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      }
      return stats
    },
    async parseFile(file: LogFileStat): Promise<LogRecord[]> {
      const sessions: GeminiSession[] = []
      const parsed = await readJsonFile<GeminiSession>(file.path)
      if (parsed?.messages) {
        sessions.push(parsed)
      } else {
        const messages: Array<Record<string, any>> = []
        let sessionId = file.sessionId
        let startTime: string | undefined
        for (const raw of await readJsonLines(file.path)) {
          const entry = raw as Record<string, any>
          if (entry?.messages && entry?.sessionId) {
            sessions.push(entry as GeminiSession)
          } else if (entry?.type) {
            messages.push(entry)
            sessionId = entry.sessionId ?? sessionId
            startTime = startTime ?? entry.startTime
          }
        }
        if (messages.length) sessions.push({ sessionId, startTime, messages })
      }

      const records: LogRecord[] = []
      for (const session of sessions) {
        const sessionId = session.sessionId ?? file.sessionId
        for (const [index, message] of (session.messages ?? []).entries()) {
          if (message.type !== 'gemini' || !message.tokens || !message.model) continue
          const inputTotal = numberValue(message.tokens.input)
          const cached = numberValue(message.tokens.cached)
          const output = numberValue(message.tokens.output)
          const thoughts = numberValue(message.tokens.thoughts)
          const input = Math.max(0, inputTotal - cached)
          if (input + cached + output + thoughts === 0) continue
          const ts = timestampMs(message.timestamp) ?? timestampMs(session.startTime) ?? Date.now()
          records.push({
            externalId: `gemini:${hashId(sessionId, message.id, index)}`,
            ts,
            model: String(message.model),
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
            reasoningTokens: thoughts,
            meta: { client: 'gemini-cli' },
          })
        }
      }
      return records
    },
  }
}
