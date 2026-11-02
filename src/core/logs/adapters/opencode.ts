import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LogFileStat, LogRecord, LogSourceAdapter } from '../types'
import { displayPath, exists, hashId, listFiles, numberValue, readJsonFile, statFile, timestampMs } from '../util'

function resolveRoot(override?: string): string {
  if (override) return override
  if (process.env.OPENCODE_DATA_DIR) return process.env.OPENCODE_DATA_DIR
  const base = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'opencode')
}

interface OpenCodeMessage {
  role?: string
  time?: { created?: number; completed?: number }
  modelID?: string
  providerID?: string
  model?: { id?: string; providerID?: string }
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  usage?: Record<string, number | undefined>
}

interface Extracted {
  model: string
  providerID?: string
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  created?: number
  completed?: number
  duration?: number
}

function extract(data: OpenCodeMessage | undefined, fallbackModel?: string): Extracted | undefined {
  if (!data || (data.role !== 'assistant' && data.role !== 'model')) return undefined
  const tokens = data.tokens ?? {}
  const usage = data.usage ?? {}
  const input = numberValue(tokens.input ?? usage.input_tokens)
  const output = numberValue(tokens.output ?? usage.output_tokens)
  const reasoning = numberValue(tokens.reasoning)
  const cacheRead = numberValue(tokens.cache?.read ?? usage.cache_read_input_tokens)
  const cacheWrite = numberValue(tokens.cache?.write ?? usage.cache_creation_input_tokens)
  if (input + output + reasoning + cacheRead + cacheWrite === 0) return undefined
  const created = timestampMs(data.time?.created)
  const completed = timestampMs(data.time?.completed)
  const model = String(
    data.modelID ?? data.model?.id ?? fallbackModel ?? data.providerID ?? data.model?.providerID ?? 'opencode-unknown',
  )
  return {
    model,
    providerID: data.providerID ?? data.model?.providerID,
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    created,
    completed,
    duration: completed && created && completed > created ? completed - created : undefined,
  }
}

function toRecord(extracted: Extracted, externalId: string, fallbackTs: number): LogRecord {
  return {
    externalId,
    ts: extracted.created ?? fallbackTs,
    model: extracted.model,
    inputTokens: extracted.input,
    outputTokens: extracted.output,
    cacheReadTokens: extracted.cacheRead,
    cacheWriteTokens: extracted.cacheWrite,
    reasoningTokens: extracted.reasoning,
    durationMs: extracted.duration,
    tokensPerSecond:
      extracted.duration && extracted.output > 0 ? extracted.output / (extracted.duration / 1000) : undefined,
    meta: { client: 'opencode', ...(extracted.providerID ? { provider: extracted.providerID } : {}) },
  }
}

/**
 * OpenCode 的本地存储有两代：
 * - 旧版：~/.local/share/opencode/storage/message/<sessionId>/<messageId>.json
 * - 新版（v1.2.0 起迁移）：~/.local/share/opencode/opencode.db，session/message/part 三张表，
 *   message 的 data 列里放 JSON，字段与旧版一致（role / time / tokens / model）。
 * 两种都读；认不出的字段不产出记录，避免算错。
 */
export function createOpenCodeAdapter(homeOverride?: string): LogSourceAdapter {
  const root = resolveRoot(homeOverride)
  const storageDir = path.join(root, 'storage')
  const dbPath = path.join(root, 'opencode.db')

  return {
    id: 'opencode',
    name: 'OpenCode',
    description: '读取 OpenCode 本地用量（新版 SQLite / 旧版 JSON）；速度按 created→completed 估算。',
    capabilities: { tokens: true, cache: true, speed: true, ttft: false },
    async detect() {
      const jsonAvailable = await exists(path.join(storageDir, 'message'))
      const dbAvailable = await exists(dbPath)
      return {
        available: jsonAvailable || dbAvailable,
        paths: [displayPath(root)],
        note: dbAvailable && !jsonAvailable ? 'SQLite 版：读取 opencode.db 的 message 表。' : undefined,
      }
    },
    async listFiles(): Promise<LogFileStat[]> {
      const files = await listFiles(path.join(storageDir, 'message'), (name) => name.endsWith('.json'), 2)
      const stats: LogFileStat[] = []
      for (const file of files) {
        const stat = await statFile(file)
        if (!stat) continue
        stats.push({
          path: file,
          sessionId: path.basename(path.dirname(file)),
          agentId: path.basename(file, '.json'),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      }
      const dbStat = await statFile(dbPath)
      if (dbStat) {
        stats.push({
          path: dbPath,
          sessionId: 'opencode-db',
          agentId: 'opencode.db',
          size: dbStat.size,
          mtimeMs: dbStat.mtimeMs,
        })
      }
      return stats
    },
    async parseFile(file: LogFileStat): Promise<LogRecord[]> {
      if (file.path.endsWith('.db')) return parseSqlite(file.path)
      const data = (await readJsonFile<OpenCodeMessage>(file.path)) ?? undefined
      const extracted = extract(data)
      if (!extracted) return []
      const created = extracted.created ?? file.mtimeMs
      return [toRecord(extracted, `opencode:${hashId(file.sessionId, file.agentId, created)}`, created)]
    },
  }
}

async function parseSqlite(dbPath: string): Promise<LogRecord[]> {
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    throw new Error('OpenCode SQLite 版需要 Node 22+（浏览器版可用，uTools 插件内置 Node 20 读不了）')
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenpanel-opencode-'))
  const snapshot = path.join(tempDir, 'opencode.db')
  try {
    await fs.copyFile(dbPath, snapshot)
    const db = new DatabaseSync(snapshot, { readOnly: true })
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row: any) => String(row.name))
      if (!tables.includes('message')) return []
      const sessionModels = new Map<string, string>()
      if (tables.includes('session')) {
        try {
          for (const row of db.prepare('SELECT id, model FROM session').all() as any[]) {
            const model = typeof row.model === 'string' ? modelIdOf(row.model) : row.model?.id
            if (model) sessionModels.set(String(row.id), String(model))
          }
        } catch {
          // session 表结构变动时忽略，message 自带模型名就够了
        }
      }
      const rows = db.prepare('SELECT id, session_id, data FROM message').all() as any[]
      const records: LogRecord[] = []
      for (const row of rows) {
        let data: OpenCodeMessage
        try {
          data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data ?? {})
        } catch {
          continue
        }
        const extracted = extract(data, sessionModels.get(String(row.session_id)))
        if (!extracted) continue
        const created = extracted.created ?? Date.now()
        records.push(toRecord(extracted, `opencode:${hashId(String(row.id), created)}`, created))
      }
      return records
    } finally {
      db.close()
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

function modelIdOf(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed === 'string') return parsed
    if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') return parsed.id
  } catch {
    return value
  }
  return undefined
}
