import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LogFileStat, LogRecord, LogSourceAdapter } from '../types'
import { displayPath, exists, statSqliteFile } from '../util'

function resolveRoot(override?: string): string {
  return override ?? process.env.ZCODE_HOME ?? path.join(os.homedir(), '.zcode')
}

interface ZcodeUsageRow {
  id: number | string
  session_id: string | null
  turn_id: string | null
  model_id: string | null
  provider_id: string | null
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
  started_at: number | null
  completed_at: number | null
  first_token_at: number | null
  duration_ms: number | null
  time_to_first_token_ms: number | null
}

/**
 * ZCode CLI 把用量写在 ~/.zcode/cli/db/db.sqlite 的 model_usage 表，
 * 含 input/output/reasoning/cache 与 first_token_at、time_to_first_token_ms。
 * 运行时是 WAL 模式且 CLI 可能正在写，所以先复制一份再只读查询。
 */
export function createZcodeAdapter(homeOverride?: string): LogSourceAdapter {
  const root = resolveRoot(homeOverride)
  const dbPath = path.join(root, 'cli', 'db', 'db.sqlite')

  return {
    id: 'zcode',
    name: 'ZCode',
    description: '读取 ZCode CLI 的 SQLite 用量表；token、缓存、耗时与真实首字耗时都有。',
    capabilities: { tokens: true, cache: true, speed: true, ttft: true },
    async detect() {
      return {
        available: await exists(dbPath),
        paths: [displayPath(dbPath)],
        note: '需要 Node 22+ 的 node:sqlite；uTools 插件内置 Node 20 时读不了，请用浏览器版。',
      }
    },
    async listFiles(): Promise<LogFileStat[]> {
      const stat = await statSqliteFile(dbPath)
      if (!stat) return []
      return [{ path: dbPath, sessionId: 'zcode', size: stat.size, mtimeMs: stat.mtimeMs }]
    },
    async parseFile(file: LogFileStat): Promise<LogRecord[]> {
      let DatabaseSync: typeof import('node:sqlite').DatabaseSync
      try {
        ;({ DatabaseSync } = await import('node:sqlite'))
      } catch {
        throw new Error('ZCode 需要 Node 22+（浏览器版可用，uTools 插件内置 Node 20 读不了）')
      }

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenpanel-zcode-'))
      const snapshot = path.join(tempDir, 'db.sqlite')
      try {
        await fs.copyFile(file.path, snapshot)
        for (const suffix of ['-wal', '-shm']) {
          const sidecar = `${file.path}${suffix}`
          const exists = await fs
            .access(sidecar)
            .then(() => true)
            .catch(() => false)
          if (exists) await fs.copyFile(sidecar, `${snapshot}${suffix}`)
        }

        const db = new DatabaseSync(snapshot)
        try {
          const rows = db
            .prepare(
              `SELECT id, session_id, turn_id, model_id, provider_id, input_tokens, output_tokens,
                      reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens,
                      started_at, completed_at, first_token_at, duration_ms, time_to_first_token_ms
               FROM model_usage
               WHERE input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens > 0
               ORDER BY started_at`,
            )
            .all() as unknown as ZcodeUsageRow[]

          return rows.map((row) => {
            const started = Number(row.started_at) || 0
            const completed = Number(row.completed_at) || 0
            const firstToken = Number(row.first_token_at) || 0
            const duration =
              Number(row.duration_ms) || (completed && started ? completed - started : undefined)
            const ttft =
              Number(row.time_to_first_token_ms) || (firstToken && started ? firstToken - started : undefined)
            const output = Number(row.output_tokens) || 0
            return {
              externalId: `zcode:${row.id}`,
              ts: started || Date.now(),
              model: String(row.model_id ?? 'zcode-unknown'),
              inputTokens: Number(row.input_tokens) || 0,
              outputTokens: output,
              cacheReadTokens: Number(row.cache_read_input_tokens) || 0,
              cacheWriteTokens: Number(row.cache_creation_input_tokens) || 0,
              reasoningTokens: Number(row.reasoning_tokens) || 0,
              durationMs: duration || undefined,
              ttftMs: ttft || undefined,
              tokensPerSecond: duration && output > 0 ? output / (duration / 1000) : undefined,
              meta: {
                client: 'zcode',
                ...(row.session_id ? { session: row.session_id } : {}),
                ...(row.provider_id ? { provider: row.provider_id } : {}),
              },
            } satisfies LogRecord
          })
        } finally {
          db.close()
        }
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true })
      }
    },
  }
}
