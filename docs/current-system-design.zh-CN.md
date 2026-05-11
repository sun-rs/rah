# RAH 当前系统设计总览

本文记录当前已经锁定的 RAH 系统设计，作为后续维护和接入新 provider 的主参考。细节文档见 [docs 索引](./README.md)。

## 1. 项目定位

RAH 是一个本地优先的 AI 工作台。它不是要替所有 CLI 重写完整 Web agent，而是让 live session 由本机 daemon 持有，并让桌面 Terminal、Web、PWA、iPad/iPhone、Canvas pane 能接入同一个 provider session。

当前 `refactor/native-local-server-core` 分支把 live 主线拆成 provider runtime：

- Codex / OpenCode 默认走 `native_local_server`，RAH 通过 provider 官方本地 server 获取结构化 live event、发送 turn、执行 interrupt/archive。
- Codex / OpenCode 的本地 TUI 是 provider 官方 client/view，例如 Codex `codex --remote ... resume <threadId>`、OpenCode `opencode attach ... --session <id>`。
- Claude 默认走 `tui_mux_fallback`，zellij/TUI mux 负责原生 TUI 工作现场，结构化 Chat 来自 Claude 原厂 JSONL mirror。
- Web/PWA 只有显式打开 `TUI` 视图才 claim TUI display surface；普通 Chat 浏览不应触发 TUI attach。

当前 live 主线收敛为三家 provider：

- Codex
- Claude
- OpenCode

Gemini/Kimi CLI 一等 provider 代码已移除，不再作为 live、history-only、diagnostics 或默认 QA 对象。Kimi、GLM、MiniMax、Gemini、Grok、DeepSeek 等低频 API-key 模型优先通过 OpenCode + API provider / 中转站承载。

当前核心目标：

- 本机 daemon 统一持有 provider runtime、事件、控制权和 provider launch/mirror adapter。
- Codex/OpenCode 的 live truth 是 provider native local server event；Claude fallback 的现场连续性由 zellij/TUI mux 维持。
- 结构化 Chat/Timeline 来自 provider server event 与原厂 jsonl/db/session history mirror，不从 ANSI/TUI 输出反推。
- Web UI 只消费 RAH canonical protocol，不直接依赖 provider-native 事件。
- `rah codex/opencode`、Web New、Canvas New、Web Claim History 对 Codex/OpenCode 默认进入 native local server runtime；`rah claude` 和 Claude Web live 默认进入 zellij/TUI mux fallback。旧 structured live adapter 仅作为显式 legacy/enhancement 路径保留。
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
- `ZellijMuxBackend`
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
| Native local server live | daemon 启动并持有 provider 官方本地 server session；Codex/OpenCode 默认走该路径 | 可以，走 provider structured control | 显式 close/archive 才关闭或解除 RAH 管理 | provider server event + provider history backfill |
| TUI mux fallback live | daemon 启动并持有真实 provider TUI；Claude 默认走 zellij mux | 可以，但需要 control/surface lease | 显式 close/archive 才关闭 TUI/zellij pane | provider history mirror + TUI diagnostics |
| Read-only replay | 打开 provider 历史形成的只读 projection | 不可以，需 claim | 只关闭 UI projection | provider history |
| Legacy structured live | 旧测试/调试路径；公开 HTTP API 拒绝 `liveBackend: "structured"`，普通 daemon 不构造 legacy structured adapters，只允许测试注入 adapter 直接调用 engine | 可以 | 关闭 provider adapter client | provider SDK/API event + history |

Legacy structured 的保留决策：

- 保留它作为内部测试/兼容 harness，而不是生产 live 主链路。
- 普通 daemon 不构造 legacy structured adapters。
- 公开 Web/CLI/canvas live 入口只进入 provider runtime descriptor 声明的主路径：Codex/OpenCode 是 native local server，Claude 是 zellij/TUI mux fallback。
- 旧 wrapper-control / terminal handoff runtime 已删除，不再作为测试或兼容面存在。

重要边界：

- 只要 provider session 被 daemon-owned native TUI runtime 拉起，就是 live；没有 client attach 时也仍然 live。
- `ready`、`unread`、`approval`、`thinking` 都属于 live 的 UI 状态，不是是否 live 的边界。
- 只读打开历史不算 live，也不算写手。
- Web `claim/resume` 默认把 provider history 升级成 daemon-owned native TUI live session；只读浏览不触发 resume。
- client detach、浏览器 reload、PWA 切后台只应影响 attach 状态，不能隐式 close/archive/kill session。

## 5. Provider 当前实现

| Provider | 默认 live path | Launch/resume spec | Structured source | 增强控制边界 |
| --- | --- | --- | --- | --- |
| Codex | native local server | `codex app-server` + `codex --remote <endpoint> resume <threadId>` | app-server event + rollout/session backfill | model/mode/runtime config 按 Codex app-server 能力开放 |
| Claude | zellij/TUI mux fallback | `claude --session-id <uuid>` / `claude --resume <id>` inside zellij | `~/.claude/projects/**/*.jsonl` | permission/model/effort 作为启动参数增强；运行中以原生 TUI 为准 |
| OpenCode | native local server | OpenCode serve/session + `opencode attach <url> --session <id>` | OpenCode server/session event + SQLite backfill | model/permission/variant 按 OpenCode API/ACP 能力开放 |

默认权限策略见 [Session 入口与权限边界](./session-entry-capability-boundary.zh-CN.md)。当前默认统一偏向低摩擦最大权限：

- Codex：`never/danger-full-access`
- Claude：`bypassPermissions`
- OpenCode：`opencode/full-auto`

这些默认值由 adapter 的 `ProviderModelCatalog.defaultModeId` 提供。前端只传 RAH 标准 `modeId`，daemon 在 native TUI launch spec 中尽量翻译为 provider 启动参数。启动增强失败或 provider 语义变化不应影响 PTY core 的产品边界；用户始终可以切到原生 TUI 使用官方 `/permission`、`/model`、`/plan`、`/goal` 等能力。具体映射见 [Provider Adapter 协议与能力边界](./provider-adapter-protocol.zh-CN.md)。

`SessionModeDescriptor.role` 是 UI 的稳定语义层：

- `ask`
- `auto_edit`
- `full_auto`
- `plan`
- `custom`

Provider 原生 mode id 仍可作为 `id` 保留，但前端只用 `role` 做稳定展示。比如 Codex `on-request/read-only` 的 role 是 `ask`，不应在 UI 上被解释成绝对“只读”。

`SessionModeDescriptor.applyTiming` 是 mode 的应用时机语义层，用来区分 `immediate`、`next_turn`、`idle_only`、`restart_required`、`startup_only`。在当前 provider runtime 范围内，Codex/OpenCode 的 mode 多数是下一 turn 或 native local server/ACP 边界生效；Claude 以官方 TUI/CLI 当前能力为准。

## 6. Native Server / Zellij Attach 原则

Native local server 与 zellij attach 的目标是：

- Codex/OpenCode 的 provider session 始终由 daemon 管理的 native local server 持有；本地 TUI 和 Web 都是 client/view。
- Claude 的真实 provider TUI 始终运行在 daemon 管理的 zellij session/pane 中；本地终端、Web terminal、PWA/iPad/iPhone、Canvas pane 都只是 attach client。
- `rah xxx` 默认不再拥有 provider 进程生命周期；它请求 daemon 创建/resume live session，然后按 provider runtime 接入 official client 或 zellij mux。
- 桌面 terminal 断开只 detach，不杀 session；显式 close/archive 才关闭或解除 RAH 管理。
- Web UI 可以立即看到 live session，并在 reload/focus 后通过 provider event/history 或 zellij replay 追上。

当前锁定原则：

- single-writer：任意时刻只有一个 client 拥有 control lease。
- single-display-surface：zellij TUI display surface 需要显式 claim。Web/PWA 只有进入 `TUI` 视图才 claim；Chat 发问和 Stop 不 claim display surface。
- 不同步 draft：只同步已提交 turn，不同步光标、未提交草稿、选区、slash menu。
- transcript 主要来自 provider history 文件/数据库，不从屏幕画面解析主内容。
- terminal 画面是用户体验 surface，不是 canonical data source。
- Codex/OpenCode Chat composer 走 provider structured control，不通过键盘注入普通 turn。
- Claude fallback Chat composer 是 TUI 文本注入桥；如果 TUI prompt dirty，应排队或阻止注入，避免污染用户正在 TUI 里编辑的草稿。
- Archive/Close 必须关闭 provider native server session 或 Claude 对应 zellij session，避免孤儿 runtime。

当前不承诺：

- 在原生 TUI 内部 `/new` / `/resume` 后所有 provider 都能自动 rebind。
- 多客户端同时双写。
- Web 对 native TUI session 动态修改所有 provider 私有权限/模型/plan 状态。
- structured mirror 100% 覆盖 provider 新增的私有 UI 功能；mirror missing/failed 只进入 diagnostics，不影响 TUI live。

## 7. 历史浏览与同步边界

RAH 明确区分两件事：

- `refreshLatestHistory`：静默同步当前 session 的最新 tail，用于 live Chat 补齐 focus/reload/PWA 切后台期间错过的消息。
- `loadOlderHistory`：加载更早历史页，用于 read-only replay 首屏和用户向上翻旧历史。

新建 live session 不应触发可见的 older-history 加载，也不应在 Chat 顶部显示 `Loading older history`。创建后 feed 可以先为空，再由 optimistic user message、Codex/OpenCode native server event、Claude transcript mirror 或静默 latest-tail sync 填充。

选中已有 live session 时可以触发一次静默 latest-tail sync，但它不是历史翻页：

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
- Claude fallback Chat 的当前回复优先来自 provider transcript mirror，不从 ANSI 屏幕解析主内容。
- provider history 文件/DB 是 backfill 和 read-only history 的依据，不是新 live turn 的唯一实时来源。

各 provider 的底层分页实现和前端函数边界见 [历史浏览与分页边界](./history-browsing.zh-CN.md)。

## 8. Archive / Close 语义

Archive 在 RAH 里的实际语义是“断掉 runtime 管理的 live 执行体”，不是删除 provider 历史。

| Session 类型 | Archive/Close 行为 |
| --- | --- |
| Native local-server live | 关闭 RAH 管理的 provider server client / optional TUI client，session 从 live list 消失，provider 原始历史仍保留 |
| TUI mux fallback live | 显式关闭 RAH 管理的 zellij/TUI pane，session 从 live list 消失，provider 原始历史仍保留 |
| Read-only replay | 只关闭 RAH UI projection，不删除 provider 原始历史 |
| Legacy structured live | 关闭 provider adapter client，session 从 live list 消失 |

删除历史是另一类动作，应走 provider stored session remove/trash 语义，不应混进 Archive。

## 9. Liveness 边界

RAH 判断 session 是否 live 时按写手和 owner 区分：

- 有 RAH 管理绑定：live。
- 有 RAH 管理的 native local server session 或 zellij/TUI mux session：live，即使当前没有 attached client。
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

这些是 session 的展示状态，不是 live 判定条件。live 的边界来自 RAH runtime ownership / provider write liveness。

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

`restart` 会停止当前 managed daemon，再用当前 checkout 的源码启动新 daemon。它会中断当前由 daemon 管理的 core live TUIs（例如 `rah codex`、`rah claude`、`rah opencode`），因为旧 daemon 会被关闭。`start` 只保证 daemon 正在运行；如果旧 daemon 已经 ready，它不会替换成新代码。普通代码更新不需要 `npm install`。

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

`test:smoke:native-browser` 是默认浏览器 smoke，会用 deterministic fake provider 跑 Codex、Claude、OpenCode 的 Chat/TUI/replay/stop/foreground recovery/Web resume 关键路径，并保存 Chat mirror、Web TUI、reload replay、Web resume history 截图。它会断言 Chat 中问题在回答之前、回答不重复、新 live session 不显示 `Loading older history` / `Unhandled provider event` 噪声、Stop 出现后可回到 idle、TUI dirty prompt 不会误注入 Chat 文本。旧的 `test:smoke:codex-browser`、`test:smoke:claude-browser`、`test:smoke:opencode-browser` 仍可作为真实 provider smoke 辅助；需要一次性跑真实三家时使用 `test:smoke:real-browser-providers`。它们不替代 native local server probe 和当前 browser smoke。Gemini/Kimi CLI smoke 已删除，不属于默认 gate。

`npm run serve:workbench`、`npm run dev:daemon`、`npm run dev:web` 仅用于前台调试或拆分调试。Provider smoke 不是所有机器默认门禁。

## 13. 维护检查清单

改 session/control/history/provider 行为时，至少检查：

- Web new / Web claim / Canvas new 是否按 provider runtime 进入 Codex/OpenCode native local server 或 Claude zellij/TUI mux fallback。
- Codex/OpenCode Chat 输入是否走 provider structured control；Claude fallback Chat 输入是否只在 TUI prompt clean 时注入，prompt dirty / agent busy 时必须阻止误注入。
- `rah xxx` 是否能出现在左侧 live session。
- Web 接管是否能 single-writer 发送、结束、恢复 idle。
- Archive 是否能关闭对应 live 执行体。
- Detach / reload / hide canvas 是否不会关闭真实 TUI。
- 历史打开是否先显示 tail，并能上滚到第一条用户消息。
- Chat mirror 是否来自 provider 原厂 history/db 文件，Markdown 换行、列表、代码块是否保留且不重复。
- interrupted/aborted turn 是否不会留下永久 Running tool。
- Enhanced controls 是否保持 optional；native TUI 不应暴露假的 RAH-managed plan/access/model 控制。
- iOS / iPad / desktop 的 composer、safe-area、sidebar 状态是否正常。

## 14. 非目标

当前不做：

- 云端多用户服务。
- provider 历史文件跨机器同步。
- Web 直接接管用户未通过 RAH 启动的野生 TUI。
- 在同一个真实 TUI 中同步未提交草稿和光标。
- 为每个 provider 原生 UI 状态做像素级镜像。
