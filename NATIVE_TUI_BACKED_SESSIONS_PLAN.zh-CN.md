# RAH Native TUI Backed Sessions 重构计划

状态：设计已收敛，MVP 代码已在 `refactor/native-tui-backed-sessions` 分支推进。

文件位置：`/Users/sun/Code/repos/rah/NATIVE_TUI_BACKED_SESSIONS_PLAN.zh-CN.md`

更高层的产品与系统边界见根目录
`RAH_PTY_FIRST_SEAMLESS_WORKBENCH_PLAN.zh-CN.md`。后续新主线应以该文件为准：
PTY/TUI 是 live truth，原厂 jsonl/db/session 文件是 structured truth，模型/权限/参数等统一控件降级为增强层。

执行边界：

- `main` 保留当前 1.0 工作台路线。
- `refactor/native-tui-backed-sessions` 承载 native TUI backed sessions 重构。
- 这个重构必须可回滚：任何阶段失败，都不应破坏 `main` 上现有 structured live 路线。
- 每个阶段都以可运行 smoke / browser smoke / typecheck 为合并门槛，不靠“看起来能跑”推进。

本文是本次重构的根计划文件。目标不是继续把五家 CLI 的所有内部能力重新实现成一套 RAH 私有协议，而是把 RAH 的长期主路径切到“官方 TUI 真实运行 + Web 工作台增强”。

完成度审计见根目录 `NATIVE_TUI_COMPLETION_AUDIT.zh-CN.md`。该审计文件把用户目标、代码产物、测试证据和仍需人工 QA 的缺口逐项对齐，用于判断是否可以进入最终封板。自动开发阶段交给人类 QA 时，以根目录 `NATIVE_TUI_HUMAN_QA_HANDOFF.zh-CN.md` 作为交付入口。

## 1. 核心判断

RAH 的定位应调整为：

> RAH = 多 CLI 原生运行环境 + Web 远程工作台 + 可选结构化增强。

这意味着：

- 官方 TUI 是 live session 的真实交互源。
- RAH Web 提供远程访问、多 session 管理、历史、分屏、搜索、结构化镜像。
- 新 provider 功能优先通过 TUI view 原生可用，而不是等待 RAH 重新适配。
- RAH 只把稳定、高价值、跨 provider 的能力抽象成 Web 控件。
- Structured live adapter 保留，但从“默认唯一主路径”降级为兼容/增强路径。

本路线要解决的问题：

- Codex / Claude / Gemini / Kimi / OpenCode 都在快速迭代。
- CLI 内部 RPC、SDK 参数、权限模型、模型参数、`/` 命令会持续漂移。
- 只靠 mock 测试无法证明真实 CLI 新版本仍接受 RAH 的内部协议调用。
- RAH 同时面对五家 CLI，长期追逐每个 provider 的每个新能力不现实。
- TUI / PTY 是比内部 RPC 更稳定的交互边界。

## 2. 架构原则

1. 官方 TUI 是 live truth source。
2. Chat timeline 是 mirror，不是唯一真相。
3. Adapter 的主责从“复刻 provider live protocol”降为“launch + observe + mirror + minimal control”。
4. Mirror 失败只影响结构化展示，不能影响 TUI live session。
5. Provider 新增 `/goal`、权限菜单、模型菜单等能力时，RAH 不需要立即适配，用户可直接切到 TUI 使用。
6. Web 控件只保留稳定能力：启动、resume、输入、stop、archive、历史、分屏、基础 model/mode 启动参数。
7. Native TUI backend 增量落地，不一次性删除现有 structured live。

## 3. 用户体验目标

一个 live session 有两种可能视图：

- `TUI`：真实官方 CLI TUI，通过 xterm 显示。
- `Chat`：RAH 从 provider 历史文件/DB/活动流解析出的结构化气泡视图。

视图规则：

- 有 Chat mirror 的 native session 可以显示 `Chat / TUI` 切换。
- 没有 Chat mirror 的 native session 直接显示 TUI，不显示空的 Chat 按钮。
- Structured-only session 继续显示原有 Chat 体验。
- 分屏 pane 内也支持同样的 TUI / Chat 规则。

典型流程：

1. 用户在 Web 点 New Codex。
2. daemon 后台启动真实 `codex` TUI。
3. Web 默认可显示结构化 Chat mirror。
4. 用户需要 `/goal`、`/permissions` 或官方菜单时切到 TUI。
5. 用户直接在 TUI 内执行官方功能。
6. RAH 继续负责 session 管理、历史、分屏、搜索、remote access。

## 4. 当前分支进展

当前分支：

```bash
refactor/native-tui-backed-sessions
```

当前已完成的主要实现：

- 协议层新增 `liveBackend: "structured" | "native_tui"`。
- `ManagedSession` 新增 `nativeTui` 信息。
- capabilities 新增 `nativeTui`、`rawPtyInput`、`chatMirror`、`structuredControl`。
- `RuntimeEngine.startSession` / `resumeSession` 支持 `native_tui`。
- `RuntimeEngine` 的 native TUI start/resume 已改为依赖 `NativeTuiProviderRuntime`，不再直接把 native 主路径挂在肥大的 `ProviderAdapter` 结构化 live 接口上。
- `RuntimeTerminalCoordinator` 的 provider-specific binding / mirror 逻辑已迁入 `NativeTuiProviderRuntime`；`rah xxx` terminal handoff 逻辑已迁入 `TerminalWrapperSessionRuntime`；coordinator 现在主要保留 daemon-owned native TUI 进程、PTY、prompt/queue 和 mirror lifecycle。
- `RuntimeTerminalCoordinator` 可启动 daemon-owned native TUI session。
- native Chat input 会写入 PTY：`text + "\r"`。
- native Stop 会向 PTY 写 Ctrl-C 并解除 busy 状态。
- native close 会关闭 daemon-owned TUI，不误走旧 adapter close。
- `PtyHub` 已支持 seq cursor replay、trim boundary、exit replay。
- Web `TerminalPane` 已支持 `fromSeq` replay，避免控制权变化导致 xterm 重建。
- Web session 页面和 canvas pane 已可嵌入真实 TUI。
- Codex native TUI 已有 Chat mirror MVP，通过 rollout 增量解析 user/assistant/tool/lifecycle。
- Codex Web 新建 native TUI 使用隔离 `CODEX_HOME` wrapper home，只共享 auth/config，不共享 `sessions`；binding / mirror 只从该 wrapper home 读取 rollout，避免同 workspace 的外部 Codex 对话被误绑定到新 session。
- Claude 默认走 native TUI，并已接入基于 `.claude/projects/*.jsonl` 完整记录的 Chat mirror MVP。
- Kimi 默认走 native TUI，并已接入基于 `wire.jsonl` 的 Chat mirror MVP。
- Gemini 默认走 native TUI，并已接入基于 conversation JSON/JSONL 的 Chat mirror MVP。
- OpenCode 默认走 native TUI，已接入基于 `opencode.db` 消息、文本 / reasoning / tool / step part / token usage 的 Chat mirror MVP。

已本机验证过的真实 CLI flag：

- Claude：`--session-id`、`--resume`、`--permission-mode`、`--model`、`--effort`。
- Gemini：`--approval-mode`、`--model`、`--resume`。
- Kimi：`--session/--resume`、`--model`、`--thinking/--no-thinking`、`--yolo`、`--plan`。
- OpenCode：`opencode [project]`、`opencode --model`、`opencode --session`、`opencode --continue`、`opencode serve`、`opencode attach <url>`。

## 5. Provider 策略矩阵

| Provider | Native TUI 默认 | providerSessionId 绑定 | Chat mirror | 当前策略 |
|---|---:|---|---:|---|
| Codex | 是 | TUI 输出 `Session: <uuid>` + rollout discovery | 是 | 第一主路径，优先稳定 |
| Claude | 是 | 启动前生成并传 `--session-id` / resume 传 `--resume` | 是，JSONL final-state mirror | Native + Chat/TUI |
| Gemini | 是 | 新 session 从 Gemini history discovery 绑定；resume 直接绑定 | 是，conversation JSON/JSONL mirror | Native + Chat/TUI |
| Kimi | 是 | 启动前生成并传 `--session` / resume 传 `--session` | 是，wire JSONL final-state mirror | Native + Chat/TUI |
| OpenCode | 是 | 新 session 从 `opencode.db` discovery 绑定；resume 直接绑定 | 是，DB text/reasoning/tool/step/usage mirror | Native + Chat/TUI |

OpenCode 当前边界：

- native TUI new/resume、PTY 输入、close、browser TUI view 已纳入 smoke。
- providerSessionId 通过 `opencode.db` 按 workspace 与更新时间 discovery 绑定。
- Chat mirror 已启用：DB 中 user message 立即 mirror；assistant message 只要已有 parts 即可增量 mirror；text/reasoning part 会进入 timeline，tool part 会 mirror 为工具开始/完成事件，step part 会 mirror 为 turn step 事件；message token/cost 会 mirror 为 usage；最终完成状态仍由 OpenCode `finish` / completed time 决定。
- 现有 ACP client 仍保留，用作结构化兼容路径和未来能力参考。

Claude 当前边界：

- native TUI new/resume、PTY 输入、close、browser TUI view 已纳入 smoke。
- providerSessionId 由 RAH 启动前生成并传入 Claude CLI，native manager 可立即预绑定。
- Chat mirror 已启用，但只 mirror `.claude/projects/*.jsonl` 中已落盘的完整 user/assistant/tool/error 记录。
- Chat mirror 不追求 Claude TUI 中间态流式输出；实时交互仍以 TUI 为真相。

Kimi 当前边界：

- native TUI new/resume、PTY 输入、close、browser TUI view 已纳入 smoke。
- providerSessionId 由 RAH 启动前生成并传入 Kimi CLI，native manager 可立即预绑定。
- Chat mirror 已启用，通过 `KIMI_SHARE_DIR/sessions/<workdir-md5>/<session>/wire.jsonl` 增量读取已落盘 wire 事件。
- Chat mirror 使用 Kimi 既有 `turnIndex + itemIndex` canonical identity，避免 live/history 相同文本误合并。

Gemini 当前边界：

- native TUI new/resume、PTY 输入、close、browser TUI view 已纳入 smoke。
- 新 session 的 providerSessionId 仍通过 Gemini history discovery 绑定；resume 直接绑定。
- Chat mirror 已启用，通过 Gemini conversation JSON/JSONL 文件增量读取已落盘 message revision。
- Chat mirror 使用 Gemini 原生 message id 作为 canonical identity，并优先使用 `displayContent`，避免 `@file` 展开内容污染用户原始问题。

## 6. 目标架构

协议模型：

```ts
type SessionLiveBackend = "structured" | "native_tui";

type NativeTuiInfo = {
  terminalId: string;
  viewAvailable: boolean;
};

type SessionCapabilities = {
  nativeTui?: boolean;
  rawPtyInput?: boolean;
  chatMirror?: boolean;
  structuredControl?: boolean;
};
```

Daemon 模型：

```ts
type SessionRuntime =
  | { kind: "structured_live" }
  | {
      kind: "native_tui";
      terminalId: string;
      providerSessionId?: string;
      mirror: "history" | "activity" | "none";
    };
```

Native launch spec：

```ts
type NativeTuiLaunchSpec = {
  provider: ProviderKind;
  command: string;
  args: string[];
  cwd: string;
  title: string;
  preview: string;
  providerSessionId?: string;
  env?: Record<string, string>;
};
```

Adapter 职责边界：

- 生成 native launch spec。
- 决定 new/resume 参数。
- 决定 providerSessionId 如何绑定。
- 决定是否支持 Chat mirror。
- 决定 stop 是 Ctrl-C、Esc 还是 process signal。
- 提供 history parser / DB discovery。

第一步瘦身边界：

- `packages/runtime-daemon/src/native-tui-provider-runtime.ts` 定义 native TUI provider runtime contract。
- `packages/runtime-daemon/src/native-tui-provider-runtime-types.ts` 定义 native TUI provider runtime 的共享类型。
- `packages/runtime-daemon/src/native-tui-provider-handlers.ts` 只负责注册五家 handler；具体实现拆到 `native-tui-codex-provider-handler.ts`、`native-tui-claude-provider-handler.ts`、`native-tui-gemini-provider-handler.ts`、`native-tui-kimi-provider-handler.ts`、`native-tui-opencode-provider-handler.ts`，避免 runtime contract 或 registry 变成新的 God Object。
- `RuntimeEngine` 通过该 contract 获取 start/resume launch spec。
- `RuntimeTerminalCoordinator` 通过该 contract 执行 providerSessionId binding probe、TUI output observation、Chat mirror update。
- 旧 `ProviderAdapter` 仍保留 structured live、workspace action、stored history 等兼容能力，但 native TUI 主路径已经开始脱离该肥接口。
- 下一步的瘦身重点不再是继续扩大 Web 控件协议，而是逐步把旧 structured live adapter 降级为兼容路径，并确保新增 provider 能优先只实现 native launch / observe / mirror / minimal control。

Adapter 不再长期承担：

- 完整复刻 provider 内部 live protocol。
- 完整复刻 provider 权限菜单。
- 完整复刻 provider `/` 命令。
- 为每个 CLI 新版本补全所有新功能。

## 7. 分阶段执行计划

### 阶段 A：隔离与协议

目标：让 native TUI backend 与现有 structured live 并存。

已完成：

- 新分支隔离。
- 协议新增 `liveBackend`。
- capabilities 新增 native TUI 相关字段。
- HTTP request validation 支持 new/resume 的 `liveBackend`。
- session summary 能表达 native TUI terminal id。

验收：

- structured live 不受影响。
- native session 能通过 summary 暴露 terminalId。
- typecheck / protocol tests 通过。

### 阶段 B：PTY 底座

目标：把终端能力升级成 RAH 核心基础设施。

已完成：

- `PtyHub` 支持 seq。
- WebSocket 支持 `fromSeq`。
- `TerminalPane` 支持增量恢复。
- xterm 不因 `hasControl` 等普通状态变化重建。
- stale socket close 已处理。
- `PtyHub` 已支持 `maxReplayChunks + maxReplayBytes` 双配额，避免超大 native TUI 输出把 daemon scrollback 撑到不可控。
- `/api/pty/stats` 已暴露 PTY replay chunks、bytes、trim boundary、subscriber count 和 exit/open 状态，作为 terminal replay/backpressure 的基础监控面。
- PTY WebSocket 发送已加入 `bufferedAmount` backpressure 保护：慢客户端超过阈值会以 `1013` 关闭订阅，不继续堆积 daemon 内存。
- Settings 的 Version 页已展示 terminal replay health：open/total PTY sessions、replay bytes、subscriber count、trimmed session 数量、refresh-to-refresh 趋势和单个 PTY 的 seq / trim 边界。
- TUI 面板会显示 PTY backpressure 关闭原因，例如 `PTY client is too slow`，然后继续从 replay cursor 自动重连。
- 移动端 TUI 面板已使用 `visualViewport` 计算键盘占用和 terminal 可见高度；键盘弹出时 xterm 重新 fit 并向 PTY 发送 resize，让终端按可见行数重绘，而不是依赖页面滚动把固定高度 terminal 顶上去。
- terminal 主题已接入 RAH Web UI 语义 token，light/dark 下的 xterm 背景、前景、光标、selection 和移动端输入桥样式与主界面保持一致。

后续增强：

- iPad / iPhone 真机输入法 composition、键盘高度、旋转和 PWA 后台专项测试。
- pane resize / iPad 旋转专项验证。
- 更完整的 backpressure UI，例如把 PTY stats 趋势提升为持久化历史图表，而不是当前 Settings 内的 refresh-to-refresh delta。

验收：

- 刷新页面后 terminal 能恢复最近输出。
- 大量输出不会造成明显 UI 卡死。
- Ctrl-C / Esc / Enter 等基础输入可靠。

### 阶段 C：Native TUI Session Manager

目标：daemon 能拥有、管理、关闭后台官方 TUI。

已完成：

- `RuntimeTerminalCoordinator.startNativeTuiSession`。
- `closeNativeTuiSession`。
- `handleNativeTuiInput`。
- `handleNativeTuiInterrupt`。
- native Chat input 已有 prompt state MVP：
  - `prompt_clean`：直接向 PTY 注入 `text + "\r"`。
  - `agent_busy`：排队输入，等 provider activity / prompt marker 回到 clean 后按序注入。
  - `prompt_dirty`：拒绝 Chat 注入，避免把文本写进 TUI 菜单、权限弹窗或用户本地草稿。
- `nativeTui.promptState` 已进入 session summary 和事件流，前端可在 `prompt_dirty` 时直接禁用 Chat 发送，而不是等后端失败兜底。
- Chat 注入 native TUI 前会先 drain 当前已落盘 mirror，且 stale persisted mirror completion 不能把更新的 Web 输入错误标回 idle。
- stale Kimi `TurnEnd` 同样不能提前释放更新的 Web 输入；该场景已纳入 runtime 回归测试。
- stale Codex rollout lifecycle 同样不能污染更新的 Web 输入；Codex lifecycle timestamp 已纳入 native mirror guard。
- stale Gemini conversation message 同样不能提前释放更新的 Web 输入；Gemini message timestamp 已纳入 native mirror guard。
- stale OpenCode database completion 同样不能污染更新的 Web 输入；OpenCode message timestamp 已纳入 native mirror guard。
- native TUI 非预期退出会把 session 标记为 `stopped`，并记录 `process_exited` 诊断。
- runtime shutdown 会清理 native sessions。

后续增强：

- 不同 provider 的 stop 策略细分。
- prompt clean 的 provider 专项 QA：真实 Claude/Gemini/Kimi/OpenCode TUI 在权限弹窗、菜单、长任务状态下的误注入验证。

验收：

- Web new/resume 能启动 native TUI。
- Web 输入能进入 TUI。
- Stop 不会让 session 永久 stuck。
- Archive 才关闭 daemon-owned TUI；Hide / pane 切换不关闭。

### 阶段 D：Provider Native Launch

目标：把 provider 差异收敛到 launch spec。

已完成：

- Codex new/resume launch spec。
- Claude new/resume launch spec。
- Gemini new/resume launch spec。
- Kimi new/resume launch spec。
- OpenCode new/resume launch spec。
- Codex/Claude/Gemini/Kimi/OpenCode 在 Web new/claim 默认请求 native TUI。
- OpenCode DB binding 已接入 native manager。
- OpenCode DB 文本、reasoning、工具、step part 和 token/cost usage 增量 Chat mirror 已接入 native manager。
- Claude JSONL final-state Chat mirror 已接入 native manager。
- Kimi wire JSONL Chat mirror 已接入 native manager。
- Gemini conversation JSON/JSONL Chat mirror 已接入 native manager。
- `test:smoke:native-cli-probe` 可直接探测本机真实 CLI 的 `--help` 输出是否仍包含 native launch 依赖的 flag。
- `test:smoke:native-cli-probe` 会同时采集本机真实 CLI 的 `--version` 输出和当前 RAH branch / commit / dirty worktree 状态，用于升级漂移审计和真实 QA 失败追踪；完整 `test:native-tui` 会默认写入 `test-results/native-cli-probe.json` 作为 ignored QA 证据。
- native binding / mirror source 缺失 / mirror update failure 会记录为可查询诊断，并保留 daemon log 一次性 warning。
- Settings 的 Version 页已展示 active native TUI diagnostics。
- 各 provider 的当前真实版本记录已写入 `docs/native-tui-real-cli-qa.zh-CN.md`。

待做：

- 真实 OpenCode TUI 手测 `opencode [project]`、`--session`、`--model` 与 Ctrl-C 行为。

验收：

- 五家 native provider 的 fake-provider smoke 稳定。
- 真实 CLI help flag 与 launch spec 对齐。
- OpenCode native daemon/browser smoke 覆盖 launch、input、close、DB binding。

### 阶段 E：Chat Mirror

目标：TUI 是真相，Chat 是增强镜像。

已完成：

- Codex rollout 增量 mirror。
- Codex rollout lifecycle 驱动 running/idle/stop UI。
- Codex rollout mirror 已覆盖 Codex 0.128 形态下同一 assistant 同时落盘为
  `event_msg.agent_message` 与 `response_item.message(role=assistant)` 的双写去重；去重同时覆盖完整
  rollout、frozen history window 缺失 `task_started` 的分页窗口，以及 browser Chat mirror。
- History snapshot 层统一按 `canonicalItemId` 去重 `timeline.item.added`，因此该不变量不只依赖 Codex
  parser；materialized history、frozen initial page、frozen older page 都有 runtime 测试覆盖。
- Claude JSONL final-state mirror。
- Kimi wire JSONL mirror。
- Gemini conversation JSON/JSONL mirror。
- canonical timeline identity 继续作为去重主键。
- Kimi `TurnEnd` 已转换为 `turn.completed`，用于 native Chat 队列释放 prompt busy 状态。

待做：

- OpenCode DB mirror 继续增强更细的状态中间态表现；文本、reasoning、tool started/completed、step started/completed 和 message token/cost usage 已有集成覆盖。
- Mirror 诊断已覆盖 source missing 与 update failure；后续只继续增强 provider 级指标和聚合趋势。

原则：

- Mirror 失败不能关闭 live session。
- Mirror 不稳定时固定显示 TUI。
- Chat view 不能重复输出同一条历史/live 事件。

验收：

- Codex TUI 回答后 Chat view 显示结构化内容。
- 刷新或 history backfill 不重复。
- 连续两次相同文本不会误合并。

### 阶段 F：Web 双视图与 Canvas

目标：让 native TUI 成为 session 页面和分屏 pane 的一等视图。

已完成：

- selected pane 支持 TUI。
- canvas pane 支持 TUI。
- Codex native 有 Chat/TUI toggle。
- Claude native 有 Chat/TUI toggle。
- Kimi native 有 Chat/TUI toggle。
- Gemini native 有 Chat/TUI toggle。
- OpenCode 有 DB mirror 时显示 Chat/TUI toggle。
- 移动端 TUI input bridge 已提供 Ctrl-C、Esc、Tab、方向键和 Enter 快捷键。
- 移动端点击 terminal canvas 会聚焦 RAH 自己的输入桥，而不是 xterm hidden textarea；该路径允许浏览器
  做键盘避让，避免和直接点击输入框出现不同的 iOS 抬起行为。
- 移动端键盘弹出时，TUI 面板会按 visual viewport 缩小为键盘上方的可见高度，并触发 xterm / PTY resize；WebKit browser smoke 已覆盖 mobile/touch input bridge 和 canvas focus 路径，但真实 iPad 输入法仍需人类确认。
- Codex browser smoke 已覆盖 canvas 内 native TUI 渲染，并在上下二分、三分、四分、左右二分布局切换后验证 TUI replay 仍可恢复，且布局变化会触发 PTY resize 并传到 native TUI 进程。

后续增强：

- iPad / 大屏分屏中的真实拖拽 resize 与旋转 QA。
- 移动端输入桥优化。

验收：

- 单 session 页面可用。
- 分屏 pane 可用。
- Hide canvas 不影响 live TUI。
- pane 替换不误 archive session。

### 阶段 G：Structured Live 降级策略

目标：保留现有能力，但避免继续把它当唯一可信 live 主路径。

策略：

- Codex/Claude/Gemini/Kimi/OpenCode：native TUI 为默认。
- OpenCode structured ACP 保留为兼容/增强路径，不再作为默认 live 主路径。
- Structured live 作为高级/实验/兼容模式保留。
- Web UI 不应假装 native TUI 支持全部 structured control。

明确边界：

- Terminal-owned / native TUI session 默认 `structuredControl: false`。
- Web 不热切 provider 内部 model/mode，除非 provider native TUI 已证明支持可靠 remote control。
- 用户需要 provider 最新官方能力时，切 TUI 使用。

## 8. 测试与验收命令

每次涉及 native TUI / PTY / session lifecycle 的修改，至少运行：

```bash
npm run test:native-tui
```

`test:native-tui` 是完整 native TUI 自动门槛，等价于顺序运行：

```bash
npm run typecheck
npm run test:web
npm run test:runtime
npm run build:web
RAH_NATIVE_CLI_PROBE_OUTPUT=test-results/native-cli-probe.json npm run test:smoke:native-cli-probe
npm run test:smoke:native-codex
npm run test:smoke:native-providers
npm run test:smoke:native-codex-browser
npm run test:smoke:native-provider-browser
npm run test:smoke:wrapper
git diff --check
```

这些 smoke 的意义：

- `native-codex`：隔离 daemon + 假 Codex TUI，验证 HTTP/WebSocket/PTY/binding/mirror/close。
- `native-codex-browser`：Playwright 打开 Web，验证 Chat/TUI toggle、xterm 输出输入、Chat composer 注入 native TUI、TUI 中存在未提交草稿时 `nativeTui.promptState` 会变为 `prompt_dirty` 且 Chat composer 会被阻止不会误注入，并显示切 TUI 提交或清除草稿的 warning；Stop 按钮发送 Ctrl-C 并让 session 回到 idle、页面 reload 后 TUI replay、Chat mirror、浏览器离线期间后台 native TUI 输出在恢复 online/focus 后能被当前页面追上且无需重新选择 session、Settings Version 页可显示 PTY terminal replay health 且 Refresh 后会显示 refresh-to-refresh delta、canvas 内 native TUI 及上下二分/三分/四分/左右二分布局切换后的 TUI replay，并验证布局变化会触发 PTY resize 到 native TUI 进程；同时用 mobile/touch context 验证 TUI input bridge 快捷键栏会渲染，且 Ctrl-C、文本输入与 composition 输入都能写入 PTY。
- `native-codex-browser` 还会模拟真实 Codex rollout 双写：同一回答同时写入 `agent_message` 和 assistant
  `response_item`，并断言 Chat mirror / history API 只保留一个 assistant item。
- `native-providers`：隔离 daemon + 假 Claude/Gemini/Kimi/OpenCode TUI，验证 native backend、PTY、绑定、关闭，以及四家 provider mirror 能力标记。
- `native-provider-browser`：Playwright 验证 Claude/Gemini/Kimi/OpenCode 都有 Chat/TUI、mirror 文本可见；OpenCode DB mirror 会额外断言 text、reasoning、tool、step 在 Chat UI 可见，且 token/cost usage 会进入 session summary；Chat composer、Stop 按钮与 xterm 输入都能进入 daemon-owned provider TUI；TUI 中存在未提交草稿时 `nativeTui.promptState` 会变为 `prompt_dirty` 且 Chat composer 会被阻止不会误注入，并显示切 TUI 提交或清除草稿的 warning；Stop 后 session 必须回到 idle；页面 reload 后 TUI replay 必须恢复已有输出；浏览器离线期间后台 PTY 输入产生的新 TUI 输出，在恢复 online/focus 后当前页面必须自动追上且无需重新选择 session。
- `native-codex-browser` / `native-provider-browser` 的 Python harness 会在成功和失败路径 best-effort close 已启动 session，并终止 daemon 子进程树；跑完后应检查没有 `/rah-native-*-browser-*/fake-*.js` 残留，避免测试泄漏污染后续端口和进程生命周期判断。
- browser smoke 默认用 Chromium；`npm run test:smoke:native-browser-webkit` 可跑 WebKit 近似 Safari/iPad，`npm run test:smoke:native-browser-firefox` 可跑 Firefox。非默认 browser 要求本机安装对应 Playwright runtime。browser smoke 会先预检所选 runtime，缺失时在启动 daemon/native fake session 前失败，并在 JSON 输出中标记 `phase: "browser_preflight"`，避免污染测试过程。这些桌面 browser runtime 仍不替代真机 QA。
- `native-cli-probe`：本机真实 CLI `--version` 与 `--help`/`resume --help` 探测，记录 provider 版本、当前 RAH branch/commit/dirty 状态，并验证 launch spec 使用的 flag 仍存在且 help 命令 exit code 为 0；缺少 provider 时默认失败，可用 `RAH_NATIVE_CLI_PROBE_ALLOW_MISSING=1` 只做已安装 provider 检查；完整 `test:native-tui` 默认用 `RAH_NATIVE_CLI_PROBE_OUTPUT=test-results/native-cli-probe.json` 写入 ignored JSON 报告。
- `native-real-tui-launch`：可选真实 CLI 启动 smoke，直接用 `nativeTuiStartLaunchSpec` 启动 Codex / Claude / Gemini / Kimi / OpenCode 官方 TUI，确认能进入 RAH PTY host、启动窗口内不崩溃、可被关闭；默认写入稳定工作区 `test-results/native-real-tui-workspaces/<provider>`，避免制造已删除临时目录 session。RAH 用户可见 session list 会过滤这些内部探针工作区，避免污染 Live / History / Recent / Workspaces。报告会记录 RAH branch / commit / dirty 状态，并区分 raw terminal output 与去 ANSI 后的 visible output。它不发送 prompt，不证明模型响应、权限弹窗、额度、登录态或 long-running turn。
- `native-qa-status`：读取 `test-results/native-cli-probe.json` 与 `test-results/native-real-tui-launch.json`，检查五家 provider 的自动证据是否齐全、报告 commit 是否匹配当前 commit，并输出仍需人工 QA 的清单；可用 `RAH_NATIVE_QA_STATUS_OUTPUT` 写入 JSON 报告。它不替代真实模型响应或 iPad/Safari 真机验证。
- `native-manual-qa-status`：可用 `RAH_NATIVE_MANUAL_QA_TEMPLATE_OUTPUT=test-results/native-manual-qa.json npm run test:smoke:native-manual-qa-status -- --print-template` 生成人工 QA 模板；人工测试完成后校验五家通用真实用例、provider 专项用例、iPad/Safari 用例是否全部 `pass` 且包含 tester/testedAt/evidence；provider 项还必须填写 cliVersion。它只校验人类结果完整性，不自动证明真实行为。
- `wrapper`：synthetic wrapper-control smoke，验证五家 `rah xxx` handoff 协议路径、queued turn、provider binding、event projection 和 close；它不替代真实 TUI 手测。
- `/api/native-tui/diagnostics`：查询 native TUI binding/mirror/process-exit 诊断，默认只返回 active 诊断，可用 `includeResolved=1` 查询已解决记录；Settings Version 页和当前 session notice 已接入 active 诊断。
- `docs/native-tui-real-cli-qa.zh-CN.md`：真实 CLI QA 清单与当前本机 provider 版本记录；用于覆盖账号、额度、真实 TUI 菜单、权限弹窗和 iPad/Safari 这些自动 smoke 无法证明的部分。

仍需人工或真实 CLI QA：

- 真实 Codex `/goal`。
- 真实 Claude permission prompt。
- 真实 Gemini 登录态/额度异常。
- 真实 Kimi long-running turn。
- iPad Safari 输入、旋转、分屏 resize。
- 局域网 PWA 后台切回 replay。

## 9. 风险与缓解

### 风险：后台 TUI 不是普通 shell 程序

有些 TUI 会依赖 alternate screen、focus、尺寸、TTY 特性。

缓解：

- daemon 必须使用真实 PTY，不用 pipe 模拟。
- Web 必须提供真实 xterm，而不是 screen-scrape。
- 出问题时优先修 PTY 底座，不回到 provider 内部 RPC 复刻。

### 风险：Chat composer 注入输入误操作

如果 TUI 正在权限确认、菜单选择、输入框非 prompt 状态，直接注入文本可能误操作。

缓解：

- native Chat composer 不再盲目注入：`prompt_clean` 才发送，`agent_busy` 排队，`prompt_dirty` 拒绝。
- Codex 使用 prompt marker / provider lifecycle；Kimi 使用 `TurnEnd`；Claude/Gemini final-state mirror 回写后释放 prompt busy。
- 不确定状态提示用户切 TUI，不让 Web 猜测当前官方 TUI 的内部菜单状态。

### 风险：Mirror 延迟或解析失败

provider history 文件可能延迟写入，schema 可能变。

缓解：

- TUI view 永远可用。
- Mirror 失败只降级 Chat，不影响 live。
- telemetry 记录 mirror bind/parse/replay 失败。

### 风险：OpenCode native mirror 尚未流式化

OpenCode 已切到 native TUI default，并有 DB 文本、reasoning、工具、step part 和 token/cost usage 增量 Chat mirror；当前仍不承诺完全等同 OpenCode 官方 UI 的所有中间态。

缓解：

- OpenCode Chat 展示已进入 DB 的 user message、assistant text/reasoning parts、tool parts、step parts、message token/cost usage 和完成状态；实时交互仍以 TUI 为真相。
- ACP client 保留为结构化能力参考；DB mirror 已接入 native manager，后续只继续补更细状态中间态。
- Mirror 失败不影响 TUI live session。

## 10. OpenCode 后续清单

OpenCode 已进入 native default，后续需要补强：

1. 用真实 OpenCode TUI 验证 `opencode [project]` 与 `cwd` 的优先级。
2. 用真实 OpenCode TUI 验证 `opencode --session <id>` 的 resume 行为。
3. 用真实 OpenCode TUI 验证 `--model provider/model[/variant]` 是否严格生效。
4. 验证 Ctrl-C 中断真实 OpenCode turn 的稳定性。
5. 继续将 OpenCode DB mirror 增强到更细的状态中间态；文本、reasoning、tool started/completed、step started/completed 和 message token/cost usage 已有集成覆盖。
6. 保留 ACP client 作为结构化能力参考，避免删除可用资产。

## 11. 不做事项

本次重构不追求：

- 在 Web 里复刻所有 provider 官方菜单。
- 在 Web 里复刻所有 `/` 命令。
- 对 native TUI 做完整 screen-scrape 变成完美气泡。
- 删除 structured live adapter。
- 一次性完成五家 provider 的完美流式 Chat mirror。
- 承诺 Web 控件可热切所有 provider model/mode/permission。

## 12. 成功标准

这次重构成功，不是因为 RAH 抽象了更多 provider 私有协议，而是因为：

- provider 内部协议变更时，live session 仍能通过官方 TUI 使用。
- provider 新功能出现时，用户能直接在 TUI view 使用，不必等 RAH 适配。
- RAH 的核心价值集中在多 session 工作台、历史、分屏、远程访问、结构化 mirror。
- Adapter 复杂度从“完整 provider client”下降为“native launch + history mirror + minimal remote control”。
- 结构化增强失效时，系统仍有真实 TUI fallback。

## 13. 回滚与合并策略

这条路线影响 live session 的主路径，不能直接在 `main` 上硬切。

推荐节奏：

1. 在 `refactor/native-tui-backed-sessions` 分支完成 native TUI default MVP。
2. 保留旧 structured live adapter，不删除可用资产。
3. 让 Web new/claim 默认走 `native_tui`，但协议仍允许显式 `structured`。
4. 所有 provider 先通过 fake smoke，再通过 browser smoke，再做真实 CLI probe。
5. 真实 CLI 长时间使用验证前，不把旧路径删掉。
6. 若某家 native TUI 出现 blocker，只对该 provider 临时回退 structured live，不影响其他 provider。

合并到 `main` 前必须满足：

- `npm run test:native-tui`

## 14. 下一步优先级

短期顺序：

1. 继续执行 `docs/native-tui-real-cli-qa.zh-CN.md` 里的真实 CLI 长运行 QA。
2. 继续优化 iPad / Safari terminal 输入体验。
3. 将五家 native TUI default 作为主路径做连续几天真实使用验证。
4. 增强 OpenCode DB mirror 的中间态流式表现。
5. Prompt clean provider QA：验证真实 Claude/Gemini/Kimi/OpenCode 在权限弹窗、菜单、长任务状态下不会被 Chat composer 误注入。

中期顺序：

1. OpenCode DB mirror 增强。
2. Prompt clean provider 专项强化。
3. 真实 CLI 长时间运行 QA。
4. 更完整的 terminal replay/backpressure UI；基础 PTY stats API、slow-client 断开策略、TUI 面板断开原因和 Settings terminal replay health / refresh delta 已落地，后续可补持久化趋势图。

## 15. 当前未完成闭环

当前 native TUI backed sessions 已经不是纯设计，五家 provider 的 fake smoke / browser smoke / CLI help probe 主链路已经跑通。但还不能称为最终封板，原因是：

- 真实 CLI 长运行 QA 仍需要人类账号、额度、登录态和真实模型响应参与。
- 真实 CLI QA 清单和本机版本记录已写入 `docs/native-tui-real-cli-qa.zh-CN.md`。
- Native telemetry 后端可查询诊断与 Settings active 诊断卡片已落地；binding/mirror source/mirror failure/process-exit 主诊断已覆盖，当前 session 和 canvas pane 会直接显示 active native TUI 诊断。
- OpenCode Chat mirror 当前是 DB 文本、reasoning、工具、step part 和 token/cost usage 增量 mirror，但不承诺完整复刻官方 UI 的所有中间态。
- Prompt clean 已有 MVP，但真实 provider 菜单/权限弹窗状态仍需要专项 QA 和 provider 细化。
- iPad / Safari 的 terminal 输入、旋转、分屏 resize 仍需要真机验证。

## 16. 当前自动验收记录

最近一次本机自动验收日期：2026-05-03。

已通过：

- `npm run test:native-tui`
- `npm run typecheck`
- `npm run test:web`：148 pass
- `npm run test:runtime`：367 pass
- `npm run build:web`
- `npm run test:smoke:native-cli-probe`
- `npm run test:smoke:native-codex`
- `npm run test:smoke:native-providers`
- `npm run test:smoke:native-codex-browser`
- `npm run test:smoke:native-provider-browser`
- `npm run test:smoke:wrapper`
- `git diff --check`

额外通过：

- `npm run test:smoke:native-browser-webkit`
- `RAH_NATIVE_REAL_TUI_PROBE_OUTPUT=test-results/native-real-tui-launch.json npm run test:smoke:native-real-tui-launch`

这轮自动验收确认：

- 五家 provider 的 native TUI launch spec 仍和本机真实 CLI help flag 对齐，且 `native-cli-probe` 会输出本机真实 CLI 版本用于升级漂移审计；help 探测现在也要求 exit code 为 0，避免只打印匹配文本但命令实际失败。
- Codex / Claude / Gemini / Kimi / OpenCode 的 fake native TUI new、PTY 输入、providerSessionId 绑定、close 主链路通过。
- Web 侧 Chat/TUI toggle、xterm 输出、TUI 输入、Chat composer 注入 native TUI、五家 fake native Stop -> Ctrl-C/SIGINT、Stop 后 runtimeState 回 idle、Chat mirror 可见性通过。
- 前端 composer contract 已覆盖 `nativeTui.promptState = prompt_dirty` 时 Chat composer 不能提交，避免 UI 改动绕开防误注入保护。
- 前端 notice contract 已覆盖 `nativeTui.promptState = prompt_dirty` 时页面显示切换到 TUI 提交或清除本地草稿的 warning。
- Web Stop 可见性同时参考 session summary 和 runtime status，避免短暂 summary 同步漂移时出现 backend running 但前端无 Stop。
- Native TUI Chat 注入后的 stale persisted mirror completion、Kimi `TurnEnd`、Codex rollout lifecycle、Gemini conversation message、OpenCode database completion 不会把 session 错误标回 idle，避免 Stop 按钮在新 turn 中途消失。
- Native TUI Chat mirror 源文件绑定后如果更新失败，会产生 `mirror_failed` 诊断；该失败只降级 Chat mirror，不会关闭真实 TUI live session。
- 五家 `rah xxx` wrapper-control synthetic handoff 路径通过。
- 页面 reload 后，Codex / Claude / Gemini / Kimi / OpenCode 的 TUI replay 能恢复已有 native session 输出。
- Codex browser smoke 已验证浏览器离线期间后台 native TUI 输出，在恢复 online/focus 后当前页面能自动追上 TUI 和 Chat mirror，不需要重新点击 session；并验证 Settings Version 页能从 daemon 读取并展示 PTY terminal replay health，且手动 Refresh 后能显示 refresh-to-refresh delta。
- Claude / Gemini / Kimi / OpenCode browser smoke 已验证 TUI 中存在未提交草稿时 Chat composer 会被阻止且不会误注入，并已验证浏览器离线期间后台 PTY 输入产生的新 native TUI 输出，在恢复 online/focus 后当前页面能自动追上 TUI replay，不需要重新点击 session；OpenCode browser smoke 还验证了 DB text、reasoning、tool、step 和 usage 的 Chat 集成投影。
- canvas 内 Codex native TUI 能渲染，并且在上下二分、三分、四分、左右二分布局切换后可以恢复 TUI replay，且布局变化会向 native TUI 进程发送 PTY resize。
- mobile/touch browser context 能看到 TUI input bridge 和 Ctrl-C、Esc、Tab、方向键、Enter 快捷键，并验证 Ctrl-C 快捷键、文本输入与 composition 输入都能写入 PTY。
- Codex/provider browser smoke 的 cleanup harness 已验证不会在成功路径留下 fake Codex/provider 进程；失败路径也会 close 已启动 session 并终止 daemon 子进程树。
- 通用 terminal prompt state 已从 Codex bridge 中抽出到 `native-tui-prompt-state.ts`，并由 `native-tui-prompt-state.test.ts` 独立覆盖；native TUI 主路径不再为了 prompt clean/dirty/busy 判定依赖 Codex 命名模块。
- stale persisted mirror guard 已从 `RuntimeTerminalCoordinator` 私有函数抽出到 `native-tui-mirror-guard.ts`，并由 `native-tui-mirror-guard.test.ts` 独立覆盖，防止旧 history mirror completion 把新 Web 注入 native TUI turn 错误标回 idle/clean。
- terminal capability policy 已从 `RuntimeTerminalCoordinator` 抽出到 `runtime-terminal-capabilities.ts`，并由 `runtime-terminal-capabilities.test.ts` 独立覆盖 native TUI / terminal wrapper 的能力边界。
- session event 发布已从 `RuntimeTerminalCoordinator` 抽出到 `runtime-session-events.ts`，并由 `runtime-session-events.test.ts` 独立覆盖 created/started、attach、claim control 和 state changed 事件。
- `rah xxx` terminal handoff 运行时已从 `RuntimeTerminalCoordinator` 抽出到 `terminal-wrapper-session-runtime.ts`；wrapper registry、sender、preemptive interrupt、provider binding、prompt state 和 close/exited 处理不再挤在 coordinator 中。
- 完整 `npm run test:native-tui` 已再次通过，覆盖 typecheck、148 个 web 测试、367 个 runtime 测试、build、真实 CLI help probe、fake smoke、browser smoke、wrapper smoke 和 `git diff --check`。
- Codex Web 新建 native TUI session 隔离绑定回归已加入默认 runtime suite：新 session 的 `CODEX_HOME` wrapper home 与全局 `.codex/sessions` 隔离；同 cwd 的外部 Codex rollout 更新不会被误绑定到新 session，也不会把当前 Codex 对话输出 mirror 到新 session。
- 随后重新运行 `npm run test:smoke:native-browser-webkit` 通过，覆盖 WebKit 近似环境下 Codex mobile input bridge 以及 Claude/Gemini/Kimi/OpenCode 的 Chat/TUI、Stop、replay、foreground recovery。
- 随后重新运行 `RAH_NATIVE_REAL_TUI_PROBE_OUTPUT=test-results/native-real-tui-launch.json npm run test:smoke:native-real-tui-launch` 通过，五家真实官方 TUI 均能进入 RAH PTY host、3 秒内不退出并可关闭。
- `RAH_NATIVE_QA_STATUS_OUTPUT=test-results/native-qa-status.json npm run test:smoke:native-qa-status` 已通过，自动证据完整；剩余真实模型、权限弹窗、账号/额度、iPad/Safari 真机输入法等仍列为人工 QA。
- `npm run test:smoke:native-browser-webkit` 已通过：WebKit 下 Codex mobile/touch TUI input bridge、canvas 点击聚焦输入桥，以及 Claude/Gemini/Kimi/OpenCode 的 Chat/TUI、Stop、replay 和 foreground recovery 均通过自动近似验证。
- WebKit 近似 Safari 环境下，mobile/touch TUI input bridge 也能渲染并完成快捷键、文本输入和 composition 输入验证。
- `terminal-viewport.test.ts` 已加入默认 `test:web`，锁定键盘 inset、visual viewport offset、terminal 可见高度和 fixed panel anchor 计算；WebKit/Chromium browser smoke 也覆盖了移动端 terminal canvas 点击聚焦输入桥。
- 移动端 terminal 已改为在键盘活跃时按 `visualViewport` 把 terminal panel 固定到当前 pane 的可见矩形，并将输入桥贴到键盘上方；这只能近似 Blink iOS 的 native `keyboardLayoutGuide/inputAccessoryView` 行为，真机 iPad/Safari 仍需人工 QA。
- browser smoke 已增加 browser runtime preflight：本机 Firefox runtime 缺失时会在 daemon/session 启动前以 `phase: "browser_preflight"` 失败；Chromium 与 WebKit preflight 后的 Codex/provider browser smoke 已通过。
- WebKit provider browser smoke 已覆盖 Claude/Gemini/Kimi/OpenCode 的 prompt-dirty 防误注入路径，并推动修复了 delayed Claude/Gemini 类 history mirror 覆盖 `prompt_dirty` 的 race；`prompt_dirty` 现在优先于 final-state assistant mirror，且 Claude/Gemini 各有后端专属回归测试。
- 五家真实 provider TUI 已通过可选真实启动探针：实际启动官方 TUI，等待 3 秒确认未崩溃，然后通过 RAH PTY host 关闭；报告已记录 RAH branch / commit / dirty 状态，以及 raw/visible output 区分。该探针不发送模型问题，因此只证明真实 launch/PTY/close，不证明真实模型回答。
- 2026-05-03 重新运行 `RAH_NATIVE_REAL_TUI_PROBE_OUTPUT=test-results/native-real-tui-launch.json npm run test:smoke:native-real-tui-launch` 通过；五家真实 TUI 均能启动和关闭，且未留下 `test-results/native-real-tui-workspaces` 下的残留进程。该次真实输出观察到 Claude 在新测试工作区展示官方 trust-folder safety prompt，后续人工 QA 需要在 TUI 中确认该类官方交互。
- 2026-05-03 最新真实启动探针再次通过；Codex / Gemini 在 3 秒窗口内可能只有 raw terminal output 或暂无可见字符，Claude 显示 trust-folder safety prompt，Kimi 显示 `Kimi-k2.6` welcome，OpenCode 显示 TUI 首页。这仍只证明真实 TUI launch/PTY/close，不证明真实模型回答。

仍不由自动验收覆盖：

- 真实模型长时间回答、账号登录、额度耗尽、真实权限弹窗。
- Codex `/goal`、Claude trust-folder / permission prompt、Gemini Google 登录/429、Kimi long-running turn、OpenCode 真实 resume/model/interrupt。
- iPad / Safari 真机输入法 composition、真实拖拽 resize、旋转、PWA 后台恢复。
