export interface LogFileRef {
  path: string
  sessionId: string
  agentId?: string
  project?: string
}

export interface LogFileStat extends LogFileRef {
  size: number
  mtimeMs: number
}

export interface LogRecord {
  externalId: string
  ts: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  ttftMs?: number
  durationMs?: number
  tokensPerSecond?: number
  meta?: Record<string, string | number>
}

export interface LogDetectResult {
  available: boolean
  paths: string[]
  note?: string
}

export interface LogAdapterCapabilities {
  tokens: boolean
  cache: boolean
  speed: boolean
  ttft: boolean
}

export interface LogSourceAdapter {
  id: string
  /** 解析规则升级后重读原文件，用于补齐已有记录的计时字段。 */
  version?: number
  /** 单文件上限（字节）覆盖；缺省用扫描器的文本日志上限。 */
  maxFileBytes?: number
  name: string
  description: string
  capabilities: LogAdapterCapabilities
  detect(): Promise<LogDetectResult>
  listFiles(): Promise<LogFileStat[]>
  parseFile(file: LogFileStat): Promise<LogRecord[]>
  /** 重建或归属规则变化后清掉适配器内部缓存（如 DSH 的增量解析位置）。 */
  reset?(): void
}
