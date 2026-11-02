import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decompress as decompressFzstd } from 'fzstd'
import type { LogFileStat, LogRecord, LogSourceAdapter } from '../types'
import { displayPath, exists, listFiles, statFile } from '../util'

export interface DshAdapterOptions {
  /** 测试或排查时强制走纯 JS 解码，模拟 uTools 的 Node 20。 */
  forceFallback?: boolean
}

function resolveRoot(override?: string): string {
  if (override) return override
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

/** zstd 帧魔数（小端 0xFD2FB528）。会话文件是多个 zstd 帧拼接，逐帧解开。 */
const ZSTD_MAGIC = 0xfd2fb528
/** 增量扫描时向前回溯的字节数；DSH 每个事件一帧，1MB 足够覆盖上次末尾的半个帧。 */
const RESUME_LOOKBACK = 1024 * 1024

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
export function createDshAdapter(homeOverride?: string, options: DshAdapterOptions = {}): LogSourceAdapter {
  const root = resolveRoot(homeOverride)
  const sessionsDir = path.join(root, 'sessions')
  /** 同一进程内按文件记住已解析到的大小，追加日志只从末尾附近续解，避免每次重扫整个大文件。 */
  const parsedSizes = new Map<string, number>()

  return {
    id: 'dsh',
    name: 'DeepSeek Harness',
    description: '读取 DeepSeek Harness 的 zstd 会话日志，取每次调用的 token 用量、模型，以及由 step/start→首包→message 时间戳算出的首字延迟与输出速度。',
    capabilities: { tokens: true, cache: true, speed: true, ttft: true },
    async detect() {
      const available = await exists(sessionsDir)
      return {
        available,
        paths: [displayPath(root)],
        note: available ? undefined : '未找到 ~/.dsh/sessions；安装并跑过 DeepSeek Harness 后会自动出现。',
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
      const nativeDecompress = options.forceFallback ? undefined : (zlib as any).zstdDecompressSync
      const raw = await fs.readFile(file.path)
      const records: LogRecord[] = []
      /** turn:step → 该步的 step/start 与首个 assistant/chunk 时间，用来算首字与速度。 */
      const steps = new Map<string, { start?: number; firstChunk?: number }>()
      let model = 'deepseek-harness'
      let provider: string | undefined
      const decode = (from: number): string[] => {
        const chunk = from > 0 ? raw.subarray(from) : raw
        const decoded: string[] = []
        if (typeof nativeDecompress === 'function') {
          for (const offset of frameOffsets(chunk)) {
            try {
              decoded.push(nativeDecompress(chunk.subarray(offset)).toString('utf8'))
            } catch {
              continue
            }
          }
        } else {
          try {
            decoded.push(Buffer.from(decompressFzstd(chunk)).toString('utf8'))
          } catch {
            throw new Error('DeepSeek Harness 日志解压失败，文件可能不完整')
          }
        }
        return decoded
      }
      const previousSize = parsedSizes.get(file.path)
      let resumeFrom = 0
      if (previousSize && raw.length > previousSize) {
        const from = Math.max(0, previousSize - RESUME_LOOKBACK)
        for (let i = previousSize - 4; i >= from; i--) {
          if (raw.readUInt32LE(i) === ZSTD_MAGIC) {
            resumeFrom = i
            break
          }
        }
      }
      let texts = decode(resumeFrom)
      // 回溯点落在压缩数据里的伪魔数时，退回全量解析，宁可慢也不漏。
      if (texts.length === 0 && resumeFrom > 0) texts = decode(0)
      for (const text of texts) {
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
      parsedSizes.set(file.path, raw.length)
      return records
    },
  }
}
