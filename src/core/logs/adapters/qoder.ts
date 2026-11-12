import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LogFileStat, LogRecord, LogSourceAdapter } from '../types'
import { displayPath, exists, statSqliteFile } from '../util'

function resolveRoots(override?: string): string[] {
  if (override) return [override]
  if (process.env.QODER_HOME) return [process.env.QODER_HOME]
  return [path.join(os.homedir(), '.qoder'), path.join(os.homedir(), '.qoder-cn')]
}

interface QoderMessageRow {
  id: string
  session_id: string | null
  request_id: string | null
  token_info: string | null
  model_info: string | null
  gmt_create: number | string | null
}

function parseJson(value: string | null): Record<string, any> | undefined {
  if (!value) return undefined
  try {
    return JSON.parse(value) as Record<string, any>
  } catch {
    return undefined
  }
}

/**
 * Qoder 的会话 JSONL 把 usage token 清零了（只剩 credits），真实 token 在
 * shared_client/cache/db/local.db 的 chat_message.token_info 里，覆盖本地缓存的最近消息。
 * 自定义模型的 model_key 不在会话日志里，这里从 model_info 读。
 */
export function createQoderAdapter(homeOverride?: string): LogSourceAdapter {
  const dbPaths = resolveRoots(homeOverride).map((root) => path.join(root, 'shared_client', 'cache', 'db', 'local.db'))

  return {
    id: 'qoder',
    name: 'Qoder / QoderCN',
    description: '读取 Qoder/QoderCN 本地缓存库的 chat_message.token_info；有真实 token/缓存，覆盖最近缓存的消息。',
    capabilities: { tokens: true, cache: true, speed: false, ttft: false },
    // 缓存库混着记忆嵌入等数据，会远超文本日志的 80MB；SQLite 查询不整文件读入内存。
    maxFileBytes: 512 * 1024 * 1024,
    async detect() {
      const found: string[] = []
      for (const dbPath of dbPaths) {
        if (await exists(dbPath)) found.push(displayPath(dbPath))
      }
      return {
        available: found.length > 0,
        paths: found.length > 0 ? found : dbPaths.map(displayPath),
        note: 'Qoder 会话 JSONL 里 token 被清零，只有本地缓存的 chat_message 带真实 token；需要 Node 22+（浏览器版可用）。',
      }
    },
    async listFiles(): Promise<LogFileStat[]> {
      const files: LogFileStat[] = []
      for (const dbPath of dbPaths) {
        const stat = await statSqliteFile(dbPath)
        if (stat) files.push({ path: dbPath, sessionId: 'qoder', size: stat.size, mtimeMs: stat.mtimeMs })
      }
      return files
    },
    async parseFile(file: LogFileStat): Promise<LogRecord[]> {
      let DatabaseSync: typeof import('node:sqlite').DatabaseSync
      try {
        ;({ DatabaseSync } = await import('node:sqlite'))
      } catch {
        throw new Error('Qoder token 库需要 Node 22+（浏览器版可用，uTools 插件内置 Node 20 读不了）')
      }

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenpanel-qoder-'))
      const snapshot = path.join(tempDir, 'local.db')
      try {
        await fs.copyFile(file.path, snapshot)
        for (const suffix of ['-wal', '-shm']) {
          const sidecar = `${file.path}${suffix}`
          const sidecarExists = await fs
            .access(sidecar)
            .then(() => true)
            .catch(() => false)
          if (sidecarExists) await fs.copyFile(sidecar, `${snapshot}${suffix}`)
        }

        const db = new DatabaseSync(snapshot)
        try {
          const rows = db
            .prepare(
              `SELECT id, session_id, request_id, token_info, model_info, gmt_create
               FROM chat_message
               WHERE role = 'assistant' AND token_info IS NOT NULL AND token_info <> ''
               ORDER BY gmt_create`,
            )
            .all() as unknown as QoderMessageRow[]

          const records: LogRecord[] = []
          for (const row of rows) {
            const token = parseJson(row.token_info)
            if (!token) continue
            const prompt = Number(token.prompt_tokens) || 0
            const cached = Number(token.cached_tokens) || 0
            const output = Number(token.completion_tokens) || 0
            const input = Math.max(0, prompt - cached)
            if (input + cached + output === 0) continue
            const modelInfo = parseJson(row.model_info)
            const model = String(modelInfo?.model_key ?? modelInfo?.model ?? 'qoder-unknown')
            const ts = Number(row.gmt_create) || Date.now()
            records.push({
              externalId: `qoder:${row.id}`,
              ts,
              model,
              inputTokens: input,
              outputTokens: output,
              cacheReadTokens: cached,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              meta: {
                client: 'qoder',
                ...(row.session_id ? { session: row.session_id } : {}),
                ...(Number(token.max_input_tokens) ? { maxInputTokens: Number(token.max_input_tokens) } : {}),
              },
            })
          }
          return records
        } finally {
          db.close()
        }
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true })
      }
    },
  }
}
