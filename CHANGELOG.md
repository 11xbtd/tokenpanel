# Changelog

本项目的重要变更记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 1.1.2 - 2026-11-02

### Changed

- DeepSeek Harness 的 zstd 解码从纯 JS `fzstd` 换成 WASM `zstddec`：本机 17.8 MB 会话日志从约 37 秒降到约 0.4 秒，uTools 的 Node 20 也能用。
- 点击「重建」或修改日志归属规则时会清空 DSH 的增量解析位置，确保从文件头完整重扫。
- 同步 uTools 插件与浏览器版版本号为 1.1.2。

## 1.1.1 - 2026-11-02

### Fixed

- 修复 DeepSeek Harness 会话日志在 uTools 内置 Node 20 下无法解压 `.jsonl.zstd`、导致 usage 统计不到的问题；新增 `fzstd` 纯 JS 回退，Node 22+ 仍优先使用原生 zstd。
- DSH 日志追加后从文件末尾附近增量解析，避免每次刷新都重扫整个大文件；首次解析大日志仍可能慢一些。
- 同步 uTools 插件与浏览器版版本号为 1.1.1。

## 1.1.0 - 2026-11-02

### Changed

- uTools 功能指令精简为 5 个：`token`、`tokenpanel`、`AI余额`、`AI动态`、`模型排行`，修复插件市场「每个功能指令建议不超过 5 个」的发布校验。
- 移除重复的 `TokenPanel`（与 `tokenpanel` 重复）和 `额度看板` 指令。
- 同步 uTools 插件与浏览器版版本号为 1.1.0。

## 1.0.0 - 2026-11-02

首个公开版本：uTools 插件 + 浏览器本地服务，数据只存本机。

### Added

- 总览分「按量 API / 订阅套餐」两个 Tab，统一展示余额或最紧窗口剩余、今日/本月/累计 token、近 7 天走势、缓存命中、速度与首字。
- 额度时间轴：未来 24 小时 / 7 天 / 全部范围，展示窗口重置时间，并按近期节奏预估耗尽时间。
- 消耗分析：按天、账户、模型拆解 token，支持缓存命中率、调用明细筛选与 CSV 导出。
- AI 动态：分「官方动态 / 相关报道」两个流，关注主流厂商与客户端，支持分类、未读、搜索、时间范围和预览版筛选；关注对象会按账户与日志源自动推荐。
- 模型排行：接入 Artificial Analysis 免费接口，比较智能指数、输出速度、首答等待、输入/输出价格与任务成本；支持排序、厂商/关注筛选、隐藏缺测和中文别名搜索。
- 本机客户端日志：Claude Code、Codex、Kimi Code、Kimi CLI、Gemini CLI、Qwen Code、Cline/Roo/Kilo、OpenCode、Qoder、ZCode、DeepSeek Harness 等 11 类。
- 预制 20+ 家厂商与中转站配置，支持手动录入、CSV 导入和自定义 HTTP。
- 账户密钥、Webhook URL 与个人 AA Key 使用 AES-256-GCM 加密；无遥测；接口失败保留上次成功数据。
- GitHub Actions CI：Ubuntu / Windows 双平台执行类型检查、171 项测试和构建。

### Security

- 日志与错误信息统一脱敏；AA Key 只在 Node 服务 / uTools preload 中使用，不进入渲染层。
- uTools preload 构建后真实 `require` 一次，验证 CommonJS 加载、桥接注入与首次读取。
- 公共构建可注入 AA 共享 Key；源码仓库不包含真实 Key，个人 Key 优先。
