import os from 'node:os'
import path from 'node:path'
import type { LogFileStat, LogRecord, LogSourceAdapter } from '../types'
import { displayPath, exists, hashId, listFiles, numberValue, readJsonLines, statFile, timestampMs } from '../util'

function resolveHome(override?: string): string {
  return override ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
}

/** Codex 里属于"执行侧"的 item，算调用间隔时要从等待时间里扣掉。 */
const EXECUTION_ITEMS = new Set([
  'CommandExecution',
  'McpToolCall',
  'FileChange',
  'ImageView',
  'WebSearch',
  'TodoList',
  'PlanUpdate',
])

function durationOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    if (!value.trim()) return undefined
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
    const match = /^([\d.]+)\s*(ms|s)$/i.exec(value.trim())
    if (match) {
      const amount = Number(match[1])
      if (Number.isFinite(amount)) return match[2].toLowerCase() === 's' ? amount * 1000 : amount
    }
  }
  if (value && typeof value === 'object') {
    const data = value as Record<string, unknown>
    const secs = numberValue(data.secs)
    const nanos = numberValue(data.nanos)
    if (secs > 0 || nanos > 0) return secs * 1000 + nanos / 1_000_000
  }
  return undefined
}

export function createCodexAdapter(homeOverride?: string): LogSourceAdapter {
  const root = resolveHome(homeOverride)

  return {
    id: 'codex',
    version: 3,
    name: 'Codex CLI',
    description: '读取 Codex rollout 日志；一轮只有一次模型调用时给逐请求速度与首字，多次调用只保留整轮耗时，不把整轮速度复制成每次调用。',
    capabilities: { tokens: true, cache: true, speed: true, ttft: true },
    async detect() {
      return {
        available: (await exists(path.join(root, 'sessions'))) || (await exists(path.join(root, 'archived_sessions'))),
        paths: [displayPath(path.join(root, 'sessions')), displayPath(path.join(root, 'archived_sessions'))],
        note: '压缩的 .zst 会话暂不读取。',
      }
    },
    async listFiles(): Promise<LogFileStat[]> {
      const files = [
        ...(await listFiles(path.join(root, 'sessions'), (name) => name.endsWith('.jsonl'), 6)),
        ...(await listFiles(path.join(root, 'archived_sessions'), (name) => name.endsWith('.jsonl'), 6)),
      ]
      const stats: LogFileStat[] = []
      for (const file of files) {
        const stat = await statFile(file)
        if (!stat) continue
        stats.push({
          path: file,
          sessionId: path.basename(file, '.jsonl'),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      }
      return stats
    },
    async parseFile(file: LogFileStat): Promise<LogRecord[]> {
      const lines = await readJsonLines(file.path)
      const records: LogRecord[] = []
      const seen = new Set<string>()
      let model = 'unknown'
      let previousTotal: Record<string, number> | undefined
      let taskRecords: LogRecord[] = []
      let taskStarted = false
      let taskStartedAt: number | undefined
      let taskId: string | undefined
      let lastUsageAt: number | undefined
      let toolBusyMs = 0

      for (const raw of lines) {
        const entry = raw as Record<string, any>
        const payload = entry?.payload
        if (!payload || typeof payload !== 'object') continue
        if (entry.type === 'turn_context' || entry.type === 'session_meta') {
          const next = payload.model ?? payload.model_name ?? payload.info?.model
          if (typeof next === 'string') model = next
          // 真实日志通常是 task_started → turn_context，更新模型不能取消正在计时的回合。
          if (entry.type === 'turn_context' && taskStarted && taskId && payload.turn_id && payload.turn_id !== taskId) {
            taskRecords = []
            taskStarted = false
            taskStartedAt = undefined
            taskId = undefined
          }
          continue
        }
        if (entry.type === 'event_msg' && payload.type === 'task_started') {
          taskRecords = []
          taskStarted = true
          taskStartedAt = timestampMs(entry.timestamp)
          lastUsageAt = undefined
          toolBusyMs = 0
          taskId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined
          continue
        }
        if (entry.type === 'event_msg' && payload.type === 'item_completed') {
          const itemType = payload.item?.type
          const start = numberValue(payload.started_at_ms)
          const end = numberValue(payload.completed_at_ms)
          if (typeof itemType === 'string' && EXECUTION_ITEMS.has(itemType) && end > start && taskStarted) {
            toolBusyMs += end - start
          }
          continue
        }
        if (entry.type === 'event_msg' && payload.type === 'token_count' && payload.info) {
          const info = payload.info
          const last = info.last_token_usage
          const total = info.total_token_usage
          const usage = last ?? total
          if (!usage) continue
          let inputRaw = numberValue(usage.input_tokens)
          let cached = numberValue(usage.cached_input_tokens)
          let cacheWrite = numberValue(usage.cache_write_input_tokens)
          let output = numberValue(usage.output_tokens)
          let reasoning = numberValue(usage.reasoning_output_tokens)
          if (!last && total && previousTotal) {
            inputRaw = Math.max(0, inputRaw - numberValue(previousTotal.input_tokens))
            cached = Math.max(0, cached - numberValue(previousTotal.cached_input_tokens))
            cacheWrite = Math.max(0, cacheWrite - numberValue(previousTotal.cache_write_input_tokens))
            output = Math.max(0, output - numberValue(previousTotal.output_tokens))
            reasoning = Math.max(0, reasoning - numberValue(previousTotal.reasoning_output_tokens))
          }
          if (total) {
            previousTotal = {
              input_tokens: numberValue(total.input_tokens),
              cached_input_tokens: numberValue(total.cached_input_tokens),
              cache_write_input_tokens: numberValue(total.cache_write_input_tokens),
              output_tokens: numberValue(total.output_tokens),
              reasoning_output_tokens: numberValue(total.reasoning_output_tokens),
            }
          }
          const uncached = Math.max(0, inputRaw - cached - cacheWrite)
          if (uncached + cached + cacheWrite + output + reasoning === 0) continue
          const ts = timestampMs(entry.timestamp) ?? Date.now()
          const key = `${payload.turn_id ?? ''}:${uncached}:${cached}:${cacheWrite}:${output}:${reasoning}`
          if (seen.has(key)) continue
          seen.add(key)
          // 逐请求耗时 = 距上一次调用的间隔 − 这段时间里工具执行占用的时长。
          // 官方日志没有单次生成耗时字段，多响应回合只能这样估，按「估速」标记，不冒充精确值。
          const anchor = lastUsageAt ?? (taskStarted ? taskStartedAt : undefined)
          const rawGap = anchor !== undefined && ts > anchor ? ts - anchor : undefined
          const gapMs = rawGap !== undefined ? rawGap - Math.min(toolBusyMs, rawGap) : undefined
          const gapSpeed = gapMs !== undefined && gapMs >= 200 && output > 0 ? (output * 1000) / gapMs : undefined
          // 折算速度超过物理上限，说明这段窗口里混进了别的调用，宁可这条不给速度。
          const usableGap = gapSpeed !== undefined && gapSpeed <= 500 ? gapMs : undefined
          const record: LogRecord = {
            externalId: `codex:${hashId(file.path, payload.turn_id, key, ts)}`,
            ts,
            model: info.model ?? info.model_name ?? model,
            inputTokens: uncached,
            outputTokens: output,
            cacheReadTokens: cached,
            cacheWriteTokens: cacheWrite,
            reasoningTokens: reasoning,
            ...(usableGap !== undefined ? { durationMs: usableGap, tokensPerSecond: gapSpeed } : {}),
            meta: {
              client: 'codex',
              ...(usableGap !== undefined ? { durationScope: 'turn-gap', durationSource: 'timestamps' } : {}),
            },
          }
          records.push(record)
          if (taskStarted) taskRecords.push(record)
          lastUsageAt = ts
          toolBusyMs = 0
          continue
        }
        if (entry.type === 'event_msg' && payload.type === 'task_complete' && taskStarted) {
          if (taskId && payload.turn_id && payload.turn_id !== taskId) continue
          const completedAt = timestampMs(entry.timestamp)
          const reportedDuration = durationOf(payload.duration_ms) ?? durationOf(payload.duration)
          const elapsed = taskStartedAt !== undefined && completedAt !== undefined ? completedAt - taskStartedAt : undefined
          const duration = reportedDuration !== undefined && reportedDuration > 0 ? reportedDuration : elapsed
          const durationSource = reportedDuration !== undefined && reportedDuration > 0 ? 'reported' : 'timestamps'
          // 一轮里只有一次模型响应时，整轮耗时就是这次调用的耗时，可以给逐请求速度；
          // 多次响应时无法把整轮时间拆到各次调用，宁可只留整轮耗时，也不复制同一个速度冒充逐请求。
          if (taskRecords.length === 1) {
            const only = taskRecords[0]
            if (duration && duration > 0 && only.outputTokens > 0) {
              only.durationMs = duration
              only.tokensPerSecond = (only.outputTokens * 1000) / duration
              only.meta = { ...(only.meta ?? {}), durationScope: 'request', durationSource }
            }
          } else if (taskRecords.length > 1 && duration !== undefined && duration > 0) {
            // 多响应回合：整轮耗时只放在首条记录上做参考，不覆盖这条自己的间隔估算。
            const first = taskRecords[0]
            first.meta = {
              ...(first.meta ?? {}),
              turnMs: duration,
              ...(first.meta?.durationScope ? {} : { durationScope: 'turn', durationSource }),
            }
          }
          const ttft = durationOf(payload.time_to_first_token_ms)
          if (ttft !== undefined && ttft >= 0 && taskRecords.length > 0) {
            // 首个 token 属于整轮：单响应回合即该次调用的首字，多响应回合只代表第一轮的等待。
            taskRecords[0].ttftMs = ttft
            taskRecords[0].meta = {
              ...(taskRecords[0].meta ?? {}),
              ttftScope: taskRecords.length === 1 ? 'request' : 'task',
            }
          }
          taskRecords = []
          taskStarted = false
          taskStartedAt = undefined
          taskId = undefined
        }
      }
      return records
    },
  }
}
