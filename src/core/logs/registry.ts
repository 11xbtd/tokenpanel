import type { LogSourceAdapter } from './types'
import { createClaudeCodeAdapter } from './adapters/claudeCode'
import { createClineAdapter } from './adapters/cline'
import { createCodexAdapter } from './adapters/codex'
import { createDshAdapter } from './adapters/dsh'
import { createGeminiAdapter } from './adapters/gemini'
import { createKimiCliAdapter } from './adapters/kimiCli'
import { createKimiCodeAdapter } from './adapters/kimiCode'
import { createOpenCodeAdapter } from './adapters/opencode'
import { createQwenAdapter } from './adapters/qwen'
import { createZcodeAdapter } from './adapters/zcode'

export function createLogAdapters(): LogSourceAdapter[] {
  return [
    createKimiCodeAdapter(),
    createKimiCliAdapter(),
    createClaudeCodeAdapter(),
    createCodexAdapter(),
    createGeminiAdapter(),
    createQwenAdapter(),
    createClineAdapter(),
    createOpenCodeAdapter(),
    createZcodeAdapter(),
    createDshAdapter(),
  ]
}
