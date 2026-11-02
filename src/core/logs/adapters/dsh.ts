import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LogFileStat, LogRecord, LogSourceAdapter } from '../types'
import { displayPath, exists, listFiles, statFile } from '../util'

function resolveRoot(override?: string): string {
  if (override) return override
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

/** zstd 帧魔数（小端 0xFD2FB528）。会话文件是多个 zstd 帧拼接，逐帧解开。 */
const ZSTD_MAGIC = 0xfd2fb528

function frameOffsets(buffer: Buffer): number[] {
  const offsets: number[] = []
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (buffer.readUInt32LE(i) === ZSTD_MAGIC) offsets.push(i)
  }
  return offsets
}

interface DshRow {
  type?: string
  seq?: number
  time?: number
  data?: Record<string, any>
}

/**
 * DeepSeek Harness（dsh，github.com/deepseek-ai/deepseek-harness）的会话日志：
 * ~/.dsh/sessions/<项目>/session-<id>/session.jsonl.zstd —— 多个 zstd 帧拼成的 JSONL。
 * 每行 assistant/message 带这次调用的 usage，model/selection 行给出当前用的模型。
 * 只读 usage 与模型名，不读对话内容。
 */
export function createDshAdapter(homeOverride?: string): LogSourceAdapter {
  const root = resolveRoot(homeOverride)
  const sessionsDir = path.join(root, 'sessions')

  return {
    id: 'dsh',
    name: 'DeepSeek Harness',
    description: '读取 DeepSeek Harness 的 zstd 会话日志，取每次调用的 token 用量、模型，以及由 step/start→首包→message 时间戳算出的首字延迟与输出速度。',
    capabilities: { tokens: true, cache: true, speed: true, ttft: true },
    async detect() {
      const available = await exists(sessionsDir)
      const zlib = await import('node:zlib')
      const zstdReady = typeof (zlib as any).zstdDecompressSync === 'function'
      return {
        available,
        paths: [displayPath(root)],
        note: !available
          ? '未找到 ~/.dsh/sessions；安装并跑过 DeepSeek Harness 后会自动出现。'
          : zstdReady
            ? undefined
            : '需要 Node 22.15+ 的 zstd 支持（浏览器版可用，uTools 插件内置 Node 20 读不了）。',
      }
    },
    async listFiles(): Promise<LogFileStat[]> {
      const files = await listFiles(sessionsDir, (name) => name.endsWith('.jsonl.zstd'), 3)
      const stats: LogFileStat[] = []
      for (const file of files) {
        const stat = await statFile(file)
        if (!stat) continue
        stats.push({
          path: file,
          sessionId: path.basename(path.dirname(file)).replace(/^session-/, ''),
          agentId: path.basename(file),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      }
      return stats
    },
    async parseFile(file: LogFileStat): Promise<LogRecord[]> {
      const zlib = await import('node:zlib')
      const decompress = (zlib as any).zstdDecompressSync
      if (typeof decompress !== 'function') {
        throw new Error('DeepSeek Harness 日志需要 Node 22.15+ 的 zstd 解压（浏览器版可用，uTools 插件内置 Node 20 读不了）')
      }
      const raw = await fs.readFile(file.path)
      const records: LogRecord[] = []
      /** turn:step → 该步的 step/start 与首个 assistant/chunk 时间，用来算首字与速度。 */
      const steps = new Map<string, { start?: number; firstChunk?: number }>()
      let model = 'deepseek-harness'
      let provider: string | undefined
      for (const offset of frameOffsets(raw)) {
        let text: string
        try {
          text = decompress(raw.subarray(offset)).toString('utf8')
        } catch {
          continue
        }
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          let row: DshRow
          try {
            row = JSON.parse(line) as DshRow
          } catch {
            continue
          }
          const data = row.data ?? {}
          if (row.type === 'model/selection' && typeof data.model === 'string') {
            model = data.model
            provider = typeof data.provider === 'string' ? data.provider : undefined
            continue
          }
          const turn = data.turn ?? 0
          const step = data.step ?? 0
          const stepKey = `${turn}:${step}`
          if (row.type === 'step/start' && typeof row.time === 'number') {
            steps.set(stepKey, { start: row.time })
            continue
          }
          if (row.type === 'assistant/chunk' && typeof row.time === 'number') {
            const current = steps.get(stepKey)
            if (current && current.firstChunk === undefined) current.firstChunk = row.time
            continue
          }
          if (row.type !== 'assistant/message') continue
          const usage = data.usage
          if (!usage) continue
          const input = Number(usage.inputTokens) || 0
          const output = Number(usage.outputTokens) || 0
          const cacheRead = Number(usage.cacheReadTokens) || 0
          const cacheWrite = Number(usage.cacheWriteTokens) || 0
          const reasoning = Number(usage.reasoningTokens) || 0
          if (input + output + cacheRead + cacheWrite === 0) continue
          const ts = typeof row.time === 'number' ? row.time : file.mtimeMs
          // 工具调用发生在 assistant/message 之后，所以耗时按 step/start→message 算，不能用 step/end。
          const timing = steps.get(stepKey)
          steps.delete(stepKey)
          const ttftMs =
            timing?.start !== undefined && timing.firstChunk !== undefined && timing.firstChunk >= timing.start
              ? timing.firstChunk - timing.start
              : undefined
          const durationMs =
            timing?.start !== undefined && typeof row.time === 'number' && row.time >= timing.start
              ? row.time - timing.start
              : undefined
          const streamMs =
            timing?.firstChunk !== undefined && typeof row.time === 'number' && row.time > timing.firstChunk
              ? row.time - timing.firstChunk
              : undefined
          records.push({
            externalId: `dsh:${file.sessionId}:${turn}:${step}:${ts}`,
            ts,
            model,
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            reasoningTokens: reasoning,
            ttftMs,
            durationMs,
            tokensPerSecond: streamMs !== undefined && streamMs > 0 && output > 0 ? (output * 1000) / streamMs : undefined,
            meta: { client: 'dsh', ...(provider ? { provider } : {}) },
          })
        }
      }
      return records
    },
  }
}
