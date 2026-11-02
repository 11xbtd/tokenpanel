import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createKimiCodeAdapter } from '../src/core/logs/adapters/kimiCode'
import { createKimiCliAdapter } from '../src/core/logs/adapters/kimiCli'
import { createClaudeCodeAdapter } from '../src/core/logs/adapters/claudeCode'
import { createCodexAdapter } from '../src/core/logs/adapters/codex'
import { createDshAdapter } from '../src/core/logs/adapters/dsh'
import { createGeminiAdapter } from '../src/core/logs/adapters/gemini'
import { createQwenAdapter } from '../src/core/logs/adapters/qwen'
import { createClineAdapter } from '../src/core/logs/adapters/cline'
import { createOpenCodeAdapter } from '../src/core/logs/adapters/opencode'
import { createQoderAdapter } from '../src/core/logs/adapters/qoder'
import { createZcodeAdapter } from '../src/core/logs/adapters/zcode'
import { accountBillingMode, autoAccountForSource, logBillingModeForAccount, resolveAccountForRecord, suggestedProviders } from '../src/core/logs/attribution'
import { Store } from '../src/core/storage/store'
import { Pricing } from '../src/core/pricing/pricing'
import { resetLogSourceCache, scanLocalLogs } from '../src/core/logs/scanner'
import { buildOverview } from '../src/core/services/analytics'
import type { AccountPublic, Settings, UsageRecord } from '../src/core/types'
import { PROVIDERS } from '../src/core/providers/registry'

let dir = ''

async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, 'utf8')
}

async function parseAdapter(adapter: ReturnType<typeof createKimiCodeAdapter>) {
  const files = await adapter.listFiles()
  expect(files.length).toBeGreaterThan(0)
  return adapter.parseFile(files[0])
}

function account(id: string, providerId: string, label = id): AccountPublic {
  return {
    id,
    providerId,
    label,
    enabled: true,
    createdAt: 0,
    authMasked: {},
    hasAuth: true,
    options: {},
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenpanel-logs-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('日志适配器', () => {
  it('Kimi Code：step.end 同时给 token 和首字/流式耗时，忽略重复 usage.record', async () => {
    const ts = Date.now() - 60_000
    const wire = path.join(dir, 'sessions', 'wd_x', 'session_y', 'agents', 'main', 'wire.jsonl')
    await write(
      wire,
      [
        JSON.stringify({ type: 'llm.request', model: 'kimi-for-coding', modelAlias: 'alias', turnStep: '1.1', time: ts }),
        JSON.stringify({
          type: 'context.append_loop_event',
          time: ts + 2000,
          event: {
            type: 'step.end',
            turnId: '1',
            step: 1,
            finishReason: 'stop',
            usage: { inputOther: 2505, output: 97, inputCacheRead: 17920, inputCacheCreation: 0 },
            llmFirstTokenLatencyMs: 1779,
            llmStreamDurationMs: 1425,
            llmServerFirstTokenMs: 1777,
          },
        }),
        JSON.stringify({
          type: 'usage.record',
          time: ts + 2000,
          model: 'alias',
          usage: { inputOther: 2505, output: 97, inputCacheRead: 17920, inputCacheCreation: 0 },
        }),
      ].join('\n'),
    )
    const records = await parseAdapter(createKimiCodeAdapter(dir))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      model: 'kimi-for-coding',
      inputTokens: 2505,
      outputTokens: 97,
      cacheReadTokens: 17920,
      ttftMs: 1779,
      durationMs: 1425,
    })
    expect(records[0].tokensPerSecond).toBeCloseTo(97 / 1.425, 3)
  })

  it('Kimi Code：自定义 provider 的别名前缀作为厂商线索，OpenCode Go 不被算成 DeepSeek', async () => {
    const ts = Date.now() - 60_000
    const wire = path.join(dir, 'sessions', 'wd_x', 'session_y', 'agents', 'main', 'wire.jsonl')
    await write(
      wire,
      [
        JSON.stringify({
          type: 'llm.request',
          model: 'deepseek-v4.1-flash',
          modelAlias: 'OpenCode Go/deepseek-v4.1-flash',
          turnStep: '1.1',
          time: ts,
        }),
        JSON.stringify({
          type: 'context.append_loop_event',
          time: ts + 2000,
          event: {
            type: 'step.end',
            turnId: '1',
            step: 1,
            usage: { inputOther: 966, output: 148, inputCacheRead: 26624, inputCacheCreation: 0 },
            llmFirstTokenLatencyMs: 1994,
            llmStreamDurationMs: 1283,
          },
        }),
      ].join('\n'),
    )
    const records = await parseAdapter(createKimiCodeAdapter(dir))
    expect(records[0]).toMatchObject({ model: 'deepseek-v4.1-flash' })
    expect(records[0].meta?.provider).toBe('OpenCode Go')

    const deepseek = account('deepseek', 'deepseek', 'DeepSeek')
    const opencode = account('opencode', 'opencode-go', 'OpenCode Go（订阅）')
    const setting = { id: 'kimi-code', enabled: true, bindings: [] }
    // 没有线索时会被模型名带成 DeepSeek；带上前缀线索后归 OpenCode Go。
    expect(resolveAccountForRecord(records[0].model, setting, [deepseek, opencode]).account?.id).toBe(deepseek.id)
    expect(resolveAccountForRecord(records[0].model, setting, [deepseek, opencode], 'OpenCode Go').account?.id).toBe(
      opencode.id,
    )
  })

  it('Kimi Code：没有 step.end 时，usage.record 也带厂商线索', async () => {
    const ts = Date.now() - 60_000
    const wire = path.join(dir, 'sessions', 'wd_x', 'session_y', 'agents', 'main', 'wire.jsonl')
    await write(
      wire,
      [
        JSON.stringify({
          type: 'llm.request',
          model: 'deepseek-v4.1-flash',
          modelAlias: 'OpenCode Go/deepseek-v4.1-flash',
          time: ts,
        }),
        JSON.stringify({
          type: 'usage.record',
          time: ts + 1000,
          model: 'OpenCode Go/deepseek-v4.1-flash',
          usage: { inputOther: 966, output: 148, inputCacheRead: 26624, inputCacheCreation: 0 },
        }),
      ].join('\n'),
    )
    const records = await parseAdapter(createKimiCodeAdapter(dir))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ model: 'deepseek-v4.1-flash', outputTokens: 148 })
    expect(records[0].meta?.provider).toBe('OpenCode Go')
  })

  it('Kimi CLI：兼容 input_other / cache 字段', async () => {
    await write(
      path.join(dir, 'sessions', 'hash', 'session', 'wire.jsonl'),
      JSON.stringify({
        type: 'StatusUpdate',
        timestamp: new Date().toISOString(),
        payload: {
          model: 'kimi-k2',
          message_id: 'm1',
          token_usage: { input_other: 100, input_cache_read: 50, input_cache_creation: 10, output: 20 },
        },
      }),
    )
    const records = await parseAdapter(createKimiCliAdapter(dir))
    expect(records[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 })
  })

  it('Claude Code：同一 message.id 去重，取更完整的 token，并按消息间隔估算速度', async () => {
    const start = Date.now() - 60_000
    const line = (timestamp: number, output: number) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(timestamp).toISOString(),
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
        },
      })
    await write(
      path.join(dir, 'projects', 'proj', 'session.jsonl'),
      [
        JSON.stringify({ type: 'user', timestamp: new Date(start).toISOString(), message: { role: 'user', content: 'hi' } }),
        line(start + 5000, 50),
        line(start + 5000, 55),
      ].join('\n'),
    )
    const records = await parseAdapter(createClaudeCodeAdapter(dir))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outputTokens: 55, cacheReadTokens: 20, cacheWriteTokens: 10, durationMs: 5000 })
    expect(records[0].tokensPerSecond).toBeCloseTo(11, 3)
  })

  it('Codex：扣除缓存输入，task_complete 回合级速度', async () => {
    const ts = Date.now() - 60_000
    await write(
      path.join(dir, 'sessions', '2026', '10', '29', 'rollout-x.jsonl'),
      [
        JSON.stringify({ type: 'turn_context', timestamp: new Date(ts).toISOString(), payload: { model: 'gpt-5.1' } }),
        JSON.stringify({ type: 'event_msg', timestamp: new Date(ts).toISOString(), payload: { type: 'task_started' } }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: new Date(ts + 10_000).toISOString(),
          payload: {
            type: 'token_count',
            turn_id: 't1',
            info: {
              last_token_usage: {
                input_tokens: 1000,
                cached_input_tokens: 200,
                cache_write_input_tokens: 50,
                output_tokens: 100,
                reasoning_output_tokens: 10,
              },
              total_token_usage: { input_tokens: 1000, output_tokens: 100 },
            },
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: new Date(ts + 11_000).toISOString(),
          payload: { type: 'task_complete', duration_ms: 10_000 },
        }),
      ].join('\n'),
    )
    const records = await parseAdapter(createCodexAdapter(dir))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ inputTokens: 750, cacheReadTokens: 200, cacheWriteTokens: 50, outputTokens: 100, reasoningTokens: 10 })
    expect(records[0].tokensPerSecond).toBeCloseTo(10, 2)
    // 一轮只有一次响应：整轮耗时就是这次调用的耗时。
    expect(records[0].meta?.durationScope).toBe('request')
  })

  it('Codex：task_started 后的 turn_context 不丢失回合耗时，首字只记一次', async () => {
    const ts = Date.now() - 60_000
    const event = (offset: number, payload: Record<string, unknown>) => JSON.stringify({ type: 'event_msg', timestamp: new Date(ts + offset).toISOString(), payload })
    await write(path.join(dir, 'sessions', 'rollout-turn.jsonl'), [
      event(0, { type: 'task_started', turn_id: 't1' }),
      JSON.stringify({ type: 'turn_context', timestamp: new Date(ts).toISOString(), payload: { turn_id: 't1', model: 'gpt-6.1-sol' } }),
      event(5000, { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 980, output_tokens: 100 } } }),
      event(9000, { type: 'token_count', info: { last_token_usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 200 } } }),
      event(10_000, { type: 'task_complete', turn_id: 't1', duration_ms: 10_000, time_to_first_token_ms: 900 }),
    ].join('\n'))
    const records = await parseAdapter(createCodexAdapter(dir))
    expect(records).toHaveLength(2)
    // 一轮两次响应：每条按自己的调用间隔给估速（5s/100、4s/200），整轮耗时只做参考。
    expect(records.map((record) => record.tokensPerSecond)).toEqual([20, 50])
    expect(records[0]).toMatchObject({ inputTokens: 20, cacheReadTokens: 980, outputTokens: 100, ttftMs: 900, durationMs: 5000 })
    expect(records[0].meta).toMatchObject({ durationScope: 'turn-gap', turnMs: 10_000, ttftScope: 'task' })
    expect(records[1].ttftMs).toBeUndefined()
    expect(records[1].meta?.turnMs).toBeUndefined()
  })

  it('Codex：可用起止时间估算回合均速，但不推测首字耗时', async () => {
    const ts = Date.now() - 60_000
    await write(path.join(dir, 'sessions', 'rollout-timestamps.jsonl'), [
      { type: 'event_msg', timestamp: new Date(ts).toISOString(), payload: { type: 'task_started' } },
      { type: 'turn_context', timestamp: new Date(ts).toISOString(), payload: { model: 'gpt-6.1-sol' } },
      { type: 'event_msg', timestamp: new Date(ts + 4000).toISOString(), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 20 } } } },
      { type: 'event_msg', timestamp: new Date(ts + 5000).toISOString(), payload: { type: 'task_complete' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'))
    const records = await parseAdapter(createCodexAdapter(dir))
    expect(records[0].tokensPerSecond).toBe(4)
    expect(records[0].meta?.durationSource).toBe('timestamps')
    expect(records[0].ttftMs).toBeUndefined()
  })

  it('Codex：不完整回合不制造速度，其他回合的完成事件不能串入', async () => {
    const ts = Date.now() - 60_000
    const event = (offset: number, payload: Record<string, unknown>) => JSON.stringify({ type: 'event_msg', timestamp: new Date(ts + offset).toISOString(), payload })
    await write(path.join(dir, 'sessions', 'rollout-incomplete.jsonl'), [
      event(0, { type: 'task_started', turn_id: 'a' }),
      event(1000, { type: 'token_count', turn_id: 'a', info: { last_token_usage: { input_tokens: 100, output_tokens: 20 } } }),
      event(2000, { type: 'task_started', turn_id: 'b' }),
      event(3000, { type: 'token_count', turn_id: 'b', info: { last_token_usage: { input_tokens: 100, output_tokens: 40 } } }),
      event(4000, { type: 'task_complete', turn_id: 'a', duration_ms: 4000 }),
      event(6000, { type: 'task_complete', turn_id: 'b', duration_ms: 4000 }),
    ].join('\n'))
    const records = await parseAdapter(createCodexAdapter(dir))
    // 回合 a 只有一次调用，间隔 1s/20 够给估速；但它没有完成事件，不能让 b 的完成时间串进来。
    expect(records[0].tokensPerSecond).toBe(20)
    expect(records[0].meta?.durationScope).toBe('turn-gap')
    expect(records[1].tokensPerSecond).toBe(10)
    expect(records[1].meta?.durationScope).toBe('request')
  })

  it('Gemini CLI：input 是含 cached 的总数，需要相减', async () => {
    await write(
      path.join(dir, 'tmp', 'proj', 'chats', 'session-1.json'),
      JSON.stringify({
        sessionId: 's1',
        startTime: new Date().toISOString(),
        messages: [
          {
            id: 'm1',
            type: 'gemini',
            timestamp: new Date().toISOString(),
            model: 'gemini-2.5-pro',
            tokens: { input: 1000, cached: 200, output: 100, thoughts: 50 },
          },
        ],
      }),
    )
    const records = await parseAdapter(createGeminiAdapter(dir))
    expect(records[0]).toMatchObject({ inputTokens: 800, cacheReadTokens: 200, outputTokens: 100, reasoningTokens: 50 })
  })

  it('Qwen Code：prompt 含 cached，需要相减', async () => {
    await write(
      path.join(dir, 'proj', 'chats', 'session.jsonl'),
      JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        uuid: 'u1',
        timestamp: new Date().toISOString(),
        model: 'qwen3-coder',
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 100,
          thoughtsTokenCount: 20,
          cachedContentTokenCount: 200,
        },
      }),
    )
    const records = await parseAdapter(createQwenAdapter(dir))
    expect(records[0]).toMatchObject({ inputTokens: 800, cacheReadTokens: 200, outputTokens: 100, reasoningTokens: 20 })
  })

  it('Cline/Roo/Kilo：api_req_started 的 tokens 与缓存', async () => {
    await write(
      path.join(dir, 'tasks', 't1', 'ui_messages.json'),
      JSON.stringify([
        {
          type: 'say',
          say: 'api_req_started',
          ts: Date.now(),
          text: JSON.stringify({
            tokensIn: 1000,
            tokensOut: 100,
            cacheReads: 200,
            cacheWrites: 50,
            modelId: 'glm-4.6',
          }),
        },
      ]),
    )
    const records = await parseAdapter(createClineAdapter(dir))
    expect(records[0]).toMatchObject({
      model: 'glm-4.6',
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
    })
  })

  it('OpenCode：文件式存储的 tokens 与 created→completed 速度', async () => {
    const created = Date.now() - 60_000
    await write(
      path.join(dir, 'storage', 'message', 's1', 'm1.json'),
      JSON.stringify({
        id: 'm1',
        role: 'assistant',
        modelID: 'claude-sonnet-4-5',
        time: { created, completed: created + 10_000 },
        tokens: { input: 1000, output: 100, reasoning: 10, cache: { read: 200, write: 50 } },
      }),
    )
    const records = await parseAdapter(createOpenCodeAdapter(dir))
    expect(records[0]).toMatchObject({ inputTokens: 1000, outputTokens: 100, reasoningTokens: 10, cacheReadTokens: 200, cacheWriteTokens: 50 })
    expect(records[0].tokensPerSecond).toBeCloseTo(10, 2)
  })
})

describe('归属规则', () => {
  const claude = account('claude', 'claude-plan', 'Claude')
  const glm = account('glm', 'glm-plan', 'GLM')
  const minimax = account('minimax', 'minimax-plan', 'MiniMax')
  const accounts = [claude, glm, minimax]

  it('只绑 Claude 时，GLM 模型仍按模型规则归属 GLM', () => {
    const result = resolveAccountForRecord('glm-4.6', { id: 'claude-code', enabled: true, bindings: [{ accountId: claude.id }] }, accounts)
    expect(result.account?.id).toBe(glm.id)
    expect(result.via).toBe('auto')
  })

  it('绑定里的模型匹配优先于自动规则', () => {
    const result = resolveAccountForRecord(
      'glm-4.6',
      { id: 'claude-code', enabled: true, bindings: [{ accountId: glm.id, modelPattern: 'glm' }] },
      accounts,
    )
    expect(result.account?.id).toBe(glm.id)
    expect(result.via).toBe('manual')
  })

  it('一个来源可以绑多个套餐，按模型分别归属', () => {
    const bindings = [
      { accountId: glm.id, modelPattern: 'glm' },
      { accountId: minimax.id, modelPattern: 'minimax' },
      { accountId: claude.id },
    ]
    const setting = { id: 'zcode', enabled: true, bindings }
    expect(resolveAccountForRecord('GLM-5.3', setting, accounts).account?.id).toBe(glm.id)
    expect(resolveAccountForRecord('MiniMax-M2', setting, accounts).account?.id).toBe(minimax.id)
    expect(resolveAccountForRecord('unknown-internal', setting, accounts).account?.id).toBe(claude.id)
  })

  it('没有任何匹配时不算到任何账户上（扫描层据此不入库）', () => {
    const result = resolveAccountForRecord('some-private-model', { id: 'cline', enabled: true, bindings: [] }, accounts)
    expect(result.account).toBeUndefined()
    expect(result.via).toBe('none')
  })

  it('模型明确指向别家却没有那个套餐账户时，不落默认绑定', () => {
    const minimax = account('minimax', 'minimax-plan', 'MiniMax')
    const setting = { id: 'zcode', enabled: true, bindings: [{ accountId: minimax.id }] }
    // GLM-5.3 明确是智谱的模型：没有智谱套餐账户就不能记到 MiniMax 头上。
    const result = resolveAccountForRecord('GLM-5.3-Flash', setting, [minimax])
    expect(result.account).toBeUndefined()
    expect(result.via).toBe('none')
    // 显式正则指定的账户不存在时同样不落。
    const stale = resolveAccountForRecord(
      'GLM-5.3',
      { id: 'zcode', enabled: true, bindings: [{ accountId: 'deleted-id', modelPattern: 'glm' }, { accountId: minimax.id }] },
      [minimax],
    )
    expect(stale.account).toBeUndefined()
    expect(stale.via).toBe('none')
  })

  it('OpenCode 这类订阅预设仍算套餐侧', () => {
    const opencode = account('opencode', 'opencode-go', 'OpenCode Go（订阅）')
    expect(accountBillingMode(opencode)).toBe('plan')
    expect(logBillingModeForAccount(opencode)).toBe('plan')
    const apiOnly = account('deepseek', 'deepseek', 'DeepSeek')
    expect(accountBillingMode(apiOnly)).toBe('api')
    expect(logBillingModeForAccount(apiOnly)).toBe('api')
  })

  it('日志源自动认到对应的套餐账户', () => {
    const opencode = account('opencode', 'opencode-go', 'OpenCode Go（订阅）')
    expect(autoAccountForSource('opencode', [opencode])).toBe(opencode.id)
    // Go 账户优先于按量余额账户。
    const balance = account('opencode-balance', 'opencode-balance', 'OpenCode Console')
    expect(autoAccountForSource('opencode', [balance])).toBe(balance.id)
    expect(autoAccountForSource('opencode', [balance, opencode])).toBe(opencode.id)
    // 没有对应预设的来源不乱认。
    expect(autoAccountForSource('qoder', [opencode])).toBeUndefined()
  })

  it('模型规则能指出"本该归到哪个账户"', () => {
    expect(suggestedProviders('GLM-5.3-Flash')).toEqual(['glm-plan', 'zai-plan', 'zhipu-balance'])
    expect(suggestedProviders('kimi-for-coding')).toEqual(['kimi-code-plan'])
    expect(suggestedProviders('MiniMax-M2')).toEqual(['minimax-plan', 'minimax-balance'])
    // 客户端内部 key 不猜厂商：同一个 dfmodel 可能是用户自配的 MiniMax。
    expect(suggestedProviders('dfmodel')).toEqual([])
    expect(suggestedProviders('qfmodel')).toEqual([])
    expect(suggestedProviders('some-private-model')).toEqual([])
    // 但日志自带厂商线索时（ZCode 的 provider_id）可以认出来。
    expect(suggestedProviders('custom-name', 'builtin:bigmodel-start-plan')).toEqual(['glm-plan', 'zai-plan'])
    expect(suggestedProviders('custom-name', 'builtin:minimax')).toEqual(['minimax-plan', 'minimax-balance'])
    // 按量厂商：DeepSeek 的调用归 DeepSeek 按量账户。
    expect(suggestedProviders('deepseek-chat')).toEqual(['deepseek'])
  })

  it('按量厂商的日志调用归到按量账户，不进套餐', () => {
    const deepseek = account('deepseek', 'deepseek', 'DeepSeek')
    const result = resolveAccountForRecord('deepseek-chat', { id: 'cline', enabled: true, bindings: [] }, [deepseek])
    expect(result.account?.id).toBe(deepseek.id)
    expect(result.via).toBe('auto')
    expect(logBillingModeForAccount(deepseek)).toBe('api')
  })

  it('同一模型先匹配套餐账户，没有套餐账户才用按量账户', () => {
    const minimaxPlan = account('minimax-plan', 'minimax-plan', 'MiniMax 套餐')
    const minimaxPay = account('minimax-pay', 'minimax-balance', 'MiniMax 按量')
    const both = [minimaxPlan, minimaxPay]
    expect(resolveAccountForRecord('MiniMax-M2', { id: 'x', enabled: true, bindings: [] }, both).account?.id).toBe(
      minimaxPlan.id,
    )
    expect(resolveAccountForRecord('MiniMax-M2', { id: 'x', enabled: true, bindings: [] }, [minimaxPay]).account?.id).toBe(
      minimaxPay.id,
    )
  })

  it('日志自带的厂商线索优先于默认绑定', () => {
    const minimax = account('minimax', 'minimax-plan', 'MiniMax')
    const glm = account('glm', 'glm-plan', 'GLM')
    const setting = { id: 'zcode', enabled: true, bindings: [{ accountId: minimax.id }] }
    // 模型名自带厂商时按模型名归。
    const byName = resolveAccountForRecord('GLM-5.3-Flash', setting, [minimax, glm], 'builtin:bigmodel-start-plan')
    expect(byName.account?.id).toBe(glm.id)
    // 模型名没有厂商信息时，靠日志里的 provider_id 认出来。
    const byHint = resolveAccountForRecord('custom-name', setting, [minimax, glm], 'builtin:bigmodel-start-plan')
    expect(byHint.account?.id).toBe(glm.id)
    expect(byHint.via).toBe('provider')
    // 没有厂商线索的模型走默认绑定（用户自配的 MiniMax 就该落这里）。
    const custom = resolveAccountForRecord('dfmodel', setting, [minimax, glm])
    expect(custom.account?.id).toBe(minimax.id)
    expect(custom.via).toBe('manual')
  })
})

describe('Qoder 与 ZCode 适配器', () => {
  it('Qoder：token 在 local.db 的 chat_message.token_info 里，支持自定义模型', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbPath = path.join(dir, 'qoder', 'shared_client', 'cache', 'db', 'local.db')
    await fs.mkdir(path.dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec(
      `CREATE TABLE chat_message (
         id TEXT PRIMARY KEY, session_id TEXT, request_id TEXT, role TEXT,
         token_info TEXT, model_info TEXT, gmt_create INTEGER)`,
    )
    const insert = db.prepare(
      'INSERT INTO chat_message (id, session_id, request_id, role, token_info, model_info, gmt_create) VALUES (?,?,?,?,?,?,?)',
    )
    insert.run(
      'm1',
      's1',
      'r1',
      'assistant',
      JSON.stringify({ prompt_tokens: 1000, completion_tokens: 100, cached_tokens: 200, max_input_tokens: 400000 }),
      JSON.stringify({ model_key: 'my-custom-model' }),
      1_700_000_000_000,
    )
    insert.run('m2', 's1', null, 'tool', '', '', 1_700_000_001_000)
    db.close()

    const records = await parseAdapter(createQoderAdapter(path.join(dir, 'qoder')))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      model: 'my-custom-model',
      inputTokens: 800,
      outputTokens: 100,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
    })
  })

  it('ZCode：SQLite model_usage 带 token、耗时与真实首字耗时', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbPath = path.join(dir, 'zcode', 'cli', 'db', 'db.sqlite')
    await fs.mkdir(path.dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec(
      `CREATE TABLE model_usage (
         id INTEGER PRIMARY KEY, session_id TEXT, turn_id TEXT, model_id TEXT, provider_id TEXT,
         input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
         cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
         started_at INTEGER, completed_at INTEGER, first_token_at INTEGER,
         duration_ms INTEGER, time_to_first_token_ms INTEGER)`,
    )
    const insert = db.prepare(
      `INSERT INTO model_usage (id, session_id, turn_id, model_id, provider_id, input_tokens,
         output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens,
         started_at, completed_at, first_token_at, duration_ms, time_to_first_token_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    insert.run(1, 's1', 't1', 'GLM-5.3', 'zai', 1000, 200, 50, 100, 4000, 1_700_000_000_000, 1_700_000_003_000, 1_700_000_000_800, 3000, 800)
    insert.run(2, 's1', 't2', 'GLM-5.3', 'zai', 0, 0, 0, 0, 0, 1_700_000_010_000, 1_700_000_011_000, null, 1000, null)
    db.close()

    const records = await parseAdapter(createZcodeAdapter(path.join(dir, 'zcode')))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      model: 'GLM-5.3',
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 50,
      cacheReadTokens: 4000,
      cacheWriteTokens: 100,
      ttftMs: 800,
      durationMs: 3000,
    })
    expect(records[0].tokensPerSecond).toBeCloseTo(200 / 3, 4)
  })
})

describe('DeepSeek Harness 与 OpenCode 适配器', () => {
  it('DSH：zstd 会话日志按帧解开，取每次调用的 usage 与当前模型', async () => {
    const zlib = await import('node:zlib')
    const rows = [
      { type: 'session', seq: 1, time: 1_700_000_000_000, data: { id: 'session-1', createdAt: 1_700_000_000_000 } },
      {
        type: 'model/selection',
        seq: 2,
        time: 1_700_000_001_000,
        data: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      },
      {
        type: 'step/start',
        seq: 3,
        time: 1_700_000_001_500,
        data: { turn: 1, step: 1 },
      },
      {
        type: 'assistant/chunk',
        seq: 4,
        time: 1_700_000_001_800,
        data: { turn: 1, step: 1, chunk: { content: 'x' } },
      },
      {
        type: 'assistant/message',
        seq: 5,
        time: 1_700_000_002_000,
        data: {
          turn: 1,
          step: 1,
          usage: { inputTokens: 8480, outputTokens: 307, totalTokens: 8787, cacheReadTokens: 0, reasoningTokens: 131 },
        },
      },
      {
        type: 'assistant/message',
        seq: 6,
        time: 1_700_000_003_000,
        data: {
          turn: 1,
          step: 2,
          usage: { inputTokens: 2332, outputTokens: 600, totalTokens: 11636, cacheReadTokens: 8704, reasoningTokens: 169 },
        },
      },
    ]
    const payload = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8')
    const compressed = (zlib as any).zstdCompressSync
    if (typeof compressed !== 'function') {
      // Node 20 没有 zstd，跳过
      return
    }
    const sessionPath = path.join(dir, 'dsh', 'sessions', 'proj', 'session-abc', 'session.jsonl.zstd')
    await fs.mkdir(path.dirname(sessionPath), { recursive: true })
    await fs.writeFile(sessionPath, compressed(payload))

    const adapter = createDshAdapter(path.join(dir, 'dsh'))
    const files = await adapter.listFiles()
    expect(files).toHaveLength(1)
    const records = await adapter.parseFile(files[0])
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      inputTokens: 8480,
      outputTokens: 307,
      reasoningTokens: 131,
      cacheReadTokens: 0,
      ts: 1_700_000_002_000,
    })
    expect(records[1].cacheReadTokens).toBe(8704)
    expect(records[0].meta?.provider).toBe('deepseek-official')
    // 首字 = 首个 assistant/chunk − step/start；速度 = 输出 token ÷（message − 首包），工具时间不算进来。
    expect(records[0].ttftMs).toBe(300)
    expect(records[0].durationMs).toBe(500)
    expect(records[0].tokensPerSecond).toBeCloseTo(1535, 0)
    // 缺 step/start 的那一步不编时间，保持 undefined。
    expect(records[1].ttftMs).toBeUndefined()
    expect(records[1].tokensPerSecond).toBeUndefined()
  })

  it('DSH：uTools 的 Node 20 用 fzstd 回退解码多帧日志', async () => {
    const zlib = await import('node:zlib')
    const compressed = (zlib as any).zstdCompressSync
    if (typeof compressed !== 'function') return
    const rows = [
      { type: 'model/selection', seq: 1, time: 1_700_000_001_000, data: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
      { type: 'step/start', seq: 2, time: 1_700_000_001_500, data: { turn: 1, step: 1 } },
      { type: 'assistant/chunk', seq: 3, time: 1_700_000_001_600, data: { turn: 1, step: 1, chunk: { content: 'x' } } },
      {
        type: 'assistant/message',
        seq: 4,
        time: 1_700_000_002_000,
        data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, reasoningTokens: 50 } },
      },
    ]
    const frames = rows.map((row) => compressed(Buffer.from(`${JSON.stringify(row)}\n`, 'utf8')))
    const sessionPath = path.join(dir, 'dsh-fallback', 'sessions', 'proj', 'session-fb', 'session.jsonl.zstd')
    await fs.mkdir(path.dirname(sessionPath), { recursive: true })
    await fs.writeFile(sessionPath, Buffer.concat(frames))

    const adapter = createDshAdapter(path.join(dir, 'dsh-fallback'), { forceFallback: true })
    const files = await adapter.listFiles()
    expect(files).toHaveLength(1)
    const records = await adapter.parseFile(files[0])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      reasoningTokens: 50,
      ttftMs: 100,
    })
  })

  it('OpenCode：SQLite 版从 message.data 取用量与模型', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const root = path.join(dir, 'opencode')
    await fs.mkdir(root, { recursive: true })
    const db = new DatabaseSync(path.join(root, 'opencode.db'))
    db.exec(
      `CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, slug TEXT, title TEXT,
         directory TEXT, time_created INTEGER, time_updated INTEGER, model TEXT, cost REAL)`,
    )
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)`)
    db.prepare('INSERT INTO session (id, model) VALUES (?, ?)').run('s1', JSON.stringify({ id: 'gpt-5' }))
    db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)').run(
      'm1',
      's1',
      JSON.stringify({
        role: 'assistant',
        time: { created: 1_700_000_000_000, completed: 1_700_000_002_000 },
        tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 300, write: 20 } },
        providerID: 'openai',
      }),
    )
    db.close()

    const adapter = createOpenCodeAdapter(root)
    const files = await adapter.listFiles()
    expect(files.some((file) => file.path.endsWith('opencode.db'))).toBe(true)
    const records = await adapter.parseFile(files.find((file) => file.path.endsWith('opencode.db'))!)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      model: 'gpt-5',
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 50,
      cacheReadTokens: 300,
      cacheWriteTokens: 20,
      durationMs: 2000,
    })
  })
})

describe('扫描与按量/套餐分离', () => {
  it('Codex 解析升级自动补齐旧计时，不重复统计 token；回合完成后也能增量补齐', async () => {
    const store = await Store.open(dir)
    const preset = PROVIDERS.find((provider) => provider.id === 'codex-plan')!
    const user = await store.saveAccount({ providerId: 'codex-plan', auth: Object.fromEntries(preset.auth.map((field) => [field.key, 'test-codex'])) })
    const root = path.join(dir, 'codex-home')
    const file = path.join(root, 'sessions', 'rollout-timing.jsonl')
    const ts = Date.now() - 60_000
    const event = (offset: number, payload: Record<string, unknown>) => JSON.stringify({ type: 'event_msg', timestamp: new Date(ts + offset).toISOString(), payload })
    const prefix = [
      event(0, { type: 'task_started', turn_id: 't' }),
      JSON.stringify({ type: 'turn_context', timestamp: new Date(ts).toISOString(), payload: { model: 'gpt-6.1-sol', turn_id: 't' } }),
      event(1000, { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 100 } } }),
    ].join('\n')
    await write(file, prefix)
    const adapter = createCodexAdapter(root)
    const pricing = new Pricing({ updatedAt: 0, models: {} }, 7.2)
    const settings = { ...store.getSettings(), logSources: [{ id: 'codex', enabled: true, bindings: [{ accountId: user.id }] }] }
    const scan = (selected = adapter) => scanLocalLogs({ store, pricing, settings, adapters: [selected] })
    expect((await scan({ ...adapter, version: 1 })).imported).toBe(1)
    const originalId = store.getUsageSince(0)[0].id
    // 文件内容不变但解析版本升级，需要重读一次；完成事件到之前只有间隔估速。
    expect((await scan()).sources[0].skipped).toBe(0)
    expect(store.getUsageSince(0)[0].tokensPerSecond).toBe(100)
    expect(store.getUsageSince(0)[0].meta?.durationScope).toBe('turn-gap')
    await fs.appendFile(file, '\n' + event(10_000, { type: 'task_complete', turn_id: 't', duration_ms: 10_000, time_to_first_token_ms: 800 }))
    const completed = await scan()
    expect(completed.imported).toBe(0)
    expect(completed.updated).toBe(1)
    expect(store.getUsageSince(0)).toHaveLength(1)
    expect(store.getUsageSince(0)[0]).toMatchObject({ id: originalId, inputTokens: 100, cacheReadTokens: 900, outputTokens: 100, tokensPerSecond: 10, ttftMs: 800 })
    expect((await scan()).sources[0].skipped).toBe(1)
    const overview = buildOverview({ accounts: store.listAccounts(), providers: new Map(PROVIDERS.map((provider) => [provider.id, provider])), latest: new Map(), usage: store.getUsageSince(0), ledger: [], sync: {}, settings, days: 30 })
    const stats = overview.accounts[0].planStats!
    expect(stats.rangeInput + stats.rangeCacheRead + stats.rangeCacheWrite + stats.rangeOutput).toBe(stats.rangeTokens)
    // 单次响应的回合：耗时就是这次调用的，速度不再标估算。
    expect(stats).toMatchObject({ rangeTokens: 1100, speedP50: 10, speedSamples: 1, ttftP50: 800 })
    expect(stats.speedEstimated).toBeUndefined()
  })

  it('日志里的按量模型落到按量账户，按价目表估算金额', async () => {
    const store = await Store.open(dir)
    const deepseek = await store.saveAccount({
      providerId: 'deepseek',
      label: 'DeepSeek',
      auth: { apiKey: 'sk-test' },
    })
    const ts = Date.now() - 60_000
    await write(
      path.join(dir, 'kimi-home', 'sessions', 'wd_x', 'session_y', 'agents', 'main', 'wire.jsonl'),
      [
        JSON.stringify({ type: 'llm.request', model: 'deepseek-chat', time: ts }),
        JSON.stringify({
          type: 'context.append_loop_event',
          time: ts + 2000,
          event: {
            type: 'step.end',
            turnId: '1',
            step: 1,
            usage: { inputOther: 1_000_000, output: 1_000_000, inputCacheRead: 0, inputCacheCreation: 0 },
          },
        }),
      ].join('\n'),
    )
    const adapter = createKimiCodeAdapter(path.join(dir, 'kimi-home'))
    const pricing = new Pricing({ updatedAt: 0, models: {} }, 7.2)
    const settings = { ...store.getSettings(), logSources: [{ id: 'kimi-code', enabled: true, bindings: [] }] }
    const result = await scanLocalLogs({ store, pricing, settings, adapters: [adapter] })
    expect(result.imported).toBe(1)

    const [record] = store.getUsageSince(0)
    expect(record.accountId).toBe(deepseek.id)
    expect(record.providerId).toBe('deepseek')
    expect(record.billingMode).toBe('api')
    expect(record.costEstimated).toBe(true)
    expect(record.costUsdMicros).toBeGreaterThan(0)

    // 按量卡片的 token 视图要和套餐卡同构：输入/输出/次数/走势都得有。
    const overview = buildOverview({
      accounts: store.listAccounts(),
      providers: new Map(PROVIDERS.map((provider) => [provider.id, provider])),
      latest: store.latestSnapshots(),
      usage: store.getUsageSince(0),
      ledger: [],
      sync: {},
      settings: store.getSettings(),
      days: 30,
    })
    const api = overview.accounts.find((account) => account.providerId === 'deepseek')!
    expect(api.apiStats?.rangeInput).toBe(1_000_000)
    expect(api.apiStats?.rangeOutput).toBe(1_000_000)
    expect(api.apiStats?.rangeCalls).toBe(1)
    expect(api.apiStats?.rangeTokens).toBe(2_000_000)
    expect(api.apiStats?.rangeCacheHitRate).toBe(0)
    expect(api.apiStats?.allTokens).toBe(2_000_000)
    expect(api.apiStats?.monthTokens).toBe(2_000_000)
    expect(api.apiTokenSparkline.reduce((sum, value) => sum + value, 0)).toBe(2_000_000)
    expect(api.monthUsd).toBeGreaterThan(0)
    // 估算的钱只入库不展示：实际计费口径必须是 0。
    expect(api.monthActualUsd).toBe(0)
    expect(api.daysLeft).toBeUndefined()
    expect(overview.totals.monthActualUsd).toBe(0)
    expect(overview.totals.todayActualUsd).toBe(0)
    expect(overview.byModel[0].costUsd).toBeGreaterThan(0)
    expect(overview.byModel[0].actualUsd).toBe(0)
    expect(overview.byAccount[0].actualUsd).toBe(0)
    expect(overview.trend.find((day) => day.tokens > 0)?.actualUsd).toBe(0)
    expect(overview.accounts.find((account) => account.providerId === 'deepseek')!.planStats).toBeUndefined()
  })

  it('增量导入只写套餐记录，不进按量金额', async () => {
    const store = await Store.open(dir)
    const user = await store.saveAccount({ providerId: 'kimi-code-plan', label: 'Kimi Code', auth: { apiKey: 'sk-test' } })
    const ts = Date.now() - 60_000
    await write(
      path.join(dir, 'kimi-home', 'sessions', 'wd_x', 'session_y', 'agents', 'main', 'wire.jsonl'),
      [
        JSON.stringify({ type: 'llm.request', model: 'kimi-for-coding', time: ts }),
        JSON.stringify({
          type: 'context.append_loop_event',
          time: ts + 2000,
          event: {
            type: 'step.end',
            turnId: '1',
            step: 1,
            usage: { inputOther: 1000, output: 100, inputCacheRead: 200, inputCacheCreation: 0 },
            llmFirstTokenLatencyMs: 1500,
            llmStreamDurationMs: 2000,
          },
        }),
      ].join('\n'),
    )
    const adapter = createKimiCodeAdapter(path.join(dir, 'kimi-home'))
    const settings = {
      ...store.getSettings(),
      logSources: [{ id: 'kimi-code', enabled: true, bindings: [{ accountId: user.id }] }],
    }
    const pricing = new Pricing({ updatedAt: 0, models: {} }, 7.2)
    const first = await scanLocalLogs({ store, pricing, settings, adapters: [adapter] })
    expect(first.imported).toBe(1)
    expect(first.sources[0].unattributed).toBe(0)
    const second = await scanLocalLogs({ store, pricing, settings, adapters: [adapter] })
    expect(second.imported).toBe(0)
    expect(second.sources[0].skipped).toBe(1)

    const usage = store.getUsageSince(0)
    expect(usage[0].billingMode).toBe('plan')
    expect(usage[0].costUsdMicros).toBe(0)
    expect(usage[0].ttftMs).toBe(1500)
    // 归属依据要留痕，明细页据此显示"模型规则/绑定命中/厂商线索/未归属"。
    expect(usage[0].meta?.source).toBe('auto')

    const overview = buildOverview({
      accounts: store.listAccounts(),
      providers: new Map(PROVIDERS.map((provider) => [provider.id, provider])),
      latest: store.latestSnapshots(),
      usage,
      ledger: [],
      sync: {},
      settings: store.getSettings(),
      days: 30,
    })
    expect(overview.totals.todayUsd).toBe(0)
    expect(overview.planTotals.allTokens).toBe(1300)
    expect(overview.planTotals.ttftP50).toBe(1500)
    expect(overview.totals.balanceDisplay).toBe(0)
  })

  it('未归属调用不入库，改绑定后重扫能补进来', async () => {
    const store = await Store.open(dir)
    const user = await store.saveAccount({ providerId: 'kimi-code-plan', label: 'Kimi Code', auth: { apiKey: 'sk-test' } })
    const ts = Date.now() - 60_000
    await write(
      path.join(dir, 'kimi-home', 'sessions', 'wd_x', 'session_y', 'agents', 'main', 'wire.jsonl'),
      [
        JSON.stringify({ type: 'llm.request', model: 'unknown-private-model', time: ts }),
        JSON.stringify({
          type: 'context.append_loop_event',
          time: ts + 2000,
          event: {
            type: 'step.end',
            turnId: '1',
            step: 1,
            usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
          },
        }),
      ].join('\n'),
    )
    const adapter = createKimiCodeAdapter(path.join(dir, 'kimi-home'))
    const pricing = new Pricing({ updatedAt: 0, models: {} }, 7.2)
    const unbound = { ...store.getSettings(), logSources: [{ id: 'kimi-code', enabled: true, bindings: [] }] }
    const first = await scanLocalLogs({ store, pricing, settings: unbound, adapters: [adapter] })
    // 匹配不上归属就不入库：宁可不统计，也别把别家的调用算进某个套餐。
    expect(first.imported).toBe(0)
    expect(first.unattributed).toBe(1)
    expect(store.getUsageSince(0)).toHaveLength(0)
    expect(store.sourceStats('kimi-code')).toEqual({ records: 0, tokens: 0 })

    const overviewWithoutAccount = buildOverview({
      accounts: store.listAccounts(),
      providers: new Map(PROVIDERS.map((provider) => [provider.id, provider])),
      latest: store.latestSnapshots(),
      usage: store.getUsageSince(0),
      ledger: [],
      sync: {},
      settings: store.getSettings(),
      days: 30,
    })
    expect(overviewWithoutAccount.planTotals.allTokens).toBe(0)
    expect(overviewWithoutAccount.accounts[0].planStats).toBeUndefined()

    const mapped = {
      ...store.getSettings(),
      logSources: [{ id: 'kimi-code', enabled: true, bindings: [{ accountId: user.id }] }],
    }
    // 归属变了：app 层先清掉该来源的记录与文件缓存，再重扫。
    await store.removeUsageByClient('kimi-code')
    await resetLogSourceCache(dir, 'kimi-code')
    const second = await scanLocalLogs({ store, pricing, settings: mapped, adapters: [adapter] })
    expect(second.imported).toBe(1)
    expect(second.unattributed).toBe(0)
    expect(store.getUsageSince(0)).toHaveLength(1)
    expect(store.getUsageSince(0)[0].accountId).toBe(user.id)

    const overviewMapped = buildOverview({
      accounts: store.listAccounts(),
      providers: new Map(PROVIDERS.map((provider) => [provider.id, provider])),
      latest: store.latestSnapshots(),
      usage: store.getUsageSince(0),
      ledger: [],
      sync: {},
      settings: store.getSettings(),
      days: 30,
    })
    expect(overviewMapped.planTotals.allTokens).toBe(15)
    expect(overviewMapped.accounts[0].planStats?.todayTokens).toBe(15)
    expect(overviewMapped.accounts[0].planStats?.lastModel).toBe('unknown-private-model')
  })
})

describe('套餐走势图按模型拆分', () => {
  const DAY = 86_400_000

  function planRecord(model: string, ts: number, tokens: number): UsageRecord {
    return {
      id: crypto.randomUUID(),
      accountId: 'acc-1',
      providerId: 'minimax-plan',
      ts,
      model,
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsdMicros: 0,
      costEstimated: false,
      source: 'local-log',
      externalId: `${model}-${ts}-${tokens}`,
      billingMode: 'plan',
    }
  }

  function overviewOf(usage: UsageRecord[]) {
    return buildOverview({
      accounts: [],
      providers: new Map(),
      latest: new Map(),
      usage,
      ledger: [],
      sync: {},
      settings: { displayCurrency: 'CNY', fxUsdCny: 7.2 } as Settings,
      days: 30,
      now: Date.now(),
    })
  }

  it('按模型拆成多条线，日期轴与总走势一致', () => {
    const today = Date.now()
    const overview = overviewOf([
      planRecord('glm-5.3', today - 1000, 300),
      planRecord('glm-5.3', today - DAY, 100),
      planRecord('dfmodel', today - 2000, 500),
    ])
    expect(overview.planTrendByModel.map((group) => group.model)).toEqual(['dfmodel', 'glm-5.3'])
    const glm = overview.planTrendByModel.find((group) => group.model === 'glm-5.3')!
    expect(glm.points).toHaveLength(overview.planTrend.length)
    expect(glm.points[glm.points.length - 1].tokens).toBe(300)
    expect(glm.points[glm.points.length - 2].tokens).toBe(100)
    const dfmodel = overview.planTrendByModel.find((group) => group.model === 'dfmodel')!
    expect(dfmodel.points[dfmodel.points.length - 1].tokens).toBe(500)
    expect(overview.planTrend[overview.planTrend.length - 1].tokens).toBe(800)
  })

  it('模型过多时保留前 4 个，其余合并成「其他 N 个模型」', () => {
    const today = Date.now()
    const usage = Array.from({ length: 8 }, (_, index) => planRecord(`m${index}`, today - index * 1000, (index + 1) * 100))
    const overview = overviewOf(usage)
    expect(overview.planTrendByModel).toHaveLength(5)
    const others = overview.planTrendByModel[overview.planTrendByModel.length - 1]
    expect(others.model).toBe('其他 4 个模型')
    expect(others.points.reduce((sum, point) => sum + point.tokens, 0)).toBe(1000)
  })
})

describe('金额口径：钱只认实际计费', () => {
  function apiRecord(costUsdMicros: number, estimated: boolean): UsageRecord {
    return {
      id: crypto.randomUUID(),
      accountId: 'acc-api',
      providerId: 'deepseek',
      ts: Date.now() - 60_000,
      model: estimated ? 'deepseek-chat' : 'deepseek-reasoner',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsdMicros,
      costEstimated: estimated,
      source: estimated ? 'local-log' : 'csv',
      externalId: `api-${estimated ? 'est' : 'actual'}`,
      billingMode: 'api',
    }
  }

  it('估算金额进 costUsd 但不进 actualUsd', () => {
    const overview = buildOverview({
      accounts: [],
      providers: new Map(),
      latest: new Map(),
      usage: [apiRecord(300_000, true), apiRecord(700_000, false)],
      ledger: [],
      sync: {},
      settings: { displayCurrency: 'CNY', fxUsdCny: 7.2 } as Settings,
      days: 30,
    })
    expect(overview.totals.todayUsd).toBeCloseTo(1, 6)
    expect(overview.totals.todayActualUsd).toBeCloseTo(0.7, 6)
    expect(overview.totals.monthActualUsd).toBeCloseTo(0.7, 6)
    expect(overview.byAccount[0].costUsd).toBeCloseTo(1, 6)
    expect(overview.byAccount[0].actualUsd).toBeCloseTo(0.7, 6)
    expect(overview.trend[overview.trend.length - 1].actualUsd).toBeCloseTo(0.7, 6)
    // 全估算时实际计费为 0，界面据此显示「—」而不是估出来的钱。
    const onlyEstimated = buildOverview({
      accounts: [],
      providers: new Map(),
      latest: new Map(),
      usage: [apiRecord(300_000, true)],
      ledger: [],
      sync: {},
      settings: { displayCurrency: 'CNY', fxUsdCny: 7.2 } as Settings,
      days: 30,
    })
    expect(onlyEstimated.totals.todayActualUsd).toBe(0)
    expect(onlyEstimated.byModel[0].actualUsd).toBe(0)
  })
})

describe('区间筛选与统一走势', () => {
  const DAY = 86_400_000

  function record(model: string, ts: number, tokens: number, billingMode: 'api' | 'plan'): UsageRecord {
    return {
      id: crypto.randomUUID(),
      accountId: 'acc-1',
      providerId: 'minimax-plan',
      ts,
      model,
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsdMicros: billingMode === 'api' ? 1_000_000 : 0,
      costEstimated: billingMode === 'api',
      source: 'local-log',
      externalId: `${model}-${ts}`,
      billingMode,
    }
  }

  function overviewIn(days: number, usage: UsageRecord[]) {
    return buildOverview({
      accounts: [],
      providers: new Map(),
      latest: new Map(),
      usage,
      ledger: [],
      sync: {},
      settings: { displayCurrency: 'CNY', fxUsdCny: 7.2 } as Settings,
      days,
      now: Date.now(),
    })
  }

  it('套餐走势跟着区间裁剪，累计口径仍是全历史', () => {
    const now = Date.now()
    const usage = [
      record('glm-4.6', now - 2 * DAY, 100, 'plan'),
      record('glm-4.6', now - 200 * DAY, 900, 'plan'),
    ]
    const week = overviewIn(7, usage)
    const year = overviewIn(365, usage)
    expect(week.planTrend).toHaveLength(7)
    expect(year.planTrend).toHaveLength(365)
    expect(week.planByModel[0].tokens).toBe(100)
    expect(year.planByModel[0].tokens).toBe(1000)
    expect(week.planTrendByModel[0].points).toHaveLength(7)
    // 累计不受区间影响，卡片上的「累计」仍是全历史。
    expect(week.planTotals.allTokens).toBe(1000)
    expect(week.planTotals.rangeTokens).toBe(100)
  })

  it('按量走势也按模型拆线，超过 4 个模型合并成「其他」', () => {
    const now = Date.now()
    const usage = Array.from({ length: 8 }, (_, index) => record(`api-m${index}`, now - index * 1000, (index + 1) * 10, 'api'))
    const overview = overviewIn(30, usage)
    expect(overview.apiTrendByModel).toHaveLength(5)
    expect(overview.apiTrendByModel[4].model).toBe('其他 4 个模型')
    expect(overview.apiTrendByModel[0].model).toBe('api-m7')
    expect(overview.apiTrendByModel[0].points).toHaveLength(30)
    // 按量侧的模型行和套餐侧同形状，两个 Tab 才能共用一个组件。
    expect(overview.byModel[0]).toMatchObject({ tokens: 80, calls: 1, cacheRead: 0 })
    expect(overview.byModel[0].costUsd).toBe(1)
    expect(overview.byModel[0].actualUsd).toBe(0)
  })

  it('今日小时走势按模型拆分，超过 4 个模型合并成「其他」', () => {
    const now = Date.now()
    const morning = new Date(now)
    morning.setHours(9, 30, 0, 0)
    const ts = morning.getTime()
    const usage = [
      record('api-a', ts, 100, 'api'),
      record('api-b', ts, 50, 'api'),
      ...Array.from({ length: 4 }, (_, index) => record(`api-c${index}`, ts, 10, 'api')),
    ]
    const overview = overviewIn(1, usage)
    expect(overview.today.api).toHaveLength(5)
    expect(overview.today.api[0].model).toBe('api-a')
    expect(overview.today.api[4].model).toBe('其他 2 个模型')
    const bucket = (model: string) => overview.today.api.find((group) => group.model === model)!.points[morning.getHours()]
    expect(bucket('api-a')).toBe(100)
    expect(bucket('api-b')).toBe(50)
    // 排在 Top 4 之后的两个模型合并到「其他」。
    expect(bucket('其他 2 个模型')).toBe(20)
    // 一天 24 个小时桶。
    expect(overview.today.api[0].points).toHaveLength(24)
    expect(overview.today.plan).toEqual([])
  })

  it('卡片指标按所选区间统计，累计仍是全历史', () => {
    const now = Date.now()
    const usage = [
      record('deepseek-chat', now - 60_000, 1000, 'api'),
      record('deepseek-chat', now - 200 * DAY, 9000, 'api'),
    ]
    const accounts = [account('acc-1', 'deepseek', 'DeepSeek')]
    const providers = new Map(PROVIDERS.map((provider) => [provider.id, provider]))
    const month = buildOverview({
      accounts,
      providers,
      latest: new Map(),
      usage,
      ledger: [],
      sync: {},
      settings: { displayCurrency: 'CNY', fxUsdCny: 7.2 } as Settings,
      days: 30,
      now,
    })
    const stats = month.accounts[0].apiStats!
    expect(stats.rangeTokens).toBe(1000)
    expect(stats.rangeCalls).toBe(1)
    expect(stats.rangeInput).toBe(1000)
    expect(stats.todayTokens).toBe(1000)
    // 区间外的记录只进累计，不进卡片上的输入/输出/次数。
    expect(stats.allTokens).toBe(10000)
    const today = buildOverview({
      accounts,
      providers,
      latest: new Map(),
      usage,
      ledger: [],
      sync: {},
      settings: { displayCurrency: 'CNY', fxUsdCny: 7.2 } as Settings,
      days: 1,
      now,
    })
    expect(today.accounts[0].apiStats?.rangeCalls).toBe(1)
    const todayTotal = today.today.api.reduce(
      (sum, group) => sum + group.points.reduce((inner, value) => inner + value, 0),
      0,
    )
    expect(todayTotal).toBe(1000)
    expect(today.today.api.map((group) => group.model)).toEqual(['deepseek-chat'])
    expect(today.today.plan.every((group) => group.points.every((value) => value === 0))).toBe(true)
  })
})
