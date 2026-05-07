# RAH 当前系统设计总览

本文记录当前已经锁定的 RAH 系统设计，作为后续维护和接入新 provider 的主参考。细节文档见 [docs 索引](./README.md)。

## 1. 项目定位

RAH 是一个本地优先、PTY-first 的 AI 工作台。它不是要替五家 CLI 重写完整 Web agent，而是让原生 provider TUI session 由 daemon 持有，并让桌面 Terminal、Web、PWA、iPad/iPhone、Canvas pane 都 attach 到同一个 live PTY session。

当前已接入五家 provider：

- Codex
- Claude
- Gemini
- Kimi
- OpenCode

当前核心目标：

- 本机 daemon 统一持有真实 PTY/TUI session、事件、控制权和 provider launch/mirror adapter。
- live truth 是 PTY/TUI 进程状态与 PTY output；客户端 detach/reload/background 不应杀掉 session。
- 结构化 Chat/Timeline 只来自 provider 原厂 jsonl/db/session history mirror，不从 ANSI/TUI 输出反推。
- Web UI 只消费 RAH canonical protocol，不直接依赖 provider-native 事件。
- `rah <provider>`、Web New、Canvas New、Web Claim History 默认都进入 native TUI PTY runtime；旧 structured live adapter 仅作为显式 legacy/enhancement 路径保留。
- 历史浏览先加载最近 tail，再按上滚分页加载更早内容，不一次性把完整历史塞进前端。

## 2. 包结构

```text
packages/
  runtime-protocol/   协议、事件类型、API 类型、contract validation
  runtime-daemon/     HTTP/WS server、RuntimeEngine、SessionStore、EventBus、identity-only ProviderAdapter + capability maps
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
- `timeline.item.*` 可以携带可选 `TimelineIdentity`，用于把 live stream 与 history replay 的同一条真实消息映射到同一个 `canonicalItemId`。

Timeline identity 的硬约束：

- `canonicalItemId` 只由 `provider + providerSessionId + turnKey + itemKind + itemKey` 这类身份字段生成。
- `origin` 只能表示来源是 `live` 还是 `history`，不能进入 canonical key。
- `contentHash` 只能用于校验或弱 fallback，不能作为主身份。
- `sourceCursor` 只记录原始证据，例如文件行、byte offset、provider message id、DB row id；它不参与 canonical key。
- `confidence` 标记身份强度：`native`、`derived`、`provisional`、`heuristic`。
- daemon 会对高价值 timeline item 缺失 identity、identity 与 item/provider 不一致、同一 `canonicalItemId` 结构冲突做诊断 warning；这些 warning 不进入 UI，只用于发现 adapter 漏洞。

### 3.2 runtime-daemon

`runtime-daemon` 是本机唯一 runtime owner，负责：

- HTTP API
- WebSocket event stream
- static web serving
- session lifecycle
- provider launch/mirror adapter registry
- native TUI PTY runtime
- legacy terminal wrapper control channel
- stored history catalog
- history snapshot paging

关键对象：

- `RuntimeEngine`
- `SessionStore`
- `EventBus`
- `PtyHub`
- `PtySessionRuntime`
- `RuntimeTerminalCoordinator`
- `NativeTuiMirrorRuntime`
- `NativeTuiMirrorProvider`
- identity-only `ProviderAdapter` + explicit capability maps（legacy structured/enhancement/stored-history adapter seam）
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
- 如果 timeline event 有 `canonicalItemId`，projection 必须按该 id upsert；`messageId` 和 text/time 去重只作为旧事件 fallback。
- 通过 `useSessionStore` 管 session projection、selected session、history paging、event sync。
- 对长历史使用虚拟窗口和 measured row height，不把所有 DOM 一次性渲染。
- mode/model/config 的 provider 差异必须由 adapter 通过 `ProviderModelCatalog`、`SessionModeState`、`ManagedSession.model/config/modelProfile` 暴露，前端不能把 mode 翻译成 provider-native 启动参数。

## 4. Session 类型

RAH 里需要区分四类 session 视角。

| 类型 | 含义 | 可输入 | 可 Archive/Close | 历史来源 |
| --- | --- | --- | --- | --- |
| Native TUI live | daemon 启动并持有真实 provider TUI PTY；Web New、Canvas New、Web Claim、`rah xxx` 默认都进入这条路径 | 可以，但需要 control lease | 显式 close/archive 才关闭 PTY/TUI | PTY replay + provider history mirror |
| Read-only replay | 打开 provider 历史形成的只读 projection | 不可以，需 claim | 只关闭 UI projection | provider history |
| Legacy structured live | 旧测试/调试路径；生产默认拒绝显式 `liveBackend: "structured"`，除非设置 `RAH_ENABLE_LEGACY_STRUCTURED_LIVE=1` | 可以 | 关闭 provider adapter client | provider SDK/API event + history |
| Legacy wrapper live | 旧 terminal wrapper handoff；不再从公开 `rah xxx` 入口暴露，仅保留为内部 legacy/synthetic test surface | 可以，但 single-writer | 关闭 wrapper session | provider history + wrapper control |

重要边界：

- 只要 provider session 被 daemon-owned native TUI PTY 拉起，就是 live；没有 client attach 时也仍然 live。
- `ready`、`unread`、`approval`、`thinking` 都属于 live 的 UI 状态，不是是否 live 的边界。
- 只读打开历史不算 live，也不算写手。
- Web `claim/resume` 默认把 provider history 升级成 daemon-owned native TUI live session；只读浏览不触发 resume。
- client detach、浏览器 reload、PWA 切后台只应影响 attach 状态，不能隐式 close/archive/kill session。

## 5. 五家 Provider 当前实现

| Provider | 默认 live path | Launch/resume spec | Structured mirror source | 增强控制边界 |
| --- | --- | --- | --- | --- |
| Codex | daemon-owned native TUI PTY | `codex --cd <cwd>` / `codex resume --cd <cwd> <id>`，必要时 isolated `CODEX_HOME` | rollout jsonl / sessions | model/mode 可作为启动参数增强；运行中以原生 TUI 为准 |
| Claude | daemon-owned native TUI PTY | `claude --session-id <uuid>` / `claude --resume <id>` | `~/.claude/projects/**/*.jsonl` | permission/model/effort 作为启动参数增强；运行中以原生 TUI 为准 |
| Gemini | daemon-owned native TUI PTY | `gemini` / `gemini --resume <id>` | Gemini conversation file + cache | approval/model 作为启动参数增强；无 RAH 统一 effort |
| Kimi | daemon-owned native TUI PTY | `kimi --session <uuid|id>` | Kimi wire jsonl / session files | model/thinking/mode 作为启动参数增强；运行中以原生 TUI 为准 |
| OpenCode | daemon-owned native TUI PTY | `opencode [--session <id>] <cwd>` | OpenCode SQLite message store | model/permission ruleset 作为启动参数增强；运行中以原生 TUI 为准 |

默认权限策略见 [Session 入口与权限边界](./session-entry-capability-boundary.zh-CN.md)。当前默认统一偏向低摩擦最大权限：

- Codex：`never/danger-full-access`
- Claude：`bypassPermissions`
- Gemini：`yolo`
- Kimi：`yolo`
- OpenCode：`opencode/full-auto`

这些默认值由 adapter 的 `ProviderModelCatalog.defaultModeId` 提供。前端只传 RAH 标准 `modeId`，daemon 在 native TUI launch spec 中尽量翻译为 provider 启动参数。启动增强失败或 provider 语义变化不应影响 PTY core 的产品边界；用户始终可以切到原生 TUI 使用官方 `/permission`、`/model`、`/plan`、`/goal` 等能力。具体映射见 [Provider Adapter 协议与能力边界](./provider-adapter-protocol.zh-CN.md)。

`SessionModeDescriptor.role` 是 UI 的稳定语义层：

- `ask`
- `auto_edit`
- `full_auto`
- `plan`
- `custom`

Provider 原生 mode id 仍可作为 `id` 保留，但前端只用 `role` 做稳定展示。比如 Codex `on-request/read-only` 的 role 是 `ask`，不应在 UI 上被解释成绝对“只读”。

`SessionModeDescriptor.applyTiming` 是 mode 的应用时机语义层，用来区分 `immediate`、`next_turn`、`idle_only`、`restart_required`、`startup_only`。例如 Kimi 的 `default/yolo/plan` 是 `idle_only`，因为切换可能要重启 wire client；Codex/Gemini/OpenCode 多数 mode 是下一 turn 生效；Claude SDK mode 可同步到当前 query control plane。

## 6. PTY Attach 原则

PTY attach 的目标是：

- 真实 provider TUI 始终运行在 daemon 持有的 PTY 中。
- 本地终端、Web terminal、PWA/iPad/iPhone、Canvas pane 都只是 attach client。
- `rah xxx` 默认不再拥有 provider 进程生命周期；它请求 daemon 创建/resume native TUI session，然后把当前 terminal attach 到该 PTY。
- 桌面 terminal 断开只 detach，不杀 session；显式 close/archive 才关闭 TUI。
- Web UI 可以立即看到 live session，并在 reload/focus 后通过 PTY replay 追上。

当前锁定原则：

- single-writer：任意时刻只有一个 client 拥有 control lease。
- 不同步 draft：只同步已提交 turn，不同步光标、未提交草稿、选区、slash menu。
- transcript 主要来自 provider history 文件/数据库，不从屏幕画面解析主内容。
- terminal 画面是用户体验 surface，不是 canonical data source。
- Chat composer 是 PTY 文本注入桥；如果 TUI prompt dirty，应阻止注入，避免污染用户正在 TUI 里编辑的草稿。

当前不承诺：

- 在原生 TUI 内部 `/new` / `/resume` 后所有 provider 都能自动 rebind。
- 多客户端同时双写。
- Web 对 native TUI session 动态修改所有 provider 私有权限/模型/plan 状态。
- structured mirror 100% 覆盖 provider 新增的私有 UI 功能；mirror missing/failed 只进入 diagnostics，不影响 TUI live。

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
| Native TUI live | 显式关闭 daemon-owned PTY/TUI，session 从 live list 消失，provider 原始历史仍保留 |
| Read-only replay | 只关闭 RAH UI projection，不删除 provider 原始历史 |
| Legacy structured live | 关闭 provider adapter client，session 从 live list 消失 |
| Legacy wrapper live | 通知旧 wrapper 关闭 remote/native 执行体，终端侧应恢复 shell 或退出 TUI |

删除历史是另一类动作，应走 provider stored session remove/trash 语义，不应混进 Archive。

## 9. Liveness 边界

RAH 判断 session 是否 live 时按写手和 owner 区分：

- 有 RAH 管理绑定：live。
- 有 daemon-owned native TUI PTY：live，即使当前没有 attached client。
- 旧 terminal wrapper 仍可算 live，但只是内部 legacy/test 路径，不再是公开 CLI 入口。
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
- live 与 history 的重复消除应优先依赖 `TimelineIdentity.canonicalItemId`，而不是靠文本相同、时间接近来猜。
- 当前阶段是 Timeline Identity v2 的 MVP：协议、daemon 透传、前端 upsert、五家 adapter 的 native/derived identity 已具备。后续如果继续增强，应在 daemon 侧增加 epoch/seq ledger 做 replay/gap/catch-up，而不是把 text/time window 重新变成主逻辑。

## 12. 常用开发命令

首次 checkout 或依赖变化时：

```bash
npm install
```

日常源码启动/更新后重启：

```bash
node bin/rah.mjs restart --no-open
```

如果只改后端、不需要重新构建 Web：

```bash
node bin/rah.mjs restart --no-build --no-open
```

`restart` 会停止当前 managed daemon，再用当前 checkout 的源码启动新 daemon。它会中断当前由 daemon 管理的 live wrappers/TUIs（例如 `rah codex`、`rah claude`、`rah gemini`、`rah kimi`、`rah opencode`），因为旧 daemon 会被关闭。`start` 只保证 daemon 正在运行；如果旧 daemon 已经 ready，它不会替换成新代码。普通代码更新不需要 `npm install`。

后台 daemon 管理命令：

```bash
node bin/rah.mjs status
node bin/rah.mjs logs --follow
node bin/rah.mjs stop
```

如果希望全局 `rah` 命令指向当前 checkout，可选执行一次：

```bash
npm link
rah restart --no-open
```

验证命令：

```bash
npm run typecheck
npm run test:web
npm run test:runtime
npm run test:smoke:wrapper
```

`npm run test:smoke:wrapper` 默认会启动一个隔离的临时 daemon，并连接其 wrapper-control / event stream / input / close 路由，覆盖 Codex、Claude、Gemini、Kimi、OpenCode 五家 adapter 的 wrapper 生命周期、Web 输入注入、canonical timeline identity 透传和清理。它不调用外部 provider CLI 或模型 API，因此适合作为 daemon 层稳定 smoke。如果要验证已经运行的 daemon，可以显式设置 `RAH_BASE_URL=http://127.0.0.1:43111`。

Provider browser smoke 依赖本机 CLI、账号状态和额度，只应在已配置完整的机器上运行：

```bash
npm run test:smoke:browser-providers
```

也可以按 provider 单独运行 `test:smoke:codex-browser`、`test:smoke:claude-browser`、`test:smoke:gemini-browser`、`test:smoke:kimi-browser`、`test:smoke:opencode-browser`。

`npm run serve:workbench`、`npm run dev:daemon`、`npm run dev:web` 仅用于前台调试或拆分调试。Provider smoke 不是所有机器默认门禁。

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
