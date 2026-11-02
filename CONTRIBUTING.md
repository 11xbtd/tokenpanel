# 参与贡献

感谢你愿意改进 TokenPanel。提交 Issue 或 Pull Request 前，请先看下面的约定。

## 环境

- Node.js 22+；Qoder / ZCode 的 SQLite 读取和 DeepSeek Harness 的 zstd 日志需要 Node 22.15+。
- npm 10+。
- 本机数据默认在 `%APPDATA%\TokenPanel`（Windows）或 `~/.tokenpanel`；开发时可以用 `TOKENPANEL_DATA_DIR` 指到临时目录。

```bash
npm ci
npm run dev        # API :5188 + Vite :5173
npm run demo       # 演示数据，:5189
```

## 提交前

```bash
npm run typecheck
npm test
npm run build
```

三项都通过再提交。涉及界面的改动请附截图；涉及厂商接口、日志格式或 AI 动态来源的改动，请附**脱敏后**的响应/日志样例。

## 代码结构

- `src/core/`：共享核心、厂商注册表、适配器、存储、计价、聚合、告警。
- `src/core/logs/`：本机客户端日志适配器、增量扫描与模型归属。
- `src/core/news/`：AI 动态来源目录、解析、监控、缓存与关注。
- `src/core/rankings/`：Artificial Analysis 榜单同步、分页、缓存、Key 管理与退避。
- `src/node/`：本地服务、uTools preload、演示数据。
- `src/renderer/`：React 界面。
- `tests/`：Vitest，按模块拆分。

## 新增厂商或日志源

- 厂商预设：更新 `src/core/providers/registry.ts`，补对应适配器、解析测试，并在 `scripts/build-brands.mjs` 的映射表里补品牌图标（如需要）。
- 本机日志源：在 `src/core/logs/adapters/` 下新增适配器，补 `src/core/logs/registry.ts` 与测试；测试用手写 fixture，不要提交真实会话日志。
- 新来源必须限定 HTTPS 与明确域名（`allowedHosts`），不要引入任意 URL 抓取或绕过登录态。

## AI 动态与模型排行

- AI 动态只接受目录中的官方来源与量子位；解析器需要处理失败、去重、追踪参数清理和来源域名校验。
- AA Key 只在 Node 服务 / uTools preload 中使用，不要传进渲染层；测试不要使用真实 Key。
- 共享 AA Key 通过 `TOKENPANEL_AA_SHARED_API_KEY` 或 `TOKENPANEL_AA_KEY_DIR` 在构建期注入；不要把 `.dev/aa-owner-data` 或真实 Key 提交到仓库。

## 安全与隐私

- 不要提交 `config.json`、`usage.ndjson`、`snapshots.ndjson`、`news-cache.json`、`aa-settings.json`、`secret.key` 或任何真实凭证。
- 测试里的 Key 用 `sk-test-*`、`aa_test_*` 这类明显占位值。
- 日志样例、截图和 Issue 内容都要先脱敏；不要包含 prompt、回复正文、Cookie 或账号 ID。
- 安全问题请按 [SECURITY.md](SECURITY.md) 私密报告。

## Pull Request

- 一个 PR 尽量只做一件事；修复与无关重构分开。
- 说明改动原因、影响范围和验证方式；界面改动附前后截图。
- 不要为了通过检查而降低测试覆盖，也不要提交构建产物（`dist/`、`release/`）或本机数据。

## 许可证

提交代码即表示你同意以本项目的 MIT 许可证发布你的贡献。
