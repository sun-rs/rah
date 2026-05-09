# RAH Council Integration Goal Guide

Date: 2026-05-09

本文档用于给后续 `/goal` 提供压缩后的执行依据。目标不是把 `agent-council` Python 项目搬进 RAH，而是吸收它的协议与协作模型，在 RAH 内实现一个插件式 Council 功能，同时先恢复 RAH 自身启动前模型/权限配置能力。

## 0. 给 `/goal` 的短指令

后续可以直接使用类似下面的 `/goal`：

```text
请读取 RAH_COUNCIL_INTEGRATION_GOAL_GUIDE.zh-CN.md，并按文档推进：
1. 先恢复 Codex/Claude/OpenCode 的启动前模型、模型参数、权限模式 catalog 与 Web UI 配置能力；
2. live session 拉起后不提供模型/权限热切换，改由原生 TUI 自己处理；
3. 再以插件式方式实现 RAH Council MVP，不引入 agent-council 的 Python runtime，只移植协议思想；
4. 保持 PTY/zellij/native TUI 主线，不破坏现有单 session 工作流；
5. 每阶段都补测试并保证 typecheck/test/build 通过。
```

## 1. 总目标

RAH 的核心定位保持不变：

- RAH 把持或管理原生 TUI session，让桌面 terminal、Web、PWA 都能观察/接续同一工作现场。
- Web chat 友好展示来自 provider 原生历史文件/DB 或 RAH 自己的结构化事件，而不是依赖屏幕 OCR/文本抓取。
- 一等 provider 收敛为 Codex、Claude Code、OpenCode。
- OpenCode 作为 API-key 聚合入口，承接 Gemini、Kimi、DeepSeek、GLM、Grok 等非主力订阅模型。

在这个基础上新增 Council：

- Council 是 RAH 的独立页面/功能模块，类似插件。
- 一个 Council room 中有多个 agent。
- 每个 agent 是一个 Codex/Claude/OpenCode 原生 TUI pane/window。
- Council 主界面是多人 chat，每个气泡标明 actor/provider/model。
- 点击某个 agent 可以查看该 agent 对应的 zellij TUI。
- 启动 Council 时通过 RAH Web 配置 agent、模型、参数、权限，不再手写 TOML。

## 2. 明确不做

- 不引入 `agent-council` 的 Python runtime、Python broker、Python viewer、Python MCP shim。
- 不长期保留独立 `ws://127.0.0.1:9100` broker。
- 不把 Council 深度塞进现有单 session core，避免未来无法移除。
- 不恢复 Gemini/Kimi CLI 一等 provider。
- 不在 live TUI session 启动后假装能可靠热切模型/权限/plan。
- 不通过 zellij/TUI 屏幕内容解析 Council 聊天消息。

## 3. 第一阶段：恢复 RAH 启动前模型/权限配置能力

这是 Council 的前置能力，也会修复当前普通 Web new/resume 的退化。

### 3.1 当前问题

当前 zellij 分支里协议和 launch spec 仍保留了能力：

- `StartSessionRequest` / `ResumeSessionRequest` 仍有 `model`、`optionValues`、`reasoningId`、`modeId`。
- `native-tui-launch-spec.ts` 已经能把部分 `model/modeId/optionValues` 转为 CLI 启动参数。
- 前端也存在 `SessionModelControls`、`SessionModeControls`、`session-mode-ui`。

但默认 adapter 注册只剩 stored history：

- `createDefaultProviderAdapters()` 当前主要注册 `CodexStoredHistoryAdapter`、`ClaudeStoredHistoryAdapter`、`OpenCodeStoredHistoryAdapter`。
- Codex/Claude/OpenCode 的 model catalog adapter 没有作为只读能力注册。
- 结果 `listProviderModels()` 大多只能返回 fallback/空 catalog，UI 上模型/参数/权限能力不可用或不完整。

### 3.2 目标边界

模型/权限只作为启动前配置：

- `new session` composer 可选 provider/model/model options/permission mode。
- `history session -> claim/resume` 前可选 model/model options/permission mode。
- session 启动后不显示可热切的 session control。
- live 后用户要改模型/权限/plan，使用原生 TUI 自己的 `/model`、`/permissions`、`shift+tab`、菜单或配置。
- RAH 可以显示 launched config，但不承诺实时追踪 TUI 内部后来改成什么。

### 3.3 权限模式协议

不要用纯顶层 enum 反向翻译 provider 参数。使用 provider-native opaque id + UI role：

```ts
type LaunchModeDescriptor = {
  id: string; // provider-native opaque id, e.g. "never/danger-full-access"
  label: string;
  description?: string;
  role?: "ask" | "auto_edit" | "full_auto" | "plan" | "custom";
  source: "native_help" | "native_config" | "static_fallback";
  applyTiming: "startup_only";
};
```

原则：

- 前端只展示 `label/role`，提交时原样回传 `id`。
- daemon/provider catalog 负责把 `modeId` 翻译成 CLI argv/env/config。
- `role` 只用于 UI 分组、图标和默认选择，不作为真实协议翻译来源。
- 如果能从 native help/config 探测权限列表，就优先使用探测结果。
- 如果探测不到，使用 static fallback，并在 catalog 标记 `source: "static_fallback"` 或等价信息。

### 3.4 三家 provider 的启动前能力

Codex：

- 模型 catalog 走 `codex app-server` / JSON-RPC `model/list`。
- 模型参数使用 `model_reasoning_effort`。
- 权限启动参数：
  - `--ask-for-approval <policy>`
  - `--sandbox <mode>`
  - `--dangerously-bypass-approvals-and-sandbox`
- `plan` 不应作为启动前强保证，除非能被 CLI 官方启动参数稳定支持；否则不要在启动前 catalog 暴露为可预设。

Claude：

- 模型 catalog 走 Claude SDK `supportedModels()`，失败时 fallback 到内置模型列表。
- 模型参数使用 `effort`。
- 权限启动参数：
  - `--permission-mode <mode>`
  - `--dangerously-skip-permissions` for `bypassPermissions`
- 启动前可选，启动后交给 TUI。

OpenCode：

- 模型 catalog 走 OpenCode server `/config`、`/config/providers`。
- 模型格式通常是 `provider/model`。
- variant 参数使用 `model_reasoning_variant`，启动时必须正确传给 OpenCode：
  - 如果 OpenCode CLI 支持 `--variant`，用 `--variant <id>`。
  - 如果 OpenCode 需要组合 model id，如 `provider/model/variant`，用 catalog adapter 统一生成。
- 权限模式可能更多依赖 OpenCode config/env；由 OpenCode catalog adapter 生成可用 launch mode。
- 不在 live 后承诺 Web 热切。

### 3.5 实施建议

新增只读 catalog adapters，而不是恢复旧 structured live：

```text
packages/runtime-daemon/src/provider-catalog-adapter.ts
packages/runtime-daemon/src/codex-catalog-adapter.ts
packages/runtime-daemon/src/claude-catalog-adapter.ts
packages/runtime-daemon/src/opencode-catalog-adapter.ts
```

或用一个轻量 adapter：

```text
NativeTuiCatalogAdapter
  providers: ["codex", "claude", "opencode"]
  listModels(provider/cwd/forceRefresh)
```

但更推荐每家一个 adapter，职责更清楚。

必须复用已有 catalog 文件：

- `packages/runtime-daemon/src/codex-model-catalog.ts`
- `packages/runtime-daemon/src/claude-model-catalog.ts`
- `packages/runtime-daemon/src/opencode-model-catalog.ts`
- `packages/runtime-daemon/src/session-mode-utils.ts`
- `packages/runtime-daemon/src/session-model-options.ts`

`createDefaultProviderAdapters()` 应注册：

- Debug adapter
- Codex/Claude/OpenCode stored history adapters
- Codex/Claude/OpenCode catalog adapters

不要注册旧 structured lifecycle adapter 作为默认 live 路径。

### 3.6 Launch spec 必须消费配置

`native-tui-launch-spec.ts` 需要保证：

- Codex `model`、`optionValues.model_reasoning_effort`、`modeId` 全部进入 argv。
- Claude `model`、`optionValues.effort`、`modeId` 全部进入 argv。
- OpenCode `model`、`optionValues.model_reasoning_variant`、`modeId` 全部进入 argv/env/config。
- `reasoningId` 仅作为兼容 alias，优先使用 `optionValues`。

session 启动后的 `ManagedSession` 应记录：

- `model.currentModelId`
- `model.currentReasoningId`
- `config.values`
- `mode.currentModeId`
- `mode.mutable = false`
- `mode.source = "external_locked"` 或新增更精确的 `"startup_locked"`（如果改协议成本低）

capabilities 应避免误导：

- `modelSwitch: false`
- `planMode: false`
- live 后不显示 session control 热切按钮。

### 3.7 UI 要求

普通 new session composer：

- 显示 provider、workspace、access mode、model/params。
- 从 `listProviderModels(provider,cwd)` 获取 catalog。
- 默认权限选择全权限/最大可用权限，除非用户有本地记忆。
- 默认模型使用上次该 provider 选择；没有记忆则用 catalog 默认或第一项。
- 模型参数默认使用该模型最强/最大选项，除非 catalog 给出明确 default 且产品决定尊重 default。

history/resume/claim：

- claim 前显示同样的 access/model 控制。
- 选择后通过 `ResumeSessionRequest` 传给 daemon。

live session：

- 不显示模型/权限/plan 可调控件。
- 可显示只读 launched config 摘要。
- TUI 页面仍可操作原生命令。

## 4. 第二阶段：RAH Council 插件式 MVP

### 4.1 模块边界

建议新增独立目录：

```text
packages/runtime-protocol/src/council.ts
packages/runtime-daemon/src/council/
packages/client-web/src/council/
```

尽量不改现有 session core。必要接入点只包括：

- HTTP API 路由注册。
- EventBus 增加 `council.*` 事件。
- zellij mux runtime 复用。
- provider catalog 复用。
- provider native TUI launch spec 复用。

未来移除 Council 时，应能删除 `council/*` 和少量路由/导航入口。

### 4.2 Council 数据模型

核心类型：

```ts
type CouncilRoom = {
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  status: "starting" | "running" | "idle" | "stopped" | "failed";
  zellijSessionName?: string;
};

type CouncilAgent = {
  id: string;          // stable actor id, e.g. "claude-reviewer"
  roomId: string;
  provider: "codex" | "claude" | "opencode";
  label: string;
  role?: string;
  modelId?: string;
  optionValues?: Record<string, SessionConfigValue>;
  modeId?: string;
  status: "starting" | "waiting" | "thinking" | "idle" | "blocked" | "failed" | "stopped";
  zellijPaneId?: string;
  nativeSessionId?: string;
};

type CouncilMessage = {
  id: number;
  roomId: string;
  actorId: string;     // "user", "system", or agent id
  role: "user" | "agent" | "system";
  parts: Array<{ kind: "text"; text: string } | { kind: "data"; data: unknown }>;
  replyTo?: number;
  createdAt: string;
};
```

可后续扩展：

- file claims
- tasks
- handoff/verdict
- agent status heartbeat
- git jobs

### 4.3 持久化

MVP 建议使用 SQLite 或 RAH home 下独立 JSONL/SQLite。优先 SQLite：

```text
~/.rah/council/rooms.sqlite
```

理由：

- agent-council 已证明 SQLite 很适合 room message log。
- Council message 需要分页、按 room 查询、按 seq replay。
- 不应该混进 provider 原生 session 文件。

但实现上保持封装：

```text
CouncilStore
  createRoom()
  listRooms()
  appendMessage()
  fetchMessages()
  updateAgentStatus()
  stopRoom()
```

这样未来替换存储不影响 UI。

### 4.4 Council runtime

`CouncilRuntime` 负责：

- 创建 room。
- 根据 UI 配置创建多个 agent。
- 为每个 agent 创建 zellij pane/window。
- 生成每个 agent 的 MCP server 配置。
- 注入 bootstrap prompt。
- 接收 MCP tool 发来的 `join/post/wait/status`。
- 把 `CouncilMessage` 转成 `council.message.created` event。
- archive/stop 时关闭 zellij session 和所有 panes。

不要让 Council runtime 依赖 Python。

### 4.5 MCP shim

需要 TypeScript/Node 原生 MCP stdio server，提供 agent-council 的核心工具子集。

MVP 工具：

- `channel_join(room)`
- `channel_post(content, room, reply_to?)`
- `channel_wait_new(room, timeout_s)`
- `channel_history(room, limit, since_id?)`
- `channel_set_status(phase, detail?)`

第二阶段工具：

- `channel_claim_file(path)`
- `channel_release_file(path)`
- `channel_list_claims()`
- `channel_task_create/update/get/list/handoff/verdict`

MCP shim 应作为 RAH bin 的子命令：

```text
rah council-mcp --room <roomId> --actor <actorId> --daemon http://127.0.0.1:43111
```

各 provider 的 MCP 配置指向这个命令，而不是 Python `uv run ...`。

### 4.6 zellij 布局

一个 Council room 对应一个 zellij session：

```text
rah-council-<room-short-id>
```

每个 agent 对应一个 pane 或 window：

- MVP：一个 zellij session，多 pane，pane title = actor id。
- 如果 Web TUI 显示/attach 更适合 window，可后续改成每 agent 一个 tab/window。

不要和普通单 session zellij session 混用，避免生命周期打架。

### 4.7 Provider launch

每个 agent 的启动命令必须复用 RAH 的启动前配置能力：

- provider catalog 选出来的 `modelId`
- `optionValues`
- `modeId`
- workspace
- MCP server config/env
- bootstrap prompt

Codex/Claude/OpenCode 统一走 native TUI launch spec，但需要支持“额外 MCP 配置”：

```ts
type NativeTuiLaunchSpecRequest = {
  provider: ProviderKind;
  cwd: string;
  model?: string;
  optionValues?: Record<string, SessionConfigValue>;
  modeId?: string;
  extraMcpServers?: MpcServerSpec[];
  title?: string;
};
```

不要复制一套 provider 启动逻辑到 Council。

### 4.8 Council Web UI

新增入口：

- 左侧边栏或顶部增加 `Council` 页面入口。
- 页面独立于普通 session/canvas。

页面结构：

- Room list / recent council rooms。
- Start Council 按钮。
- Start modal：
  - workspace
  - room title
  - agents list
  - add agent
  - provider selector
  - actor alias
  - role prompt
  - model selector
  - model params
  - permission mode
- Main view：
  - central chat timeline
  - message bubbles show actor/provider/model/role
  - right side agent roster/status
  - per-agent TUI button
  - stop/archive room

MVP 不需要复杂 task board，但数据模型要预留。

### 4.9 Council chat 真相来源

Council chat 的真相来源是 `CouncilMessage` log：

- 用户在 Council 页面发言 -> append message actor=`user`。
- Agent 通过 MCP `channel_post` 发言 -> append message actor=`agentId`。
- 系统事件 -> append message actor=`system`。

不要从 provider history 文件或 zellij screen 解析 Council chat。

每个 agent 的 provider 原生 session history 仍可以作为 debug/detail：

- 点击 agent TUI 看它的原生 TUI。
- 后续可关联该 agent 的 providerSessionId。
- 但 Council 多人 chat 不依赖 provider history mirror。

### 4.10 与普通 session 的关系

Council agent 不一定要暴露成普通 RAH live session。

MVP 可只在 Council runtime 内管理 agent panes。

如果要复用现有 TUI surface：

- 可以把每个 agent pane 包成一个 internal native TUI entry。
- 但不要让它污染普通 Sessions list，除非用户明确打开 agent detail。

建议：

- Council room 在 Council 页面展示。
- Agent TUI pane 只在 Council 页面内部切换。
- 普通 Session History 不显示 Council 内部 agent session，除非后续设计“导出/打开 agent session”。

## 5. 与 agent-council 的可吸收部分

只吸收理念/协议，不搬 Python。

可吸收：

- A2A-ish message shape：`role + parts + messageId + reply_to`
- room message log
- actor/client id
- `channel_join/post/wait_new/history/state`
- file claims
- tasks/handoff/verdict
- status heartbeat
- bootstrap prompt 思路

不吸收：

- Python broker
- Python viewer
- Python MCP shim
- tmux launcher
- 独立 web/index.html
- Gemini/Kimi CLI profiles
- TOML 作为主要配置入口

## 6. 测试要求

第一阶段必须补：

- `listProviderModels` 对 Codex/Claude/OpenCode 能返回 catalog。
- catalog 包含 modes 和 modelProfiles。
- native TUI launch spec 正确消费：
  - Codex model + reasoning + mode
  - Claude model + effort + permission mode
  - OpenCode model + variant + permission mode/config
- Web startup helpers 会把 model/optionValues/modeId 传到 daemon。
- live session capabilities 不再显示可热切 model/mode。

第二阶段必须补：

- Council store 单元测试。
- Council MCP shim request/response 测试。
- Council runtime dry-run launch spec 测试，不真实调用 provider。
- zellij council session/pane lifecycle 测试。
- Web Council modal 状态测试。
- message ordering / replay / duplicate 防护测试。

手测清单：

- New session: Codex/Claude/OpenCode 启动前选择模型/参数/权限后，TUI 实际按该配置启动。
- Resume history: claim 前选择模型/参数/权限后，TUI 实际按该配置 resume。
- Live 后 UI 不再显示假热切按钮。
- Council: 启动 2-3 个 agent，用户发言，agent 通过 MCP 发言，Web chat 正确显示 actor。
- Council: 点击 agent TUI 能看到对应 zellij pane。
- Council: archive room 会关闭 zellij session，不留孤儿。

## 7. 实施顺序

建议严格按顺序：

1. 恢复 provider catalog adapter 注册。
2. 修正 catalog modes 为 startup-only 语义。
3. 修正 native TUI launch spec 对 model/optionValues/modeId 的消费。
4. 修正 Web UI：只在 new/resume 前显示模型/权限；live 后隐藏热切 session control。
5. 补第一阶段测试并跑 typecheck/test/build。
6. 新建 Council 协议和 store。
7. 实现 TS MCP shim MVP。
8. 实现 CouncilRuntime dry-run 和 zellij pane launch。
9. 实现 Council Web 页面和配置 modal。
10. 补 Council 测试和手测文档。

## 8. 验收标准

阶段一完成标准：

- 普通 RAH Web new/resume 能选择 Codex/Claude/OpenCode 模型、参数、权限。
- 所选配置通过 CLI 启动参数/env/config 进入真实 TUI。
- live 后不再展示不可信热切模型/权限按钮。
- `npm run typecheck`
- `npm run test:runtime`
- `npm run test:web`
- `npm run build:web`

阶段二 MVP 完成标准：

- RAH 有独立 Council 页面。
- 可以通过 Web 配置 2-3 个 agent。
- 后端创建一个 zellij council session，并启动每个 agent pane。
- 每个 agent 能通过 RAH TS MCP shim join/post/wait。
- Council 页面显示多人 chat bubbles。
- 可以点击查看任一 agent 的 TUI。
- archive Council 会关闭对应 zellij session。
- 不影响普通单 session 工作流。

## 9. 设计底线

- 实用主义：优先恢复可靠启动配置和最小 Council MVP，不追求一次性实现完整任务系统。
- 稳健性：任何不能被真实 CLI argv/env/config 保证的能力，不在 UI 中假装可用。
- MVP：Council 第一版先做 room chat + multi-agent launch + TUI inspect。
- DRY：provider model/mode/launch 逻辑必须复用 RAH 现有 adapter/catalog/launch spec，不在 Council 复制一套。
- 可移除：Council 代码应高度集中，避免散落进普通 session 主路径。
