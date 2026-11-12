# TokenPanel

AI Token 用量、余额 / 套餐额度、AI 动态与模型排行看板。形态是 **uTools 插件 + 浏览器本地服务**，预制主流厂商配置，数据只存本机。

![总览 · 按量](docs/overview-light.png)

![总览 · 订阅套餐](docs/plan-cards.png)

![AI 动态](docs/news.png)

![模型排行](docs/rankings.png)

## 下载

- [GitHub Releases](https://github.com/11xbtd/tokenpanel/releases)：Windows 便携版（自带 Node 运行时，约 34 MB）；已有 Node.js 22+ 可选轻量包（约 1 MB）
- uTools 用户：在 uTools 插件应用市场搜索 **TokenPanel** 安装
- macOS / Linux 或开发调试：按下方「快速开始」从源码运行

## 它做什么

- **两种额度卡片**：总览分「按量 API / 订阅套餐」两个 Tab，两类卡片共用同一套排版（品牌图标 + 状态 → 主数字 + 近 7 天 token 走势 → 今日/本月/累计副行 → 窗口进度条 → 输入/输出/缓存命中/速度 → 上轮模型与首字），窗口行按周期从短到长固定排序，不再跟着厂商返回顺序跑。主数字位放**余额**（按量）或**最紧窗口剩余%**（套餐），其余槽位一律 token；指标行上方标出当前区间与该区间的调用次数，区间外没有调用的账户显示 `—` 而不是 0。
- **额度时间轴**：在总览集中展示已启用账户的窗口重置时间，支持未来 24 小时 / 7 天 / 全部范围；可展开窗口查看详情并直接刷新账户。到期窗口标注「待刷新」，未提供时间的窗口单独注明。仅在同一重置周期内有至少 3 次有效快照、跨度至少 10 分钟且余量下降至少 2 个百分点时，按近期节奏预估耗尽时间；过期、失败、旧数据或余量反弹后的样本不足时不预测。重置与「预估提前耗尽」使用不同标记，预测不改变实际余量或告警配置。
- **钱只在两处出现**：卡片主数字位的**余额**，和明细里的**厂商实际计费**。消耗类数字一律按 token 展示；按 LiteLLM 价目估出来的金额继续入库但不在界面显示（明细里是 `—`，悬停说明原因），「预计可用天数」也只按实际计费的花费推算，全估算时不猜还能撑多久。订阅套餐（GLM Coding Plan、MiniMax Token / Coding Plan、Claude、ChatGPT/Codex 等）的 token 明细从本机客户端日志补，套餐金额不外推，绝不混进按量汇总。
- **消耗监控**：按天、按账户、按模型拆解 token，支持缓存命中率、调用明细与 CSV 导出。**两个 Tab 的「token 走势」「模型排行」「本机日志源」是同一套组件**，只是数据分别取按量侧和套餐侧。Tab 与「统计范围」（**今日** / 近一周 / 近一月 / 近一年）合成一条**吸顶工具条**，滚动时不消失，改动同时作用于卡片与走势；选「今日」时走势自动改画当天 24 小时柱状。走势按模型堆叠（前 4 个各一条，其余合并成「其他 N 个模型」），点图例可隐藏单层。
- **AI 动态**：分「官方动态 / 相关报道」两个流，关注 OpenAI、Anthropic、Google、DeepSeek、Kimi、MiniMax 等厂商和 Codex、Claude Code、Kimi Code、OpenCode 等工具；支持新模型 / 价格额度 / 客户端更新 / 周边动态分类、未读筛选、关键词搜索、时间范围和预览版开关。关注对象会按已添加账户与已启用日志源自动推荐，官方动态据此筛选，相关报道则汇集中文科技媒体里与 AI 相关的全部报道，可以点「看全文」在工具内读正文；只读官方域名与中文科技媒体，缓存和已读状态存本机。
- **模型排行**：接 Artificial Analysis 免费数据接口，集中比较智能指数、输出速度、首答等待、输入/输出价格与任务成本；支持按指标排序、厂商 / 已关注筛选、隐藏缺测和中文别名搜索。默认共享 Key 免配置，也可以填自己的 AA Key（AES-256-GCM 加密，只存本机）；榜单缓存 6 小时，失败保留上次成功数据。
- **预制配置**：添加账户时自动填好 base_url、鉴权字段、接口路径与文档链接，并带各厂商官方标识（`@lobehub/icons-static-svg`，MIT，构建期内联成 data URI，离线可用；没有可靠来源的厂商回退首字母）；没有公开接口的厂商可手动录入余额/套餐，或导入 CSV。
- **本地优先**：账户密钥与 AA Key 都使用 AES-256-GCM 加密，只存本机；无遥测；接口失败保留上次成功数据。

### 明确不做

- **不做代理/网关**：没有“把 base_url 指过来就自动记每次调用”的透传代理。uTools 插件没有后台常驻进程，做不了透明代理。
- **不做云厂商 AK/SK 签名**：阿里云、火山、百度、腾讯的云账户余额需要各自签名算法，一期只提供手动录入 / 账单导入。
- **不做透明代理**：没有“把 base_url 指过来就自动记每次调用”的透传代理。uTools 插件没有后台常驻进程，做不了透明代理；需要请求级 TTFT 的客户端只能后续在浏览器版加代理。
- **不做全量客户端适配**：本机日志已适配 11 类主流客户端（见下），Cursor/Copilot 等只做“发现但未适配”提示；不是所有 49 种客户端日志都能一次覆盖。
- **不做多租户**：单人本地工具；浏览器版跨设备访问只有 HTTP Basic 一层保护。

## 快速开始

### 浏览器版（推荐先用这个）

```bash
npm install
npm run start
```

`start.cmd` 可以双击完成同样的事：首次自动安装依赖与构建，然后打开 `http://127.0.0.1:5188`。数据写在系统固定目录（Windows：`%APPDATA%\TokenPanel`），不在项目文件夹里，所以换机器、移动项目或重装都不会丢。启动成功会打印：

```
TokenPanel 1.1.3 已启动：http://127.0.0.1:5188
数据目录：C:\Users\<你>\AppData\Roaming\TokenPanel
```

其他命令：

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式：API `:5188` + Vite `:5173`（带 `/api` 代理） |
| `npm run demo` | 演示模式：生成 `./.demo-data`，端口 `:5189`，使用模拟接口 |
| `npm run serve` | 以已构建产物启动（不自动构建） |
| `npm run build:brands` | 从 `@lobehub/icons-static-svg` 重新生成厂商图标模块 `src/renderer/lib/brands.ts`（新增预设后需要跑一次并在 `scripts/build-brands.mjs` 的映射表里补一行） |

### uTools 插件

在 uTools 插件应用市场搜索 **TokenPanel** 安装。

本地开发/调试：

1. `npm install && npm run build`，产物在 `dist/utools/`。
2. 打开 uTools → **开发者工具** → **新建项目** → 选择 `dist/utools/plugin.json` → **接入开发**。
3. 在 uTools 搜索框输入 `token`、`tokenpanel`、`AI余额`、`AI动态` 或 `模型排行` 打开。

插件默认单实例、窗口高度 760；宽度与是否可调由 uTools 控制。本地构建产物仅供开发调试，对外分发统一走 uTools 插件应用市场。

> **为什么产物目录里有个 `package.json`**：uTools 的 preload.js 必须是 CommonJS。产物目录如果自己没有 `package.json`，Node 会向上找到项目根的 `"type": "module"`，把 preload.js 当 ESM 加载，报 `require is not defined`——桥接注入失败，插件页会退回去请求 `/api/*`，在 `file://` 下必然全部 404。构建脚本会写入 `dist/utools/package.json`（`{"type":"commonjs"}`）并在打包后实际 `require` 一次做断言。改完 `preload.js` 需要重启 uTools 进程才生效。

## 预制厂商与接口台账

### 按量余额（官方接口）

| 厂商 | 凭证 | 接口 | 说明 |
|---|---|---|---|
| DeepSeek | API Key | `GET /user/balance` | CNY/USD，返回赠送与充值余额 |
| Kimi（国内 / 国际） | API Key | `GET /v1/users/me/balance` | 国内 CNY、国际 USD |
| 阶跃星辰 StepFun | API Key | `GET /v1/accounts` | 余额 + 现金/代金券 |
| 302.AI | API Key | `GET /dashboard/balance` | Key 需开启「余额查询」权限 |
| AIHubMix | System Access Token | `GET /api/user/self` | 必须 `fd` 开头 Manage Key；`quota/500000=USD` |
| Novita AI | API Key | `GET /openapi/v1/billing/balance/detail` | 返回值单位 1/10000 美元，已换算 |
| OpenRouter | Management Key / 普通 Key | `GET /api/v1/credits` 或 `/api/v1/key` | 管理 Key 求 credits−usage；普通 Key 显示 Key 限额窗口 |
| xAI | Management Key + Team ID | Management API prepaid balance | 返回值为美分，已换算 |

### 官方用量

| 厂商 | 凭证 | 接口 | 说明 |
|---|---|---|---|
| OpenAI | **Admin Key** | `/v1/organization/usage/completions` + `/v1/organization/costs` | UTC 天桶；按日账单分摊到模型；最长回补 30 天 |
| Anthropic | **Admin Key**（`sk-ant-admin01-`） | `/v1/organizations/usage_report/messages` + `/cost_report` | 费用报告是**美分**，已换算；按日分摊 |

### 订阅套餐（实验性，非官方接口）

| 产品 | 凭证 | 接口 | 说明 |
|---|---|---|---|
| 智谱 GLM Coding Plan（国内） | API Key | `/api/monitor/usage/quota/limit` | `Authorization` 直接放 Key（不加 Bearer）；5 小时 / 周窗口 |
| Z.AI Coding Plan（国际） | API Key | `/api/monitor/usage/quota/limit` | 同上 |
| MiniMax Token / Coding Plan | 订阅 Key | `/v1/token_plan/remains` | 按次或按百分比；Coding Plan 返回 5 小时/周剩余百分比；字段随版本变化；国际站改 base_url 为 `api.minimax.io` |
| Claude Pro / Max | OAuth Access Token | `api.anthropic.com/api/oauth/usage` | 5 小时 / 7 天窗口；可能被 Cloudflare / 429 拦截 |
| ChatGPT / Codex | OAuth Token + Account ID | `chatgpt.com/backend-api/wham/usage` | 主/次窗口；最易失效 |
| Kimi Code Plan | Kimi Code API Key（优先）/ CLI Token（可选） | `api.kimi.com/coding/v1/usages` | API Key 直接可查；只展示剩余百分比（接口 limit/remaining 不是请求次数）；CLI Token 约 15 分钟过期，且需 `X-Msh-*` 设备头 |
| OpenCode Go | Console API Key | `opencode.ai/zen/go/v1/usage` | Go / Go Plus / Go Teams 订阅；额度按模型月度金额折成 5 小时（20%）、每周（50%）、每月（100%）三个窗口；接口未公开，字段变化时需重解析 |

套餐接口失败时会保留上一次成功数据，并在卡片上显示错误；不会因为一家失败让整页空白。

> 注意：Kimi Code 的订阅 Key 与 Kimi 开放平台 API Key 不是同一种凭证。后者只能查按量余额（用上面的 Kimi 国内/国际预设），查不到订阅套餐窗口。

### 订阅套餐的 token 明细（本机日志）

厂商的套餐接口只给剩余百分比，不给 token 明细。看板从客户端本地日志补齐，日志按「客户端」而不是「套餐厂商」存放：

**周额度反推**：额度接口只给百分比时，卡片窗口行和「额度时间轴」详情会按**相邻快照之间的增量**估算周额度：本机在这段时间记录了多少 token、额度百分比同时涨了几个点，折算成 100% 就是该区间的结果；取观测到的最大值作为下限（卡片显示为「周额度 ≥ …」）。额度是所有设备共用的，别的电脑或未接入日志的客户端用掉的额度不会计入本机增量，因此真实周额度只会更高；某个区间额度上涨但本机没有记录时，界面会提示「有外部用量」。刚接入或只有一次快照时只能用周期起点到快照的累计值，估计会更粗。

| 客户端 | token/缓存 | 速度 | 首字耗时 | 路径（Windows） |
|---|---|---|---|---|
| Kimi Code | 有 | 有（流式时长） | **有** | `%USERPROFILE%\.kimi-code\sessions\**\wire.jsonl` |
| Kimi CLI（旧版） | 有 | 无 | 无 | `%USERPROFILE%\.kimi\sessions\**\wire.jsonl` |
| Claude Code | 有 | 按相邻消息间隔估算（含等待） | 无 | `%USERPROFILE%\.claude\projects\**\*.jsonl` |
| Codex CLI / Desktop | 有 | 逐请求：单次调用的回合用整轮耗时；多次调用按「调用间隔 − 工具执行时长」估速，界面标「估速」 | 有（整轮首字，落在该轮第一条调用） | `%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl` |
| Gemini CLI | 有 | 无 | 无 | `%USERPROFILE%\.gemini\tmp\*\chats\*.json` |
| Qwen Code | 有 | 无 | 无 | `%USERPROFILE%\.qwen\projects\**\*.jsonl` |
| Cline / Roo / Kilo | 有 | 无 | 无 | `%APPDATA%\Code\User\globalStorage\<扩展ID>\tasks\*\ui_messages.json` |
| OpenCode | 有 | 有（created→completed） | 未确认 | `%USERPROFILE%\.local\share\opencode\opencode.db`（SQLite，新版）或 `storage\message\**`（旧版） |
| Qoder | 有（`local.db` 的 `token_info`） | 无 | 无 | `%USERPROFILE%\.qoder\shared_client\cache\db\local.db`（SQLite，缓存最近消息） |
| ZCode | 有 | 有（回合耗时） | **有**（`time_to_first_token_ms`） | `%USERPROFILE%\.zcode\cli\db\db.sqlite`（SQLite） |
| DeepSeek Harness | 有 | 有（首包→message 的流式时长） | **有**（`step/start`→首个 `assistant/chunk`） | `%USERPROFILE%\.dsh\sessions\**\session.jsonl.zstd`（zstd 帧；内置 WASM 解码，Node 20 / 22+ 都可用） |

- **首次只登记，不自动读取**：日志源被发现后默认停用，在「设置 → 本机日志源」或套餐 Tab 点「启用」后才开始增量扫描。
- **归属可以配多条**：一个日志源能绑多个套餐账户，每条规则 = 账户 + 可选模型正则。解析顺序：带模型正则的绑定 → 日志自带的厂商线索（ZCode 的 `provider_id`，比模型名硬）→ 模型名自动规则（`kimi`、`glm`、`minimax`、`deepseek` 这类名字自带厂商的）→ 不带正则的默认绑定。
- **日志也能记按量调用**：名字自带厂商的模型会自动认到对应账户——`deepseek-*`/`qwen-*`/`gemini-*`/`grok-*`/`step-*` 等归到对应的**按量**账户（前提是你建了那个账户），归到按量账户的记录按 LiteLLM 价目表估算金额并进「按量 API」页。同一模型既可能是订阅调用也可能是按量 key 调用，候选账户按「先套餐后按量」取第一个已存在的；两种都用时用正则绑定写死即可。
- **厂商账单 CSV 也能直接导**：厂商导出的账单通常没有 `account` 列、表头是中文（`日期/模型/输入tokens(缓存命中)/总消耗(元)`）。导入时在「设置 → 导入」选一个「全部记到某账户」，费用列带「元」按人民币折算；缓存命中与未命中会分别识别，不会混在一起。
- **匹配不上归属就不入库**：归属链全都落空的调用**不写入用量记录**，宁可不统计，也不把别家的调用算进某个套餐。规则命中了但对应套餐账户不存在（模型名明确是别家的）同样不入库，不会落到默认绑定上。扫描结果里会如实报「N 条没匹配上归属（未入库）」，日志源卡片上也显示这个条数。
- **Qoder 的 dfmodel/qfmodel 不猜厂商**：那是 Qoder 客户端内部的模型 key，同一个 key 也可能指你自配的 MiniMax，所以不写死规则；写一条模型匹配（如 `dfmodel|qfmodel`）就能固定归到某个套餐。
- **多绑定是逐条分流，不是拆总量**：一次调用只归到一个账户，不会分摊。绑定数组的顺序就是优先级（= 添加顺序，UI 暂不支持拖动排序），想改顺序得删了重加，或让各条正则互不重叠。
- **规则变了要重建**：绑定或归属规则改动后，历史记录不会自动改归属。点「重建」（总览「本机日志源」或设置页）会删掉已导入的本机日志记录并按当前规则全量重扫。
- **改归属必重扫**：任何一条绑定规则变化（含自动补绑）都会清空该来源已导入的记录与文件缓存再重扫，避免同一调用既算未归属又算进账户。
- **模型规则只认名字里带厂商的模型**：`kimi-*`、`GLM-*`、`MiniMax-*`、`claude-*`、`gpt-*` 这类按名字自动归。Qoder 的 `dfmodel`/`qfmodel` 是客户端内部 key、不带厂商信息（同一个 key 也可能是你自配的 MiniMax），所以不猜厂商，交给日志源里的「模型匹配」绑定自己写。
- **日志自带厂商线索时优先用线索**：ZCode 的 `model_usage.provider_id` 直接写着套餐来源（`builtin:bigmodel-start-plan` = 智谱 GLM 编程套餐、`builtin:bigmodel` = 按量 BigModel），比模型名更可靠，模型名被改过也能认出来。
- **模型规则要有账户才生效**：自动规则命中但没有对应套餐账户时，调用会落到日志源的默认绑定上；「套餐模型 Top」里会挂一个「规则指向 X」徽标提醒你补账户。
- Kimi Code 的 `step.end` 直接带 `llmFirstTokenLatencyMs` / `llmStreamDurationMs`；ZCode 的 SQLite 直接带 `time_to_first_token_ms`；DeepSeek Harness 没有现成字段，用 `step/start`→首个 `assistant/chunk` 算首字、首包→`assistant/message` 的流式时长算 tok/s（工具调用发生在 message 之后，所以不用 `step/end`，否则会把等工具的时间算进速度）。其余客户端没有首字字段时显示 `—`，不用总耗时冒充。
- **计时补齐与归属重建**：Codex 计时解析升级后，下一次扫描会自动重读并补齐旧记录缺失的速度/首字字段，不删除记录，不重复统计 token 或费用；回合完成事件后追加到文件时也会增量补齐。**估算值可以被后来的精确值覆盖（只升不降）**，精确值不会被降级回估算。更改归属规则或 token 解析算法仍需「重建」，让历史记录按新规则重新归属。
- **Codex 没有逐请求的官方耗时**：实测 6 份真实 rollout、248 次调用，官方 item 时长在 218 个样本上折算会出现 534/1381 tok/s 这类物理不可能值；直接用墙钟又会把工具等待算进去。所以取「距上一次调用的间隔 − 区间内工具执行时长」，窗口不足 200ms 或折算速度超过 500 tok/s 的直接不给值；一轮只有一次调用的回合用 `duration_ms` 的精确值。明细里估速带「估速」前缀，卡片速度指标带 `speedEstimated` 标记。
- **Qoder 的会话日志里 token 是 0**：JSONL 只保留 credits；真实 token 在 `local.db` 的 `chat_message.token_info` 里，只覆盖本地缓存的最近消息。自定义模型按 `model_info.model_key` 识别。
- **Qoder / ZCode 需要 Node 22+**（`node:sqlite`）：浏览器版可用；uTools 插件内置 Node 20 时读不了 SQLite，需要换浏览器版。读库时会先复制快照，避免和正在运行的客户端抢锁。
- **OpenCode 分两条线**：OpenCode Go 是订阅（Go / Go Plus / Go Teams），有额度接口，看板直接读 5 小时 / 每周 / 每月三个窗口；OpenCode Console 是按量付费的模型网关，余额查询要网页登录态（插件读不到浏览器 Cookie），只能手动登记余额。
- OpenCode 的本机日志（`opencode.db`）照常导入 token 明细，日志里的 `provider_id` 是 `opencode-go` / `opencode` 时会自动归到对应的 OpenCode 账户。
- 只读日志，只保存模型/时间/token/缓存/耗时，不保存 prompt 或回复；只覆盖经过本机客户端的调用，网页、手机和其他设备不在内。
- OpenCode 新版（v1.2.0 起）已迁移到 SQLite，适配器两代都读；Codex 的 `.zst` 会话暂未适配。

### 中转站

| 类型 | 凭证 | 接口 | 说明 |
|---|---|---|---|
| New API / One API | 用户 Access Token（可选用户 ID） | `/api/user/self` + `/api/log/self` | 余额与调用日志；quota 默认 50 万 = 1 美元；只聚合 token/model，不保存消息内容 |

### 手动录入 / CSV

Gemini、Groq、智谱按量、MiniMax 按量、阿里云百炼、火山方舟、百度千帆、腾讯混元、商汤、Together、Fireworks、Mistral：没有公开余额接口，或需要云账号 AK/SK / 企业权限。

OpenCode Console（按量余额）：按量付费的模型网关，余额要在网页控制台看（接口需要登录 Cookie），插件里只能手动登记。

### 自定义 HTTP

任意 JSON 接口：填 URL、请求头（支持 `{{apiKey}}` 占位）、余额点路径、币种路径；可选用数组路径映射套餐窗口（名称/已用/总量/重置时间）。

## 数据从哪来，什么时候刷新

- **余额/套餐**：刷新时直接查厂商接口；手动账户按「手动余额 + 记账」实时计算。
- **消耗**：官方 Admin 用量接口、中转站调用日志、本机客户端日志、CSV 导入、手动记账。DeepSeek/Kimi 等只有余额接口的厂商，按量消耗要靠 CSV/手动；订阅套餐的 token 明细来自本机客户端日志。
- **告警不落库，只做即时提醒**：告警不写任何文件。每次打开面板（或刷新时）按当前状态现算——余额低于阈值、套餐窗口剩余不足、刷新失败、日消耗超限——有就弹一条提示，点 ✕ 手动关掉即可；下次再进来条件仍成立会重新提示。面板里不留告警历史。
- **额度状态颜色**：「设置 → 额度颜色」可配置橙色和红色的剩余百分比，默认 ≤50% 为橙色「偏低」、≤20% 为红色「将耗尽」，红色优先，其余使用厂商色；主数字、窗口文字、进度条、图例与总览摘要使用同一规则。通知触发阈值在「告警」中单独设置。旧配置自动补齐 50% / 20% 默认值。
- **刷新时机**：打开面板自动刷新一次；之后按「自动刷新周期」（默认 10 分钟）判断是否跳过；手动刷新总是执行；单账户可单独刷新。启用的本机日志源会在刷新时一起增量扫描；**uTools 没有后台常驻，不开面板就没有告警。**
- **增量策略**：用量首次回补 14 天（最多 30 天），之后每次回补最近 2 天并去重；官方日账单的迟到更正在一期不回写（README 明确说明，避免误以为实时）。
- **失败语义**：每个账户、每种能力（余额/套餐/用量）独立超时与独立失败；错误快照同步落库，卡片保留上次成功值并显示错误与时间。

## AI 动态与模型排行

### AI 动态

- **来源限定**：只抓取目录里列出的官方域名、GitHub Releases 与中文科技媒体，不接受任意 URL；所有请求由本地服务或 uTools preload 发起，读不到登录态。
- **关注推荐**：首次进入会按已添加账户和已启用日志源推荐关注对象；也可以手动管理关注列表。「官方动态 / 相关报道」两个流分开缓存：官方动态按关注对象筛选，相关报道不按关注过滤，只按是否与 AI 相关取舍。
- **刷新与失败**：打开页面时按来源增量刷新；普通源缓存 1 小时，价格/规则监控页 6 小时。单个来源失败只影响该来源，页面保留上次条目并显示错误；不保存正文之外的账号数据。
- **本地文件**：`news-preferences.json`（关注与已读）、`news-cache.json`（条目、来源状态与价格页基线）；不落对话内容。

### 模型排行

- **数据源**：Artificial Analysis 免费模型接口，指标包括智能指数、输出速度、首答等待、输入/输出价格与每任务成本；页面标注来源与评测方法链接。
- **排序与筛选**：按能力、速度或成本排序，可切换全部指标；支持厂商筛选、只看已关注、隐藏缺测和中文别名搜索。
- **Key 与缓存**：默认使用构建时注入的共享 AA Key；也可以在页面填自己的 AA Key，个人 Key 优先，使用 AES-256-GCM 加密保存在 `aa-settings.json`。请求只发往 `artificialanalysis.ai`，榜单缓存 6 小时，失败保留上次成功快照。
- **口径**：智能指数与速度是 AA 的第三方评测/API 基准，不是本机客户端的实测速度；本机 Codex / Kimi Code 的 tok/s 仍在消耗分析里单独统计。

### 构建期共享 Key

源码仓库不包含真实 AA Key。构建时通过 `TOKENPANEL_AA_SHARED_API_KEY` 或 `TOKENPANEL_AA_KEY_DIR`（默认 `.dev/aa-owner-data`，已在 `.gitignore` 中）读取，只注入 Node 服务与 uTools preload，不进入浏览器渲染层。公开构建产物中的共享 Key 按设计可被提取，只用于降低上手门槛；对 Key 隔离有要求时请配置个人 Key。

## 金额与 token 口径

- **界面上钱只有两处**：余额（厂商接口或手动记账），和「实际计费」列（官方账单 / 中转日志 / CSV 导入）。所有消耗数字一律按 token 展示。
- **卡片上的输入/输出/缓存命中/速度/首字跟着所选区间**（今日 / 近一周 / 近一月 / 近一年），不是全历史累计；今日/本月/累计 token 三个日历窗口在副行里单独给。区间内没有调用就显示 `—`，不拿 0 冒充。
- **总输入包含缓存**：卡片和分析页的「总输入」= 非缓存输入 + 缓存读取 + 缓存写入，旁边的「总量」= 总输入 + 输出。缓存量是总输入的一部分，不再额外相加；明细页仍将非缓存输入、缓存读、缓存写分列。正常额度条跟随厂商色，偏低标橙，将耗尽标红。
- **估算金额入库但不展示**：按价目估出来的钱继续写进记录（`costEstimated=true`），明细里显示 `—` 并在悬停时说明原因；「本月实际计费」「预计可用天数」「日消耗告警」都只按实际计费部分算，全估算时宁可显示空也不给一个猜出来的钱。
- 内部统一用**美元微单位**（1e-6 USD）记账，展示层按设置折算 CNY/USD。
- **实际费用的来路**：OpenAI/Anthropic 的官方日费用报告按当天估算占比分摊到模型；中转站按日志 quota 计费；CSV 账单按导入行了账。
- **估算费用的来路**：其余按 LiteLLM 价目表（内置 3207 个模型，构建时生成）计算；支持按「每 1M tokens」手写覆盖，币种可选 CNY/USD，只影响保存之后的新记录。
- **缓存价**：价目表缺缓存读价时按输入价 10%，缺缓存写价时按输入价 125%；reasoning token 视为已包含在 output 中，避免重复计费。
- **未匹配价目**：估算金额按 0 计并打上标记，明细悬停会写「未匹配到价目表」，不会悄悄按 0 当成实际费用。
- **汇率**：默认 7.2，自动模式每 12 小时从 Frankfurter 拉取；失败保留旧值，可手动更新。
- **套餐不折算金额**：套餐 Tab 只显示剩余/已用百分比、token、缓存、速度和首字，不把套餐 token 乘价目表变成「费用」；额度百分比与 token 用量也不相加。
- 每条记录保留写入时的价格、币种与原始费用；调价不回溯历史。导出 CSV 仍带完整金额列，界面不显示不等于数据丢了。

## 数据与配置台账

### 数据目录

| 形态 | 位置 |
|---|---|
| 浏览器版 | `%APPDATA%\TokenPanel`（Windows）/ `~/.tokenpanel`（其他系统） |
| uTools 插件 | **同一目录**，所以两个入口看到的是同一批账户和历史 |
| 覆盖 | `TOKENPANEL_DATA_DIR` 环境变量可指定任意目录 |

旧版本把数据放在项目目录 `data/` 或 uTools 内部目录；新版本启动时若发现旧目录且新目录为空，会自动迁移过来并打印提示。

### 文件

| 文件 | 内容 |
|---|---|
| `config.json` | 账户配置、设置；账户凭证与 Webhook URL 为 AES-256-GCM 密文 |
| `usage.ndjson` | 用量明细（追加写，按来源+账户+externalId 去重） |
| `snapshots.ndjson` | 余额/套餐快照，用于余额走势与告警评估 |
| `ledger.ndjson` | 手动记账（充值/消费/调整） |
| `refresh-log.ndjson` | 刷新诊断日志（只记状态与脱敏错误） |
| `log-file-cache.json` | 本机日志的文件指纹与最后扫描时间，用于增量导入 |
| `news-preferences.json` | AI 动态的关注对象与已读 ID |
| `news-cache.json` | AI 动态条目、来源状态与价格页监控基线 |
| `aa-settings.json` | 个人 Artificial Analysis API Key（AES-256-GCM 密文） |
| `aa-rankings-cache.json` | 模型排行榜快照（最多 5000 个模型） |
| `aa-rankings-state.json` | 榜单同步时间、退避时间与脱敏错误状态 |
| `backups/config-*.json` | 每次保存账户/设置自动留一份配置快照，保留最近 10 份 |
| `prices-overrides.json` | 手写价目覆盖 |
| `state.json` | 最近刷新时间与每账户同步状态 |
| `secret.key` | AES 密钥；**丢失后已加密的凭证无法恢复** |
| `archive/` | 超过保留阈值的旧明细/快照归档（不删除） |

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TOKENPANEL_PORT` | `5188` | 监听端口 |
| `TOKENPANEL_HOST` | `127.0.0.1` | 非本机监听必须同时设置密码，否则拒绝启动 |
| `TOKENPANEL_PASSWORD` | 空 | HTTP Basic 认证密码 |
| `TOKENPANEL_DATA_DIR` | `%APPDATA%\TokenPanel` | 数据目录（浏览器版与 uTools 共用） |
| `TOKENPANEL_DEMO` | 空 | `1` 启用演示数据与模拟接口 |
| `TOKENPANEL_OPEN` | 空 | `1` 启动后自动打开浏览器 |
| `TOKENPANEL_AA_SHARED_API_KEY` | 空 | AA 共享 Key；构建时注入 Node 产物，也可在运行浏览器版时覆盖 |
| `TOKENPANEL_AA_KEY_DIR` | `.dev/aa-owner-data` | 私有构建配置目录，存放加密的 AA 共享 Key；不要提交 |

## 安全边界

- 账户密钥与 Webhook URL 使用 AES-256-GCM 加密落盘；界面只显示掩码尾号。个人 AA Key 使用同一机制加密保存在 `aa-settings.json`。
- 「不含密钥」备份会移除账户凭证、Webhook 地址与自定义请求头；「含密钥」备份是**明文**，导出后请立即移到安全位置。备份不包含 AA 个人 Key。
- 自定义 HTTP 的请求头请用 `{{apiKey}}` 占位；直接粘贴的密钥会以明文保存在 `config.json` 的 options 里。
- 局域网访问必须设置 `TOKENPANEL_PASSWORD`（HTTP Basic）。如果要暴露到公网，请放在带 TLS 的反向代理后面，不要直接映射端口。
- 加密只能防止「文件被随手拷走」，防不了本机恶意程序；不要把数据目录同步到公共网盘。
- 本机日志源默认停用；启用后只读日志，只落模型/时间/token/缓存/耗时，不落对话内容。日志中的模型名用于归属套餐，可能包含项目/会话元数据，但不会写入 `usage.ndjson`。
- 所有厂商、AI 动态与 AA 榜单请求都由本地服务或 uTools preload 发起，不经过任何第三方；没有遥测。AA 共享 Key 只注入 Node 产物，不进入渲染层；公开构建中的共享 Key 可被提取，需要隔离时请配置个人 Key。

## 导入 / 导出

- **用量 CSV**：`account,date,model,input,output,cache_read,cache_write,cost,currency`；不填 cost 时按价目表估算。
- **记账 CSV**：`account,date,kind,amount,currency,note`；kind 支持 `recharge/expense/adjust` 与中文「充值/消费/调整」。
- **备份**：`设置 → 备份与恢复`；恢复为增量合并，同 ID 跳过。
- `设置 → 导入` 里可以直接下载两种 CSV 模板。

## 开发与验证

```bash
npm run typecheck   # TypeScript 7
npm run test        # Vitest：172 项（17 个测试文件）
npm run build       # web + server + preload + uTools 产物
npm run pack:utools # zip
```

测试覆盖：价目匹配与阶梯价、人民币覆盖、CSV 解析与日期归日、密钥加密与掩码、并发写 state.json、用量去重、记账负调整、带密钥备份迁移、Webhook 加密与安全备份脱敏、日志源多账户绑定与旧单绑定折叠、厂商图标覆盖与 SVG 完整性、各厂商余额/套餐/用量解析、401/超时错误、单账户失败隔离、告警不落库（磁盘无告警文件、每次进入现算）、preload `window.services` 端到端；Kimi Code/Kimi CLI/Claude Code/Codex/Gemini/Qwen/Cline/OpenCode/Qoder/ZCode/DeepSeek Harness 日志解析（含 DSH 由 step 时间戳推首字与 tok/s）、增量缓存、未归属不入库与重绑后重扫补齐、模型归属规则、按量/套餐分离与按量 token 指标、窗口行按周期固定排序、估算金额只进 `costUsd` 不进 `actualUsd`、区间裁剪走势与按量按模型拆线、Codex 逐请求估速与「估算升级为精确值」的合并规则；AI 动态的来源域名/解析/去重/关注推荐/缓存与失败恢复、价格页监控基线、媒体流隔离；AA 榜单分页/压缩/大小限制/缓存原子发布/429 退避/Key 不进渲染层/错误快照保留。

目录：

```
src/core/       共享核心：类型、厂商注册表、适配器、存储、计价、聚合、告警
src/core/logs/  本机日志适配器、增量扫描、模型归属规则
src/core/news/  AI 动态来源目录、解析、监控、缓存与关注
src/core/rankings/ AA 榜单同步、分页、缓存、Key 管理与错误退避
src/node/       本地服务、uTools preload、演示数据
src/renderer/   React 界面（总览 / 消耗 / 明细 / AI 动态 / 模型排行 / 账户 / 设置）；lib/brands.ts 为生成的厂商图标数据
scripts/        价目快照、厂商图标、构建、打包、演示与启动
tests/          适配器、存储、导入、计价、日志、动态、榜单、集成、preload
dist/           web / server / utools 构建产物
docs/           README 截图
```

## 已知限制

1. 实验性套餐接口（GLM/Z.AI/MiniMax/Claude/ChatGPT/Kimi Code）来自社区逆向或未文档化行为，厂商改字段就会失败；已做降级与手动兜底，但无法保证长期可用。
2. 云厂商 AK/SK 余额、OpenAI 旧版 `credit_grants`、Gemini Code Assist 额度均未接入。
3. 没有透明代理，所以 token 明细只能来自本机客户端日志、官方用量接口或 CSV；网页/手机/其他设备不经过本机客户端的调用统计不到。DeepSeek/Kimi 这类只有余额接口的厂商，按量 token 仍靠 CSV/手动。
4. uTools 无后台进程：不开面板就不刷新；告警也只在打开面板时现算提示，没有推送通道时的后台提醒。
5. 价格快照随构建更新；未匹配模型费用为 0 并标记「无价」，需要手动加覆盖。
6. 浏览器版是单用户 + Basic Auth，没有会话管理、CSRF 防护、限流；仅建议本机或可信局域网使用。
7. 中转站日志单次最多拉 20 页 × 100 条（约 2000 条），首次同步取最近 14 天；超过上限时更早的记录不会自动补齐，重度中转站建议用 CSV 导入。
8. 首字仅从明确字段或可验证的首包时间获取；新版 Codex 的 `task_complete.time_to_first_token_ms` 可用，缺失时显示 `—`。Codex/Claude 的速度包含思考或工具等待，界面标注「估速」，不能当作纯解码速度。
9. 当前适配 11 类客户端；Cursor/Copilot 等只做目录发现并标「未适配」，Codex `.zst` 会话跳过；Qoder/ZCode 需要 Node 22+。DeepSeek Harness 使用内置 WASM zstd 解码，Node 20 也可读，首次全量扫描后会按文件末尾增量解析。
10. 更改日志源的归属规则（含自动补绑的默认账户）会清空该来源已导入记录并重新扫描；日志格式变更时适配器可能需要更新。
11. 套餐的月额度百分比仍然取决于厂商接口是否返回月池；本机日志能给「本月 token 用量」，不能凭空还原「月额度%」。
12. AI 动态只覆盖目录里列出的官方来源与中文科技媒体；厂商改版或反爬会解析失败，页面保留上次条目并标出来源错误，不会用旧内容冒充新数据。媒体报道的正文只在本机缓存，需要时按来源白名单回源抓取原文页面。
13. 模型排行依赖 Artificial Analysis 的免费接口和共享 Key 额度；共享额度用尽时需要配置个人 Key。榜单是第三方评测，不是本机模型实测；AA 改字段或收紧权限时可能暂时不可用，失败会保留上次快照。
14. AI 动态和模型排行都需要联网，且 uTools 没有后台常驻：不开面板不会在后台刷新或提醒。

## 参与贡献

开发环境、提交前检查与适配器约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全相关问题请按 [SECURITY.md](SECURITY.md) 私密报告，不要在公开 Issue 里贴真实 Key、Cookie 或未脱敏日志。

## 许可证与致谢

本项目 MIT。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE.md)。

- 价目数据来自 [LiteLLM](https://github.com/BerriAI/litellm) 的 `model_prices_and_context_window.json`（MIT）。
- 套餐接口字段与宽容解码策略参考 [codeburn](https://github.com/getagentseal/codeburn)（MIT）。
- 产品与余额适配思路参考 [new-api](https://github.com/QuantumNous/new-api)（AGPL-3.0；本项目未复制其代码）。
- 余额/用量接口清单参考 [CodexBar](https://github.com/steipete/CodexBar)、[api-monitor](https://github.com/baogutang/api-monitor)、[tokscale](https://github.com/junhoyeo/tokscale)、[token-monitor](https://github.com/Javis603/token-monitor)。
