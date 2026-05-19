# RAH 当前系统设计总览

本文记录当前已经锁定的 RAH 系统设计，作为后续维护和接入新 provider 的主参考。细节文档见 [docs 索引](./README.md)。

## 1. 项目定位

RAH 是一个本地优先的 AI 工作台。它不是要替所有 CLI 重写完整 Web agent，而是让 running session 由本机 daemon 持有，并让桌面 Terminal、Web、PWA、iPad/iPhone、Canvas pane 能接入同一个 provider session。

当前 `main` 把 running 主线拆成 provider runtime：

- Codex / OpenCode 默认走 `native_local_server`，RAH 通过 provider 官方本地 server 获取结构化 live event、发送 turn、执行 interrupt/stop。
- Codex / OpenCode 的本地 TUI 是 provider 官方 client/view，例如 Codex `codex --remote ... resume <threadId>`、OpenCode `opencode attach ... --session <id>`。
- Claude / Gemini 默认走 `tui_mux_fallback`，tmux/TUI mux 负责原生 TUI 工作现场，结构化 Chat 来自 provider 原厂历史文件 mirror。
- Web/PWA 只有显式打开 `TUI` 视图才 claim TUI display surface；普通 Chat 浏览不应触发 TUI attach。

当前 running 主线收敛为四家 provider：

- Codex
- Claude
- Gemini
- OpenCode

Gemini CLI 已恢复为 `tui_mux_fallback` provider，历史解析读取当前 Gemini CLI JSON session 文件。Kimi CLI 一等 provider 代码仍移除；Kimi、GLM、MiniMax、Grok、DeepSeek 等低频 API-key 模型优先通过 OpenCode + API provider / 中转站承载。

当前核心目标：

- 本机 daemon 统一持有 provider runtime、事件、控制权和 provider launch/mirror adapter。
- Codex/OpenCode 的实时 truth 是 provider native local server event；Claude/Gemini fallback 的现场连续性由 tmux/TUI mux 维持。
- 结构化 Chat/Timeline 来自 provider server event 与原厂 jsonl/db/session history mirror，不从 ANSI/TUI 输出反推。
- Web UI 只消费 RAH canonical protocol，不直接依赖 provider-native 事件。
- `rah codex/opencode`、Web New、Canvas New、Web Claim History 对 Codex/OpenCode 默认进入 native local server runtime；`rah claude/gemini` 和 Claude/Gemini Web running session 默认进入 tmux/TUI mux fallback。
- 历史浏览先加载最近 tail，再按上滚分页加载更早内容，不一次性把完整历史塞进前端。

## 2. 包结构

```text
packages/
  runtime-protocol/   协议、事件类型、API 类型、contract validation
  runtime-daemon/     HTTP/WS server、RuntimeEngine、SessionStore、EventBus、MuxRuntime、identity-only ProviderAdapter + capability maps
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
- stored history catalog
- history snapshot paging

关键对象：

- `RuntimeEngine`
- `SessionStore`
- `EventBus`
- `PtyHub`
- `PtySessionRuntime`
- `MuxRuntime`
- `TmuxMuxBackend`
- `RuntimeTerminalCoordinator`
- `NativeTuiMirrorRuntime`
- `NativeTuiMirrorProvider`
- identity-only `ProviderAdapter` + explicit capability maps（provider-server control / enhancement / stored-history seams）
- `HistorySnapshotStore`

### 3.3 client-web

`client-web` 是 workbench UI，负责：

- 工作区、左侧 session 列表、右侧 inspector
- session feed 渲染
- composer 与 control action
- history replay / claim / running attach
- provider mode/model UI（只消费 adapter 暴露的 catalog/session state，不解释 provider-native 参数）
- mobile / desktop responsive shell

前端主原则：

- 使用 canonical feed 渲染，不理解 provider 原生日志格式。
- 如果 timeline event 有 `canonicalItemId`，projection 必须按该 id upsert；`messageId` 和 text/time 去重只作为旧事件 fallback。
- 通过 `useSessionStore` 管 session projection、selected session、history paging、event sync。
- 对长历史使用虚拟窗口和 measured row height，不把所有 DOM 一次性渲染。
- mode/model/config 的 provider 差异必须由 adapter 通过 `ProviderModelCatalog`、`SessionModeState`、`ManagedSession.model/config/modelProfile` 暴露，前端不能把 mode 翻译成 provider-native 启动参数。

### 3.4 Conversation State 顶层协议

Session 和 Council room 共享同一套用户可见生命周期协议，协议入口在 `packages/runtime-protocol/src/conversation-state.ts`：

- `status: "running" | "stopped"`
- `phase: "starting" | "ready" | "working" | "waiting_input" | "waiting_permission" | "stopping" | "failed" | "ended"`

状态语义：

- `running` 表示 RAH 仍持有可继续工作的执行体：native local server session、tmux/TUI mux session、Council room/agent runtime，或本进程内正在启动的 room/session。是否正在 thinking、是否空闲、是否等待用户批准，都不改变 `running`。
- `stopped` 表示执行体已经不存在或不再由 RAH 管理，只剩 transcript/history/projection。`stopped` 对应用户语义是“这个对话已停止”，不是删除历史。
- `phase` 描述 `running` 或 `stopped` 内部的细分状态。`ready` 是 running 但空闲；`working` 是正在执行；`waiting_input` 和 `waiting_permission` 是运行中等待用户；`failed` 是停止在错误态；`ended` 是正常停止。
- `live`、`archived` 不再作为用户层或 UI 层的 canonical 状态词。底层 provider 文档里仍可用 `live event/live stream` 描述实时事件流，但 RAH 自己的对象状态统一说 `running/stopped`。

命名边界：

- 用户可见生命周期、前端 view model、workspace/sidebar/history/canvas/council room 过滤，都必须使用 `running/stopped`。
- RAH 运行体生命周期 capability 必须使用 `actions.stop` 和 `stopLifecycle`。
- `previous_running` 表示“之前由 RAH running runtime 产生、现在作为 recent/stored 历史展示的记录”。旧持久化里的 `previous_live` 只作为迁移输入接受。
- `liveBackend`、`structuredLiveEvents`、timeline `origin: "live"`、`live stream/event` 可以保留，因为它们描述实时事件源或 provider 技术通道，不是用户层对象状态。
- provider 原生历史字段可以保留 provider 自己的 `archive/archived` 命名，例如 OpenCode `time_archived`、Codex `archived_sessions`；它们属于 provider stored-history 语义，不等于 RAH Stop。

协议落地规则：

- `ManagedSession.status/phase` 是新协议字段；旧 `runtimeState` 只保留为 adapter 兼容字段，写入时必须同步映射到 `status/phase`。
- `CouncilRoom.status` 只允许 `running/stopped`，启动、失败、结束都进入 `phase`。旧 room 文件中的 `starting/running/idle/stopped/failed` 会在加载时迁移。
- `SessionActionCapabilities.actions.stop` 表示这个 running session 能否被 RAH 停止；runtime feature 使用 `stopLifecycle`。不要再新增 `archive` 作为运行体生命周期字段。
- 前端 selector、sidebar、history dialog、Canvas pane、session info、Council rooms browser 都只用 `status/phase` 做用户可见判断。
- Stop/Close 是关闭 running 执行体；删除历史必须走 provider stored-session remove/trash 语义，不能和 `stopped` 混为一谈。
- CLI 用户入口使用 `rah close <rahSessionId>` 关闭 running session；旧 `rah archive` 只能作为兼容 alias，不出现在新文档和提示里。
- 启动中的 Council room 只有在当前 daemon 进程确实有 pending launch 任务时，才可以暂时显示为 `running/starting` 且没有活终端；daemon 重启后遗留的 stale starting room 如果没有 live agent，必须投影或 reconcile 为 `stopped/ended`。

### 3.5 Workbench / Canvas 对象面板边界

Session 和 Council room 都是 workspace 里的可打开对象。它们在普通页面、左侧 workspace sidebar、Canvas pane、Canvas 最大化 pane 中应共享同一个对象 UI 语义，而不是分别实现几套风格漂移的视图。

当前前端用 `ObjectPaneVariant` 固定两个展示变体：

- `compact`：伸缩版本，只包含对象标题栏和 Chat 主区域，适合普通 Canvas 分屏 pane。
- `expanded`：扩展版本，在 `compact` 的基础上增加对象侧边栏，适合 Canvas 最大化 pane 和完整页面壳。

具体映射：

- Session `compact` = 标题栏 + session chat/composer。
- Session `expanded` = 标题栏 + session chat/composer + Inspector 侧边栏。
- Council room `compact` = 标题栏 + room chat。
- Council room `expanded` = 标题栏 + room chat + Agents 侧边栏。

Canvas 的普通分屏 pane 只使用 `compact`，避免 2/3/4 分屏时侧栏挤压主内容；pane 最大化后切到 `expanded`，让用户获得接近完整 session / council room 的工作体验。完整页面 shell 不是另一种对象 UI，而是把同一个对象主区域和侧边栏组合进顶层 workbench chrome。

## 4. Session 类型

RAH 里需要区分四类 session 视角。

| 类型 | 含义 | 可输入 | 可 Stop/Close | 历史来源 |
| --- | --- | --- | --- | --- |
| Native local server running | daemon 启动并持有 provider 官方本地 server session；Codex/OpenCode 默认走该路径 | 可以，走 provider structured control | 显式 stop/close 才关闭或解除 RAH 管理 | provider server event + provider history backfill |
| TUI mux fallback running | daemon 启动并持有真实 provider TUI；Claude/Gemini 默认走 tmux mux | 可以，但需要 control/surface lease | 显式 stop/close 才关闭 TUI/tmux pane | provider history mirror + TUI diagnostics |
| Read-only replay | 打开 provider 历史形成的只读 projection | 不可以，需 claim | 只关闭 UI projection | provider history |
| Structured test running | 只允许测试注入 adapter 直接调用 engine；公开 HTTP API 拒绝 `liveBackend: "structured"` | 可以 | 关闭 provider adapter client | injected adapter event + history |

Structured test running 的保留决策：

- 保留它作为内部测试 harness，而不是生产 running 主链路。
- 普通 daemon 不构造 Claude SDK/headless structured live adapter；该旧路径已删除。
- Codex/OpenCode 的 provider-server control adapter 是当前生产路径的一部分，虽然仍提供 structured event/control 能力，但默认 backend 是 `native_local_server`。
- 公开 Web/CLI/canvas running 入口只进入 provider runtime descriptor 声明的主路径：Codex/OpenCode 是 native local server，Claude/Gemini 是 tmux/TUI mux fallback。
- 旧 wrapper-control / terminal handoff runtime 已删除，不再作为测试或兼容面存在。

重要边界：

- 只要 provider session 被 daemon-owned runtime 拉起，就是 `running`；没有 client attach 时也仍然 `running`。
- `ready`、`working`、`waiting_input`、`waiting_permission` 都属于 `phase`，不是 `running/stopped` 边界。
- 只读打开历史不算 `running`，也不算写手。
- Web `claim/resume` 默认把 provider history 升级成 daemon-owned running session；只读浏览不触发 resume。
- client detach、浏览器 reload、PWA 切后台只应影响 attach 状态，不能隐式 stop/close/kill session。

## 5. Provider 当前实现

| Provider | 默认 running path | Launch/resume spec | Structured source | 增强控制边界 |
| --- | --- | --- | --- | --- |
| Codex | native local server | `codex app-server` + `codex --remote <endpoint> resume <threadId>` | app-server event + rollout/session backfill | model/mode/runtime config 按 Codex app-server 能力开放 |
| Claude | tmux/TUI mux fallback | `claude --session-id <uuid>` / `claude --resume <id>` inside tmux | `~/.claude/projects/**/*.jsonl` | permission/model/effort 作为启动参数增强；运行中以原生 TUI 为准 |
| OpenCode | native local server | OpenCode serve/session + `opencode attach <url> --session <id>` | OpenCode server/session event + SQLite backfill | model/variant 和原生 agent 按 OpenCode API 能力开放 |

默认权限策略见 [Session 入口与权限边界](./session-entry-capability-boundary.zh-CN.md)。当前默认统一偏向低摩擦最大权限：

- Codex：`never/danger-full-access`
- Claude：`bypassPermissions`
- OpenCode：provider 原生默认 agent，通常为 `build`

这些默认值由 adapter 的 `ProviderModelCatalog.defaultModeId` 提供。前端只传 RAH 标准 `modeId`，daemon 在 native TUI launch spec 中尽量翻译为 provider 启动参数。启动增强失败或 provider 语义变化不应影响 PTY core 的产品边界；用户始终可以切到原生 TUI 使用官方 `/permission`、`/model`、`/plan`、`/goal` 等能力。具体映射见 [Provider Adapter 协议与能力边界](./provider-adapter-protocol.zh-CN.md)。

OpenCode 的权限需要额外注意：OpenCode 默认多数工具是 `allow`，但 `external_directory` 默认是 `ask`。因此当 agent 读取或操作启动工作区之外的路径时，即使使用默认 `build` agent，也可能请求 approval。RAH 不应把这误判为 OpenCode 没有高权限模式。需要减少这类确认时，优先在用户级 `~/.config/opencode/opencode.json` 配置：

```json
{
  "permission": {
    "external_directory": {
      "*": "allow"
    }
  }
}
```

也可以通过 `OPENCODE_PERMISSION='{"external_directory":{"*":"allow"}}'` 只影响某次启动。`opencode --permissions/--tools` 是允许列表入口，不适合表达 `external_directory` 这种路径规则。

`SessionModeDescriptor.role` 是 UI 的稳定语义层：

- `ask`
- `auto_edit`
- `full_auto`
- `plan`
- `custom`

Provider 原生 mode id 仍可作为 `id` 保留，但前端只用 `role` 做稳定展示。比如 Codex `on-request/read-only` 的 role 是 `ask`，不应在 UI 上被解释成绝对“只读”。

`SessionModeDescriptor.applyTiming` 是 mode 的应用时机语义层，用来区分 `immediate`、`next_turn`、`idle_only`、`restart_required`、`startup_only`。在当前 provider runtime 范围内，Codex/OpenCode 的 mode 多数是下一 turn 或 native local server/ACP 边界生效；Claude 以官方 TUI/CLI 当前能力为准。

## 6. Native Server / Tmux Attach 原则

Native local server 与 tmux attach 的目标是：

- 普通 running session 中，Codex/OpenCode 的 provider session 始终由 daemon 管理的 native local server 持有；本地 TUI 和 Web 都是 client/view。
- Claude 的真实 provider TUI 始终运行在 daemon 管理的 tmux session/pane 中；本地终端、Web terminal、PWA/iPad/iPhone、Canvas pane 都只是 attach client。
- Council 是例外：Council agent 以 provider TUI + MCP bootstrap 形式运行在 RAH 管理的 agent PTY 中，用来保持 agent 自己的工具循环；它不代表普通 Codex/OpenCode session 的 runtime 边界。
- `rah xxx` 默认不再拥有 provider 进程生命周期；它请求 daemon 创建/resume running session，然后按 provider runtime 接入 official client 或 tmux mux。
- 桌面 terminal 断开只 detach，不杀 session；显式 stop/close 才关闭或解除 RAH 管理。
- Web UI 可以立即看到 running session，并在 reload/focus 后通过 provider event/history 或 tmux replay 追上。

当前锁定原则：

- single-writer：任意时刻只有一个 client 拥有 control lease。
- single-display-surface：tmux TUI display surface 需要显式 claim。Web/PWA 只有进入 `TUI` 视图才 claim；Chat 发问和 Stop 不 claim display surface。
- 不同步 draft：只同步已提交 turn，不同步光标、未提交草稿、选区、slash menu。
- transcript 主要来自 provider history 文件/数据库，不从屏幕画面解析主内容。
- terminal 画面是用户体验 surface，不是 canonical data source。
- Codex/OpenCode Chat composer 走 provider structured control，不通过键盘注入普通 turn。
- Claude fallback Chat composer 是 TUI 文本注入桥；如果 TUI prompt dirty，应排队或阻止注入，避免污染用户正在 TUI 里编辑的草稿。
- Stop/Close 必须关闭 provider native server session 或 Claude/Gemini 对应 tmux session，避免孤儿 runtime。

当前不承诺：

- 在原生 TUI 内部 `/new` / `/resume` 后所有 provider 都能自动 rebind。
- 多客户端同时双写。
- Web 对 native TUI session 动态修改所有 provider 私有权限/模型/plan 状态。
- structured mirror 100% 覆盖 provider 新增的私有 UI 功能；mirror missing/failed 只进入 diagnostics，不影响 TUI live。

### 6.1 退出与孤儿清理边界

RAH 对“一退全退”的设计目标是：正常退出时尽量在事前同步关闭 RAH-owned runtime；崩溃、断电、`SIGKILL` 等没有退出钩子的场景，在下一次 daemon 启动时做状态修正和孤儿清理。这里的 RAH-owned runtime 只包括：

- 当前 daemon 管理的 running session、Council room/agent session。
- RAH 创建的 `rah-*` tmux session。
- RAH 启动且带有 `RAH_NATIVE_SERVER_OWNER=rah` 标记的 Codex/OpenCode native local server 进程。
- `~/.rah/council/rooms.json` 中 Council room/agent 的持久化运行状态。

正常退出路径是 `SIGINT` / `SIGTERM` -> `daemon.close()` -> `RuntimeEngine.shutdown()`。daemon 入口在收到信号后最多等待 30 秒再强制退出；`rah stop` 最多等待 35 秒再 `SIGKILL`，给 provider close、tmux kill、状态落盘留出时间。

`RuntimeEngine.shutdown()` 的顺序是：

1. 关闭 stored-session monitor。
2. 关闭 Council runtime。
3. 关闭 terminal/tmux runtime。
4. 关闭 provider structured adapters。
5. 清理 RAH 标记的 Codex/OpenCode native local server 孤儿进程。
6. 清理未被当前 daemon 管理的 `rah-*` tmux session。
7. flush workbench state。

Council runtime 退出时先把仍处于 active/running 的 room 持久化为 stopped，并 resolve 等待中的 Council message waiter、清理 MCP client state；随后并行关闭这些 room 下的 agent session。关闭 Council agent session 时，runtime 会先尝试 native TUI/tmux close；如果不是 native TUI/tmux session，再走 structured lifecycle adapter 的 destroySession。这保证 Council Claude/Gemini 的 `tui_mux` session、以及 Codex/OpenCode native local server session 都走各自真实的 runtime close 路径。

Terminal runtime 退出时会并行关闭当前进程内管理的 tmux session，然后扫描并清理未被当前 daemon 管理的 `rah-*` tmux session。Codex/OpenCode native local server 启动时会注入 `RAH_NATIVE_SERVER_OWNER=rah`、`RAH_NATIVE_SERVER_PROVIDER=codex|opencode`、`RAH_NATIVE_SERVER_DAEMON_PID=<pid>`，因此 orphan janitor 只清理 RAH 明确拥有的 provider server，不会按进程名误杀用户自己启动的 Codex/OpenCode。

崩溃、断电、`SIGKILL` 不能执行退出钩子，所以不可能只靠 shutdown 做绝对保证。下一次 daemon 启动时会先恢复仍可重新接管的 `tui_mux` running session，然后运行 startup orphan janitor：

- 清理仍带 RAH native server 标记的 Codex/OpenCode 孤儿进程。
- 清理没有被当前 daemon 管理的 `rah-*` tmux session。
- reconcile Council 持久化状态：running room 如果没有 live agent，会被标记 stopped；running room 中已经没有 live terminal 的 recoverable agent，也会被标记 stopped。

这个机制的非目标也很明确：浏览器/Web/PWA client 断开只 detach，不关闭 session；RAH 不清理没有 RAH env 标记的外部 provider 进程，也不能保证旧版本未打标的 provider server 会被识别；OS hard-kill 或 provider 拒绝退出时，只能通过下一次启动的 janitor 尽量收敛。

## 7. 历史浏览与同步边界

RAH 明确区分两件事：

- `refreshLatestHistory`：静默同步当前 session 的最新 tail，用于 live Chat 补齐 focus/reload/PWA 切后台期间错过的消息。
- `loadOlderHistory`：加载更早历史页，用于 read-only replay 首屏和用户向上翻旧历史。

新建 running session 不应触发可见的 older-history 加载，也不应在 Chat 顶部显示 `Loading older history`。创建后 feed 可以先为空，再由 optimistic user message、Codex/OpenCode native server event、Claude/Gemini transcript mirror 或静默 latest-tail sync 填充。

选中已有 running session 时可以触发一次静默 latest-tail sync，但它不是历史翻页：

- 不设置 `history.phase = "loading"`。
- 不显示 `Loading older history`。
- 不改变 scroll anchor 语义。
- 只能 merge/upsert 当前 tail，不能把 live feed 重新排序成另一套历史窗口。

只有 read-only replay 或用户向上滚动接近顶部时，才进入 older-history paging：

1. 当前前端页大小为 `250` 个 RAH events。
2. 前端用 `nextCursor` 或 `nextBeforeTs` 拉更早一页。
3. 新页面 prepend 到 feed 前面，并通过 scroll anchor 保持当前阅读位置。
4. 如果内容不足一屏，前端会继续自动加载更早历史直到填满或没有下一页。

后端由 `HistorySnapshotStore` 冻结一次浏览快照：

- 首屏冻结 provider 历史 revision。
- 后续 cursor 只能在同一个 frozen snapshot 内翻页。
- claim/resume 后不会把新 live 内容污染进当前历史快照。

硬约束：

- live/native-mirror event 不能被 history bootstrap 挡住。
- Codex/OpenCode Chat 的当前回复优先来自 native local-server event/client push，不依赖 rollout/SQLite 全量回读。
- Claude/Gemini fallback Chat 的当前回复优先来自 provider transcript mirror，不从 ANSI 屏幕解析主内容。
- provider history 文件/DB 是 backfill 和 read-only history 的依据，不是新 live turn 的唯一实时来源。

各 provider 的底层分页实现和前端函数边界见 [历史浏览与分页边界](./history-browsing.zh-CN.md)。

## 8. Stop / Close 语义

Stop 在 RAH 里的实际语义是“断掉 runtime 管理的 running 执行体”，不是删除 provider 历史，也不是把历史移入回收站。

| Session 类型 | Stop/Close 行为 |
| --- | --- |
| Native local-server running | 关闭 RAH 管理的 provider server client / optional TUI client，session 变为 `stopped`，provider 原始历史仍保留 |
| TUI mux fallback running | 显式关闭 RAH 管理的 tmux/TUI pane，session 变为 `stopped`，provider 原始历史仍保留 |
| Read-only replay | 只关闭 RAH UI projection，不删除 provider 原始历史 |
| Structured test running | 关闭 injected provider adapter client，session 变为 `stopped` |

删除历史是另一类动作，应走 provider stored session remove/trash 语义，不应混进 Stop。

## 9. Running / Stopped 边界

RAH 判断 session 或 Council room 是否 `running` 时按执行体和 owner 区分：

- 有 RAH 管理绑定：running。
- 有 RAH 管理的 native local server session 或 tmux/TUI mux session：running，即使当前没有 attached client。
- provider 历史文件有外部活跃写手：external live。
- 只是 Web 打开历史读取文件：不算 running。
- 无 RAH 管理写手、无活跃外部写手、文件稳定：stopped history / read-only replay。

Codex pending tool 收口的细节见 [Codex 历史 liveness 与 pending tool 收口边界](./codex-history-liveness.zh-CN.md)。

## 10. UI 状态边界

左侧 sidebar 的状态含义：

- `ready`：running 但空闲。
- `unread`：running 或历史 projection 有未读更新。
- `waiting_permission`：running turn 等待用户批准。
- `working`：running turn 正在执行。

这些是 session/room 的展示状态，不是 `running/stopped` 判定条件。`running/stopped` 的边界来自 RAH runtime ownership / provider write liveness。

Stop 按钮语义：

- 用作 working 状态提示。
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
- 当前阶段是 Timeline Identity v2 的 MVP：协议、daemon 透传、前端 upsert、core provider 的 native/derived identity 已具备。后续如果继续增强，应在 daemon 侧增加 epoch/seq ledger 做 replay/gap/catch-up，而不是把 text/time window 重新变成主逻辑。

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

`restart` 会停止当前 managed daemon，再用当前 checkout 的源码启动新 daemon。它会中断当前由 daemon 管理的 running TUIs（例如 `rah codex`、`rah claude`、`rah opencode`），因为旧 daemon 会被关闭。`start` 只保证 daemon 正在运行；如果旧 daemon 已经 ready，它不会替换成新代码。普通代码更新不需要 `npm install`。

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
npm run test:provider-contracts
npm run test:runtime
npm run build:web
npm run test:smoke:native-browser
npm run test:smoke:native-browser-webkit
git diff --check
```

Provider browser smoke 依赖本机 CLI、账号状态和额度，只应在已配置完整的机器上运行。当前主链路优先使用 native local server probe 验证 Codex/OpenCode 的 provider-server 能力，再用 browser smoke 验证 UI：

```bash
npm run test:smoke:native-local-server
npm run test:smoke:native-browser
npm run test:smoke:native-browser-webkit
```

`test:smoke:native-browser` 是默认浏览器 smoke，会用 deterministic fake provider 跑 Codex、Claude、OpenCode 的 Chat/TUI/replay/stop/foreground recovery/Web resume 关键路径，并保存 Chat mirror、Web TUI、reload replay、Web resume history 截图。它会断言 Chat 中问题在回答之前、回答不重复、新 running session 不显示 `Loading older history` / `Unhandled provider event` 噪声、Stop 出现后可回到 idle、TUI dirty prompt 不会误注入 Chat 文本。旧的 `test:smoke:codex-browser`、`test:smoke:claude-browser`、`test:smoke:opencode-browser` 仍可作为真实 provider smoke 辅助；需要一次性跑真实三家时使用 `test:smoke:real-browser-providers`。Gemini 当前有 launch/history 单元回归，真实 CLI smoke 仍需补齐后才能进入默认 gate。Kimi CLI smoke 已删除，不属于默认 gate。

`npm run serve:workbench`、`npm run dev:daemon`、`npm run dev:web` 仅用于前台调试或拆分调试。Provider smoke 不是所有机器默认门禁。

## 13. 维护检查清单

改 session/control/history/provider 行为时，至少检查：

- Web new / Web claim / Canvas new 是否按 provider runtime 进入 Codex/OpenCode native local server 或 Claude/Gemini tmux/TUI mux fallback。
- Codex/OpenCode Chat 输入是否走 provider structured control；Claude/Gemini fallback Chat 输入是否只在 TUI prompt clean 时注入，prompt dirty / agent busy 时必须阻止误注入。
- `rah xxx` 是否能出现在左侧 running session。
- Web 接管是否能 single-writer 发送、结束、恢复 idle。
- Stop/Close 是否能关闭对应 running 执行体。
- Detach / reload / hide canvas 是否不会关闭真实 TUI。
- 历史打开是否先显示 tail，并能上滚到第一条用户消息。
- Chat mirror 是否来自 provider 原厂 history/db 文件，Markdown 换行、列表、代码块是否保留且不重复。
- interrupted/aborted turn 是否不会留下永久 Running tool。
- Enhanced controls 是否保持 optional；native TUI 不应暴露假的 RAH-managed plan/access/model 控制。
- iOS / iPad / desktop 的 composer、safe-area、sidebar 状态是否正常，且所有用户可见生命周期文案统一使用 running/stopped。

## 14. 非目标

当前不做：

- 云端多用户服务。
- provider 历史文件跨机器同步。
- Web 直接接管用户未通过 RAH 启动的野生 TUI。
- 在同一个真实 TUI 中同步未提交草稿和光标。
- 为每个 provider 原生 UI 状态做像素级镜像。
