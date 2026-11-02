import os from 'node:os'
import path from 'node:path'
import type { LogFileStat, LogRecord, LogSourceAdapter } from '../types'
import {
  displayPath,
  exists,
  hashId,
  listFiles,
  numberValue,
  readJsonFile,
  statFile,
  timestampMs,
  windowsAppData,
} from '../util'

const EXTENSIONS = ['saoudrizwan.claude-dev', 'rooveterinaryinc.roo-cline', 'kilocode.kilo-code']
const APP_DIRS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf']

function roots(override?: string): string[] {
  if (override) return [override]
  const appData = windowsAppData()
  const list = APP_DIRS.map((dir) =>
    path.join(appData, dir, 'User', 'globalStorage'),
  ).flatMap((base) => EXTENSIONS.map((ext) => path.join(base, ext, 'tasks')))
  list.push(path.join(os.homedir(), '.cline', 'data', 'tasks'))
  list.push(path.join(os.homedir(), '.cline', 'data'))
  return [...new Set(list)]
}

export function createClineAdapter(override?: string): LogSourceAdapter {
  const taskRoots = roots(override)

  return {
    id: 'cline',
    name: 'Cline / Roo / Kilo',
    description: '读取 VS Code 系扩展任务目录的 ui_messages.json；token/缓存可用，无耗时字段。',
    capabilities: { tokens: true, cache: true, speed: false, ttft: false },
    async detect() {
      const found: string[] = []
      for (const root of taskRoots) if (await exists(root)) found.push(root)
      return { available: found.length > 0, paths: found.map(displayPath) }
    },
    async listFiles(): Promise<LogFileStat[]> {
      const byTask = new Map<string, LogFileStat>()
      for (const root of taskRoots) {
        const files = await listFiles(root, (name) => name === 'ui_messages.json', 2)
        for (const file of files) {
          const stat = await statFile(file)
          if (!stat) continue
          const taskId = path.basename(path.dirname(file))
          const previous = byTask.get(taskId)
          if (!previous || previous.mtimeMs < stat.mtimeMs) {
            byTask.set(taskId, {
              path: file,
              sessionId: taskId,
              agentId: path.basename(root),
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            })
          }
        }
      }
      return [...byTask.values()]
    },
    async parseFile(file: LogFileStat): Promise<LogRecord[]> {
      const messages = await readJsonFile<Array<Record<string, any>>>(file.path)
      if (!Array.isArray(messages)) return []
      const records: LogRecord[] = []
      let index = 0
      for (const message of messages) {
        if (message?.type !== 'say' || message?.say !== 'api_req_started' || !message.text) continue
        let parsed: Record<string, any>
        try {
          parsed = JSON.parse(message.text)
        } catch {
          continue
        }
        const input = numberValue(parsed.tokensIn)
        const output = numberValue(parsed.tokensOut)
        const cacheRead = numberValue(parsed.cacheReads)
        const cacheWrite = numberValue(parsed.cacheWrites)
        if (input + output + cacheRead + cacheWrite === 0) continue
        index++
        records.push({
          externalId: `cline:${hashId(file.sessionId, index, message.ts)}`,
          ts: timestampMs(message.ts) ?? file.mtimeMs,
          model: String(parsed.modelId ?? parsed.model ?? 'cline-unknown'),
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          reasoningTokens: 0,
          meta: { client: 'cline' },
        })
      }
      return records
    },
  }
}
