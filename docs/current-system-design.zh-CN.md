# RAH 当前系统设计总览

本文记录当前已经锁定的 RAH 系统设计，作为后续维护和接入新 provider 的主参考。细节文档见 [docs 索引](./README.md)。

## 1. 项目定位

RAH 是一个本地优先的 AI 工作台。它不是网页终端转播器，也不是某一家 CLI 的壳，而是把多家 CLI / SDK / API 的运行过程统一成 daemon-owned session、canonical event feed 和 Web workbench。

当前已接入五家 provider：

- Codex
- Claude
- Gemini
- Kimi
- OpenCode

核心目标：

- 本机 daemon 统一管理 session、事件、控制权和 provider adapter。
- Web UI 只消费 RAH canonical protocol，不直接依赖 provider-native 事件。
- Terminal handoff 模式保留真实本地 TUI，同时允许 Web/手机接管同一 live session。
- 历史浏览先加载最近 tail，再按上滚分页加载更早内容，不一次性把完整历史塞进前端。

## 2. 包结构

```text
packages/
  runtime-protocol/   协议、事件类型、API 类型、contract validation
  runtime-daemon/     HTTP/WS server、RuntimeEngine、SessionStore、EventBus、ProviderAdapter
  client-web/         React workbench、Zustand store、session/history/control UI
```

关键运行入口：

- 本机统一入口：`http://127.0.0.1:43111/`
- 开发前端：`http://127.0.0.1:43112/`
- daemon 默认端口：`43111`
- daemon 当前有意监听 `0.0.0.0`，用于支持手机/平板在同一局域网访问；是否能访问还取决于宿主机防火墙和网络环境。

## 3. Runtime 分层

### 3.1 runtime-protocol

`runtime-protocol` 是最低层契约，负责：

- `SessionSummary`
- `RahEvent`
- session capability
- API request/response 类型
- contract validator

原则：

- 前端和 daemon 都只能通过这层共享结构。
- provider-native 字段不应泄漏到主 UI。
- 新增事件前必须先判断是否能映射到已有 canonical event family。

### 3.2 runtime-daemon

`runtime-daemon` 是本机唯一 runtime owner，负责：

- HTTP API
- WebSocket event stream
- static web serving
- session lifecycle
- provider adapter registry
- terminal wrapper control channel
- stored history catalog
- history snapshot paging

关键对象：

- `RuntimeEngine`
- `SessionStore`
- `EventBus`
- `PtyHub`
- `ProviderAdapter`
- `HistorySnapshotStore`

### 3.3 client-web

`client-web` 是 workbench UI，负责：

- 工作区、左侧 session 列表、右侧 inspector
- session feed 渲染
- composer 与 control action
- history replay / claim / live attach
- provider mode/model UI（只消费 adapter 暴露的 catalog/session state，不解释 provider-native 参数）
- mobile / desktop responsive shell

前端主原则：

- 使用 canonical feed 渲染，不理解 provider 原生日志格式。
- 通过 `useSessionStore` 管 session projection、selected session、history paging、event sync。
- 对长历史使用虚拟窗口和 measured row height，不把所有 DOM 一次性渲染。
- mode/model/config 的 provider 差异必须由 adapter 通过 `ProviderModelCatalog`、`SessionModeState`、`ManagedSession.model/config/modelProfile` 暴露，前端不能把 mode 翻译成 provider-native 启动参数。

## 4. Session 类型

RAH 里需要区分三类 session 视角。

| 类型 | 含义 | 可输入 | 可 Archive/Close | 历史来源 |
| --- | --- | --- | --- | --- |
| Web-owned live | Web 通过 daemon adapter 创建或 resume 的 live session | 可以 | 关闭 daemon-owned provider client | live event + provider history |
| Terminal handoff live | `rah xxx` / `rah xxx resume <id>` 创建的真实 terminal session | 可以，但 single-writer | 关闭 wrapper / native TUI / remote turn | provider history + wrapper control |
| Read-only replay | 打开 provider 历史形成的只读 projection | 不可以，需 claim | 只关闭 UI projection | provider history |

重要边界：

- 只要 provider session 被 daemon 或 wrapper 拉起，就是 live。
- `ready`、`unread`、`approval`、`thinking` 都属于 live 的 UI 状态，不是是否 live 的边界。
- 只读打开历史不算 live，也不算写手。
- Web `claim/resume` 会把 provider history 升级成 daemon-owned live session。

## 5. 五家 Provider 当前实现

| Provider | Web new/resume | `rah xxx` handoff | 历史来源 | 控制能力 |
| --- | --- | --- | --- | --- |
| Codex | app-server thread/start、thread/resume | 真实 terminal + isolated `CODEX_HOME` + app-server remote turn | rollout jsonl | Web approval / interrupt / mode 支持较完整 |
| Claude | SDK live session | 真实 terminal + `--session-id` / `--resume <id>` + one-shot `--print` remote turn | `~/.claude/projects/**/*.jsonl` | Web-owned 支持 SDK approval；handoff 默认 bypass |
| Gemini | stream-json live session | 真实 terminal + one-shot prompt remote turn | Gemini conversation file + cache | Web-owned mode 可切；handoff 默认 yolo |
| Kimi | wire/ACP live client | terminal wrapper / wire client | Kimi wire jsonl | approval 支持；`default/yolo` 切换要求 idle |
| OpenCode | ACP/API live client | terminal wrapper / OpenCode API | OpenCode SQLite message store | permission ruleset 支持 Ask/Full auto |

默认权限策略见 [Session 入口与权限边界](./session-entry-capability-boundary.zh-CN.md)。当前默认统一偏向低摩擦最大权限：

- Codex：`never/danger-full-access`
- Claude：`bypassPermissions`
- Gemini：`yolo`
- Kimi：`yolo`
- OpenCode：`opencode/full-auto`

这些默认值由 adapter 的 `ProviderModelCatalog.defaultModeId` 提供。前端只传 RAH 标准 `modeId`，不再把 mode 拆成 Codex `approvalPolicy/sandbox`、Claude permission mode、Gemini approval mode 或 OpenCode permission ruleset。具体映射见 [Provider Adapter 协议与能力边界](./provider-adapter-protocol.zh-CN.md)。

`SessionModeDescriptor.role` 是 UI 的稳定语义层：

- `ask`
- `auto_edit`
- `full_auto`
- `plan`
- `custom`

Provider 原生 mode id 仍可作为 `id` 保留，但前端只用 `role` 做稳定展示。比如 Codex `on-request/read-only` 的 role 是 `ask`，不应在 UI 上被解释成绝对“只读”。

`SessionModeDescriptor.applyTiming` 是 mode 的应用时机语义层，用来区分 `immediate`、`next_turn`、`idle_only`、`restart_required`、`startup_only`。例如 Kimi 的 `default/yolo/plan` 是 `idle_only`，因为切换可能要重启 wire client；Codex/Gemini/OpenCode 多数 mode 是下一 turn 生效；Claude SDK mode 可同步到当前 query control plane。

## 6. Terminal Handoff 原则

Terminal handoff 的目标是：

- 本地终端保持真实 provider TUI 体验。
- Web UI 可以立即看到这个 session 出现在 live list。
- 用户离开 Mac 后，可以用手机 Web UI 继续同一 session。

当前锁定原则：

- single-writer：任意时刻只有 terminal 或 web 一方负责输入。
- 不同步 draft：只同步已提交 turn，不同步光标、未提交草稿、选区、slash menu。
- transcript 主要来自 provider history 文件/数据库，不从屏幕画面解析主内容。
- terminal 画面是用户体验 surface，不是 canonical data source。
- Web 接管时 terminal 进入 remote control 面板；`Esc` 在安全状态下 reclaim 本地控制。

当前不承诺：

- 在原生 TUI 内部 `/new` / `/resume` 后所有 provider 都能自动 rebind。
- terminal 和 Web 同时双写。
- handoff session 在 Web 里动态修改全局权限模式。

## 7. 历史浏览模型

历史浏览统一走 tail-first paging：

1. 打开 session 时先加载最近一页。
2. 当前前端页大小为 `250` 个 RAH events。
3. 用户向上滚动接近顶部时，前端用 `nextCursor` 或 `nextBeforeTs` 拉更早一页。
4. 新页面 prepend 到 feed 前面，并通过 scroll anchor 保持当前阅读位置。
5. 如果内容不足一屏，前端会继续自动加载更早历史直到填满或没有下一页。

后端由 `HistorySnapshotStore` 冻结一次浏览快照：

- 首屏冻结 provider 历史 revision。
- 后续 cursor 只能在同一个 frozen snapshot 内翻页。
- claim/resume 后不会把新 live 内容污染进当前历史快照。

各 provider 的底层分页实现见 [历史浏览与分页边界](./history-browsing.zh-CN.md)。

## 8. Archive / Close 语义

Archive 在 RAH 里的实际语义是“断掉 runtime 管理的 live 执行体”，不是删除 provider 历史。

| Session 类型 | Archive/Close 行为 |
| --- | --- |
| Web-owned live | 关闭 daemon-owned provider client，session 从 live list 消失，历史仍保留在 provider 自己的存储中 |
| Terminal handoff live | 通知 wrapper 关闭 remote/native 执行体，终端侧应恢复 shell 或退出 TUI |
| Read-only replay | 只关闭 RAH UI projection，不删除 provider 原始历史 |

删除历史是另一类动作，应走 provider stored session remove/trash 语义，不应混进 Archive。

## 9. Liveness 边界

RAH 判断 session 是否 live 时按写手和 owner 区分：

- 有 RAH 管理绑定：live。
- 有 terminal wrapper：live。
- provider 历史文件有外部活跃写手：external live。
- 只是 Web 打开历史读取文件：不算 live。
- 无 RAH 管理写手、无活跃外部写手、文件稳定：closed history。

Codex pending tool 收口的细节见 [Codex 历史 liveness 与 pending tool 收口边界](./codex-history-liveness.zh-CN.md)。

## 10. UI 状态边界

左侧 sidebar 的状态含义：

- `ready`：live 但空闲。
- `unread`：live 或历史 projection 有未读更新。
- `approval`：live turn 等待用户批准。
- `thinking`：live turn 正在执行。

这些是 session 的展示状态，不是 live 判定条件。live 的边界来自 runtime ownership / wrapper binding / provider write liveness。

Stop 按钮语义：

- 用作 thinking 状态提示。
- 如果当前 turn 是 Web 发起且 provider 支持 interrupt，Stop 应尝试传递 interrupt。
- 如果当前 turn 是 terminal TUI 发起，Web 可能只能提示“terminal 接管中，Web 无中断权限”。

## 11. Provider 历史与 Markdown 展示

主 UI 展示的是 provider history 翻译后的 canonical timeline：

- user message
- assistant message
- reasoning
- tool call
- observation
- permission
- attention / notice

重要规则：

- 不把 provider 内部 control tags 直接展示给用户。
- 过滤 `<turn_aborted>` 等上下文标签时必须保留原始换行、列表和代码块。
- 不用 `replace(/\s+/g, " ")` 这类全局压平逻辑处理 assistant text。
- 不同 provider 的原始结构化输出差异由 adapter 吸收，前端只渲染 canonical text/markdown。

## 12. 常用开发命令

```bash
npm install
npm run build:web
npm run serve:workbench
npm run typecheck
npm run test:web
npm run test:runtime
```

Provider smoke 依赖本机 CLI 和账号状态，不是所有机器默认门禁。只在确认对应 provider CLI、登录、权限、额度都可用时运行。

## 13. 维护检查清单

改 session/control/history/provider 行为时，至少检查：

- Web new 是否仍按默认最大权限启动。
- Web resume/claim 是否在首条输入前完成 mode/model 对齐。
- `rah xxx` 是否能出现在左侧 live session。
- Web 接管是否能 single-writer 发送、结束、恢复 idle。
- Archive 是否能关闭对应 live 执行体。
- 历史打开是否先显示 tail，并能上滚到第一条用户消息。
- Markdown 换行、列表、代码块是否保留。
- interrupted/aborted turn 是否不会留下永久 Running tool。
- iOS / iPad / desktop 的 composer、safe-area、sidebar 状态是否正常。

## 14. 非目标

当前不做：

- 云端多用户服务。
- provider 历史文件跨机器同步。
- Web 直接接管用户未通过 RAH 启动的野生 TUI。
- 在同一个真实 TUI 中同步未提交草稿和光标。
- 为每个 provider 原生 UI 状态做像素级镜像。
