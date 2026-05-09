# RAH Native Local Server 重构计划

Date: 2026-05-09

Branch: `refactor/native-local-server-core`

Base commit: `3764bbb Prepare council integration and native TUI catalogs`

Completion audit: `/Users/sun/Code/repos/rah/RAH_NATIVE_LOCAL_SERVER_COMPLETION_AUDIT.zh-CN.md`

Manual QA checklist: `/Users/sun/Code/repos/rah/RAH_NATIVE_LOCAL_SERVER_MANUAL_QA.zh-CN.md`

## 目标

RAH 的核心定位是“无缝衔接的 AI 工作台”：用户在桌面主机上启动原生 CLI agent 工作，离开桌面后可以在 Web/PWA/iOS/iPad 继续监控和对话，回到桌面后仍能衔接同一个真实 session。这个目标不是普通 chatbox，也不是只做 SDK 调用器。

本轮重构要把三家 provider 的运行时边界定清：

- Codex: 走官方 `native_local_server`，以 Codex app-server 的结构化事件流作为 live source of truth。第一阶段只承诺结构化 Web live/control；Codex TUI remote client 与同 thread 多端同步必须实测通过后，才能声明 TUI continuity。
- OpenCode: 走官方 `native_local_server`，以 OpenCode serve/attach/session API 的结构化事件流作为 live source of truth。OpenCode attach/client 是优先验证对象，但仍必须用真实双端同步测试证明。
- Claude: 保留 `zellij/tui_mux_fallback`，因为 Claude Code 当前没有 Codex/OpenCode 等价的本地 self-hosted app-server。Claude 可后续增加 SDK/ACP/cloud remote 作为可选模式，但不作为默认连续性核心。

最终要避免 RAH 继续把所有 provider 都强行压进同一个 zellij/PTY/TUI 屏幕解析主链路。Codex/OpenCode 应该借力官方本地协议；Claude 才需要 TUI mux fallback。

## 运行时策略结论

这次重构不是“放弃 zellij”，而是把 zellij 从所有 provider 的默认主链路降级为长期保留的 TUI fallback runtime。

- Codex/OpenCode 有 native local server 能力时，应优先走官方本地 server。这样 Web chat 不再模拟键盘输入，也不依赖 TUI 屏幕解析。
- Claude 当前没有等价 native local server。为了保留 RAH 的杀手级能力，即桌面原生 TUI 与 Web/PWA 的 live 接续，Claude 必须继续保留 zellij/TUI mux。
- zellij/TUI mux 也是未来新 provider 的万能 fallback：只要某个 CLI 有可用 TUI 但没有 server API，RAH 仍然可以先接入。
- `capsule-code` 的 tmux + FIFO + log tail 方案可以作为 Claude headless/stream-json 自动化 runtime 的参考，但不能替代 RAH 的 Claude TUI mux 主线。它运行的是长期 `claude --print --input-format=stream-json --output-format=stream-json` 进程，不能完整使用交互式 Claude TUI 的 `/command`、插件菜单、快捷键和原生交互。
- Claude `--sdk-url`/internal WebSocket 这类逆向内部协议默认不采用。它可以作为实验项，但不能作为生产默认路径，除非未来官方公开并承诺兼容。

## 当前源码事实与约束

这部分用于防止后续实现把“目标架构”误读成“当前已验证事实”。

- Codex 源码中 `codex app-server` 是本地 JSON-RPC server。RAH 当前已支持 stdio 与 WebSocket 两种 app-server transport；真实 Codex 默认走 `codex app-server --listen ws://127.0.0.1:0`，测试/mock binary 仍可走 stdio fallback。
- Codex remote TUI 方向已用 Codex 0.130.0 实测通过：`codex --remote <ws-endpoint> resume <threadId>` 可以接入 RAH 管理的 app-server/thread，并且 Web/API -> TUI、TUI -> Web/API marker 双向同步成立。该能力由 `scripts/native_local_server_probe.ts` 复验。
- Codex `threadId` 不应从 rollout 文件或第一条用户消息反推。稳健路径是 RAH 先通过 app-server `thread/start` 预创建 thread 并拿到 `threadId`，再让本地 TUI 执行 `codex --remote <ws-endpoint> resume <threadId>` 接入同一 thread。只有在未来明确需要“外部 TUI 先创建 thread”的模式时，才考虑独立 app-server + `thread/loaded/list` 归属推断；共享 app-server 上的 list-diff 只能作为诊断手段，不能作为默认绑定策略。
- 因此 Codex 在当前分支可声明为 `structuredLiveEvents: available`、`structuredControl: available`、`tuiContinuity: available`、`crossClientSync: available`。但 real model turn、interrupt、archive lifecycle 仍需继续以 provider smoke 和人工测试确认。
- OpenCode 源码存在 `serve` 与 `attach <url>` 这类明确 client/server 形态，优先尝试把 OpenCode 做成 `structuredLiveEvents: true` 且 `tuiContinuity: true`。RAH 的 attach 必须绑定精确 provider session，例如 `opencode attach <url> --session <providerSessionId>`；只连接 server URL 不足以证明回到了同一个会话。但如果 attach client 与 Web API 不能稳定同步同一 session，也必须降级声明。
- Claude Code 当前没有已公开、稳定、等价的本地 app-server。Claude 默认 runtime 仍是 `tui_mux_fallback`；SDK/headless/stream-json 是自动化可选 runtime，不是原生 TUI 连续性的替代。
- `native_local_server` 和 `tuiContinuity` 必须拆开表达。一个 provider 可以拥有可靠结构化 Web control，但暂时没有可靠 TUI client continuity。

最终 runtime 分层：

```ts
type ProviderRuntimeKind =
  | "native_local_server"       // Codex/OpenCode 主线
  | "tui_mux_fallback"          // Claude 主线 fallback，以及未来无 server CLI
  | "stream_json_fifo"          // Claude/Council 自动化可选模式，非交互式 TUI
  | "native_cloud_remote"       // 官方云端 remote control，未来可选
  | "internal_experimental";    // 逆向内部协议，默认禁用
```

协议稳定性等级也必须显式记录：

```ts
type ProtocolStability =
  | "official_stable"              // 官方文档/SDK/API
  | "project_native"               // provider 项目源码内的一等本地 server 能力
  | "tui_stdio"                    // stdin/stdout/TUI 标准能力，笨但抗漂移
  | "reverse_engineered_internal"; // 未公开内部协议，高维护成本
```

RAH 的默认路径只能依赖 `official_stable`、`project_native`、`tui_stdio`。`reverse_engineered_internal` 只能用于实验，不进入默认用户路径。

## 不变量

1. Codex/OpenCode 的 live 主链路不得再依赖 TUI 屏幕、prompt clean、ANSI 输出或 zellij viewport 作为状态真相。
2. Codex/OpenCode 的 Web chat 发送、stop、中断、turn 状态、工具调用、权限事件，优先走官方结构化协议。
3. Provider 原生历史文件/DB 仍然是 history source of truth。RAH 不新建一套替代 provider session DB。
4. TUI 仍然保留；在 OpenCode 中优先验证为 client/view，不再是 session owner。Codex 只有在官方 remote TUI client 与 RAH app-server 同步验证通过后，才能同样声明为 client/view。
5. Claude 的限制必须显式暴露为 provider runtime capability，不能假装它拥有本地 native server。
6. 所有能力必须进入 provider adapter/transport 协议层，不允许 UI 或 runtime-engine 对某家 provider 写散落的特殊逻辑。
7. 前端不再承担 live/history 文本启发式去重的主责任。provider adapter 必须提供稳定 event identity 或明确标记 fallback。
8. 任何“运行中切模型/权限/plan”的能力都必须由 provider transport 声明支持；不支持时 UI 不显示或禁用，而不是假装可改。
9. `native_local_server` 只有在真实验证 Web client、本地 TUI client、history 三方能同步同一个 provider session 后，才能标记 `tuiContinuity: true`。否则该 provider 只能声明为结构化 Web runtime，不能替代 zellij fallback。
10. live 期间的 source of truth 顺序必须明确：Codex/OpenCode 优先 provider server event；provider history 只做 backfill/audit；TUI screen 只做用户可视化，不参与普通 chat timeline 判定。Claude fallback 则相反：TUI/zellij 维持现场，JSONL/history parser 负责结构化 chat。
11. `structuredLiveEvents`、`structuredControl`、`tuiContinuity`、`supportsCrossClientSync` 是不同能力，不得为了 UI 简化合并成一个布尔值。
12. provider local server 的 endpoint、auth token、attach command、进程 pid、最后 event cursor、最后错误必须进入 diagnostics；缺这些信息时不能进入默认主链路。
13. 真实 provider 探针结果优先级高于源码推断和文档假设。任何未被探针证明的能力只能标记为 `unverified`、`experimental` 或 `false`。
14. UI 能力展示必须只消费 provider runtime capability truth table；不能因为 provider 名字、旧经验或目标架构去点亮按钮。

## 目标架构

### Provider Runtime Kind

新增或收敛为明确运行时类型：

```ts
type ProviderRuntimeKind =
  | "native_local_server"
  | "tui_mux_fallback"
  | "stream_json_fifo"
  | "internal_experimental"
  | "native_cloud_remote";
```

含义：

- `native_local_server`: provider 官方本地 server 管 session，RAH 作为 client 接入。适用于 Codex/OpenCode。
- `tui_mux_fallback`: RAH 通过 zellij/PTY/handoff 维持 TUI 工作现场，结构化 chat 主要来自 provider 历史文件解析。适用于 Claude 默认模式。
- `stream_json_fifo`: 长期 headless provider 进程通过 FIFO/JSON 输入、JSON 输出流返回事件。可参考 `capsule-code`，适合 Claude/Council 自动化，不适合原生 TUI 无缝接续。
- `internal_experimental`: 未公开或逆向内部协议，只能实验性启用，默认不可进入普通用户路径。
- `native_cloud_remote`: provider 官方云端 remote control。Claude Code 有这个方向，但不是本轮默认主线。

### 能力拆分

`native_local_server` 不等于“所有能力都完成”。至少要拆成下面几层：

- `structuredLiveEvents`: Web 能从 provider server 拿到 turn/message/tool/error/usage 等结构化事件。
- `structuredControl`: Web 能通过 provider server 发送 prompt、interrupt、permission response 等控制动作。
- `historyBackfill`: provider 原生历史文件/DB 能与 live event 用 canonical identity 合并。
- `tuiClientContinuity`: 本地或 Web TUI client 能接入同一个 provider session/thread，并看到同一条 timeline。
- `crossClientSync`: Web 发、TUI 发、history backfill 三者最终一致。

Codex 可以先完成前三项，再验证后两项。OpenCode 应优先验证五项一起成立。Claude fallback 主要依赖 TUI continuity 和 history backfill，而不是 provider server events。

### Transport Adapter

抽象一层 live transport，而不是让 runtime-engine 直接知道 Codex app-server、OpenCode serve、Claude zellij。

建议接口方向：

```ts
type LiveTransportCapabilities = {
  runtimeKind: ProviderRuntimeKind;
  supportsStructuredLiveEvents: boolean;
  supportsNativeTuiClients: boolean;
  supportsWebSend: boolean;
  supportsInterrupt: boolean;
  supportsRuntimeModelChange: boolean;
  supportsRuntimeModeChange: boolean;
  supportsPrelaunchModelSelection: boolean;
  supportsPrelaunchModeSelection: boolean;
  supportsCrossClientSync: boolean;
  supportsAttachCommand: boolean;
};

type LiveTransportSession = {
  provider: "codex" | "claude" | "opencode";
  rahSessionId: string;
  providerSessionId: string | null;
  runtimeKind: ProviderRuntimeKind;
  subscribeEvents(listener: (event: ProviderLiveEvent) => void): () => void;
  sendInput(input: ProviderInput): Promise<void>;
  interrupt(): Promise<void>;
  dispose(reason: string): Promise<void>;
};
```

实际实现可以渐进，不要求一次性把所有字段落地，但概念边界必须清楚。

### 运行时可观测性

每个 live session 的 Info/diagnostics 必须能回答这些问题：

- 当前走哪个 runtime：`native_local_server`、`tui_mux_fallback`、`stream_json_fifo` 等。
- live source of truth 是什么：provider server event、provider history watcher、还是 RAH legacy structured。
- provider session/thread id 是什么，RAH session id 和 provider id 如何对应。
- 如果存在本地 TUI client，如何 attach 回来，以及当前 TUI surface owner 是谁。
- 最后一次 provider event cursor/line/db row 是什么。
- 最后一次 transport error 是什么，以及是否已经降级 fallback。

这些信息不是 UI 装饰，而是后续排查“thinking 卡住”“重复输出”“TUI 没同步”的必要证据。

### Timeline

RAH UI 仍然只吃统一 timeline：

```txt
provider live event / provider history row
  -> adapter normalize
  -> canonical timeline item
  -> runtime event bus
  -> web UI
```

Codex/OpenCode:

- live 期间以官方 server event id/turn id/item id 为主身份。
- history 浏览以原生 rollout/db 文件为来源。
- live/history 合并只按 canonical id/upsert，不再以文本相同为主判断。

Claude:

- live TUI mux 期间以历史 JSONL watcher/parser 作为结构化 chat 来源。
- zellij 只负责 TUI surface continuity。
- 无法得到稳定原生 live id 的地方必须标记 identity confidence，不能混进 native server 级别语义。

## 分阶段实现

### Phase 0: 保持当前分支可回滚

目标：

- 当前 `experiment/zellij-mux-backend` 已在 `3764bbb` 提交。
- 本分支只做 native local server 重构，不再混入无关 UI 大改。
- 保留 zellij 代码作为 Claude fallback 和回滚路径。

验收：

- `git status` 干净。
- 当前分支名为 `refactor/native-local-server-core`。
- 文档和代码提交可以独立回退。

### Phase 1: Provider Runtime Boundary

目标：

- 在 runtime protocol 和 daemon adapter 中明确 `runtimeKind`。
- Session summary、session info、capability response 能告诉前端当前 session 是 native server 还是 mux fallback。
- UI 不根据 provider 名字猜能力，而根据 capability 决定展示按钮。

任务：

- 扩展 provider capability schema。
- 给 Codex/OpenCode/Claude 分别声明 runtime kind。
- 清理散落在 UI 的 provider 特判。
- 加 adapter contract tests。

验收：

- 前端 session control 能根据 capability 显示或禁用 model/mode/plan/stop/TUI。
- Claude 不再被误认为拥有 Codex/OpenCode 的 native server 能力。

### Phase 1.5: Native Local Server Probe Harness

目标：

- 在真正切换 Codex/OpenCode 默认主链路前，先落一个可重复运行的真实 provider 探针。
- 探针用于确认当前机器、当前 provider 版本、当前账号配置下，native local server 能力到底存在到什么程度。
- 探针输出应成为 `runtime capability truth table` 的事实来源之一。

任务：

- 新增 `scripts/native_local_server_probe.ts` 或等价脚本。
- 默认低风险运行，不发起付费模型 turn；只验证 server 启动、initialize/capability、session create/load、attach command 可构造。
- Codex 探针至少验证 `codex app-server` 可启动、initialize 成功、基础 capability/命令可调用，并记录当前 Codex 版本。
- OpenCode 探针至少验证 `opencode serve` 可启动、session 可创建/读取、`opencode attach <endpoint> --session <providerSessionId>` 命令可生成，并记录当前 OpenCode 版本。
- 需要显式区分 `pass`、`fail`、`unverified`、`unsupported`。Codex stdio fallback 没有 websocket endpoint 时 attach diagnostics 可以是 `unavailable`，但真实默认 WebSocket transport 必须以 remote TUI/cross-client probe 结果决定 `tuiContinuity` 和 `crossClientSync`。
- 探针输出 JSON，包含 provider、version、runtimeKind、capability、endpoint/attach 状态、错误摘要、是否允许进入默认路径。
- 探针不进默认 `npm test`，但必须在 cutover 前手动运行并保存结果。

验收：

- `npm run test:smoke:native-local-server` 或同等命令可运行。
- provider 缺失、未登录、端口占用、协议字段变化时，脚本能失败得清楚，而不是挂起。
- 文档中的 capability truth table 与最近一次探针结果一致。

常用命令：

```bash
# 默认低风险探针：不发模型请求。
npm run test:smoke:native-local-server

# 真实 turn 探针：会向 provider 发送一次短问题，可能产生模型调用成本。
RAH_NATIVE_LOCAL_SERVER_PROBE_REAL_TURN=1 npm run test:smoke:native-local-server

# 中断探针：在真实 turn 基础上测试 interrupt/abort。Codex 短 turn 可能过快完成，此时 interrupt 保持 unverified。
RAH_NATIVE_LOCAL_SERVER_PROBE_REAL_TURN=1 RAH_NATIVE_LOCAL_SERVER_PROBE_INTERRUPT=1 npm run test:smoke:native-local-server

# OpenCode attach client 探针：用系统 PTY 启动 `opencode attach <url> --session <id>`。
# 这只能证明 attach client 能接入并保持运行；Web/TUI 双向 timeline 同步仍需要 cross-client sync probe。
RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=opencode RAH_NATIVE_LOCAL_SERVER_PROBE_OPENCODE_ATTACH=1 npm run test:smoke:native-local-server

# OpenCode cross-client sync 探针：会发真实 turn，验证 Web/API -> attach client 和 attach client -> server timeline。
# 这个命令可能产生模型调用成本；只有通过后才能把 OpenCode crossClientSync 从 unverified 提升为 available。
RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=opencode RAH_NATIVE_LOCAL_SERVER_PROBE_OPENCODE_CROSS_CLIENT=1 npm run test:smoke:native-local-server

# Codex remote TUI/cross-client sync 探针：不发模型请求，使用 thread/shellCommand marker 验证同 thread 双向同步。
RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=codex RAH_NATIVE_LOCAL_SERVER_PROBE_CODEX_REMOTE_TUI=1 npm run test:smoke:native-local-server
```

### Runtime Capability Truth Table

这张表是开发过程中的真相表。实现和 UI 必须以它为准，不能以目标架构推断能力。

协议字段对应为 `SessionRuntimeDescriptor.features`。状态值使用：

- `available`: 当前实现和测试认为该能力可用。
- `unverified`: 目标上可能可用，但还缺真实 provider probe 或人工验收。
- `unsupported`: 当前 runtime 明确不支持。
- `experimental`: 仅实验入口，不进入默认用户路径。

注意：

- `features.*` 只能使用上面四个状态。`unavailable` 只能作为 provider endpoint/attach endpoint 的诊断状态，例如“当前 Codex stdio app-server 没有 websocket endpoint”，不能写进 runtime feature status。
- `tuiClientContinuity` 表示 provider-native TUI/client 能否接入同一个 provider session 并保持连续性。zellij fallback 的连续性也可以是 available，但必须标明 runtime 是 `tui_mux_fallback`，不能和 native local server 混写。
- `crossClientSync` 表示 Web/API client、本地 TUI/client、history backfill 三者是否能看到同一个 timeline。只证明 attach client 能启动不等于 cross-client sync 通过。

| Provider | Runtime | Structured live | Structured control | History backfill | TUI continuity | Cross-client sync | Prelaunch config | Runtime config | Interrupt/archive | 默认状态 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Codex | native_local_server | available，real turn probe passed 2026-05-09 | available | yes | available，probe passed 2026-05-09 with Codex 0.130.0 WebSocket app-server + `codex --remote` | available，probe passed 2026-05-09 with Web/API <-> remote TUI marker sync | yes | available，next-turn model/mode | interrupt available，real probe passed 2026-05-09；archive lifecycle still needs browser/human QA | structured Web + remote TUI 双端同步已由 probe 证明 |
| OpenCode | native_local_server | available，real prompt probe passed 2026-05-09 | available | yes | available，probe passed with `opencode attach <url> --session <id>` | available，probe passed 2026-05-09 with OpenCode 1.14.41 | yes | available，ACP model/mode | abort/archive available，real probe passed 2026-05-09 | structured Web + attach 双端同步已由 probe 证明，版本升级后需复验 |
| Claude | tui_mux_fallback | no | no | yes | yes via zellij | best-effort | yes via CLI args/catalog | no，交给 TUI | zellij interrupt/archive covered by automated tests；needs human TUI QA | 默认 fallback |

表中 `需 probe` 的项目在真实探针通过前必须在 UI/Session Info 显示为 `unverified` 或不显示。

### Phase 2: Codex native_local_server 主链路

目标：

- Codex live session 以官方 app-server 作为主状态源。
- Web chat 直接调用 app-server turn API。
- Web live timeline 直接订阅 app-server JSON-RPC/event stream。
- 本地 TUI remote client 作为独立子目标已完成第一轮验证。当前 Codex native_local_server 承诺 Web structured live/control、official remote TUI continuity、real turn interrupt；archive lifecycle 仍是后续 browser/human QA 稳定化重点。

当前实测证据：

- 2026-05-09：`RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=codex RAH_NATIVE_LOCAL_SERVER_PROBE_CODEX_REMOTE_TUI=1 npm run test:smoke:native-local-server` 通过。Codex 0.130.0 WebSocket app-server、`codex --remote <endpoint> resume <threadId>`、Web/API -> TUI marker、TUI -> Web/API marker 均通过。
- 2026-05-09：`RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=codex RAH_NATIVE_LOCAL_SERVER_PROBE_REAL_TURN=1 RAH_NATIVE_LOCAL_SERVER_PROBE_INTERRUPT=1 npm run test:smoke:native-local-server` 通过。`turn/start`、`turn/interrupt request`、`turn completed with interrupted status` 均通过。
- 2026-05-09：`npm run test:smoke:native-codex-browser` 与 `RAH_NATIVE_BROWSER=webkit npm run test:smoke:native-codex-browser` 通过。浏览器 smoke 覆盖 Chat/TUI 切换、native TUI replay、chat composer -> native TUI、dirty prompt queue、Stop/idle、foreground recovery、canvas/mobile input bridge。

任务：

- 建立 Codex app-server lifecycle manager。
- 明确 app-server 是 daemon-wide、workspace-scoped 还是 session-scoped。MVP 可先 session-scoped，验证稳定后再优化为 daemon/provider-scoped。
- 实现 create/resume thread。
- 实现 turn/start、turn/interrupt、permission request/response。
- 实现 app-server event -> RAH timeline。
- 继续维护 official TUI remote client 接入 RAH 管理的 app-server/thread，并在 Session Info/diagnostics 中展示 endpoint、attach state、last cursor。
- 移除 Codex 主链路对 zellij prompt clean、ANSI、surface lease 的依赖。

验收：

- Web new Codex 后，Web chat 能收到结构化 live 输出。
- 本地 Codex TUI client 能连接同一 thread，看到 Web 发起的 turn。
- 本地 TUI 发起 turn 后，Web chat 能同步看到。
- 如果后续 Codex 版本破坏 remote TUI/cross-client sync，必须在 capability 中降级 `supportsCrossClientSync: false`，并保留 zellij fallback；不能用历史通过结果替代当前版本验证。
- 如果 Codex fallback 到 stdio app-server structured control，则该具体 session 的 diagnostics 必须显示没有 attach endpoint；不能误导用户认为当前 session 可 remote TUI attach。
- Stop/abort 不依赖 Esc/ANSI，走官方 interrupt。
- Codex 0.130.0 real turn interrupt probe passed 2026-05-09：`turn/interrupt` request accepted and final `turn/completed` carried interrupted status.
- 连续追问不会丢问题，不会重复用户问题或 assistant 回答。
- 历史刷新后可从原生 rollout 恢复同一 session。

### Phase 3: OpenCode native_local_server 主链路

目标：

- OpenCode live session 以官方 serve/session API 作为主状态源。
- Web chat 直接调用 OpenCode API。
- TUI 使用官方 attach/client 连接同一个 session。

当前实测证据：

- 2026-05-09：`RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=opencode RAH_NATIVE_LOCAL_SERVER_PROBE_OPENCODE_CROSS_CLIENT=1 npm run test:smoke:native-local-server` 通过。OpenCode 1.14.41 `opencode attach <url> --session <id>`、Web/API -> server timeline、Web/API -> attach client、attach client -> server timeline 均通过。
- 2026-05-09：`RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=opencode RAH_NATIVE_LOCAL_SERVER_PROBE_REAL_TURN=1 RAH_NATIVE_LOCAL_SERVER_PROBE_INTERRUPT=1 npm run test:smoke:native-local-server` 通过。`prompt_async`、`abort`、event stream、archive 均通过。
- OpenCode model/variant 的底层 ACP 拼接已有自动测试覆盖；Web UI 启动路径和真实账号模型组合仍保留为人类验收项。

任务：

- 建立 OpenCode server lifecycle manager。
- 复用/恢复模型列表与 variant 参数发现。
- 实现 session create/load/resume。
- 实现 prompt/interrupt。
- 实现 OpenCode event/db -> RAH timeline。
- 明确 opencode provider/model/variant 参数如何从 UI 传递到 server。
- `rah attach <sessionId>` 对 OpenCode `native_local_server` session 应直接执行 provider-native `opencode attach <serverUrl> --session <providerSessionId>`，而不是退回 PTY/zellij。
- 移除 OpenCode 主链路对 zellij action write 的依赖。

验收：

- Web new OpenCode 后，第一条问题能可靠进入 provider。
- 本地 `opencode attach` 和 Web chat 能双向同步。
- `rah attach <sessionId>` 能从 Session Info 暴露的 native server endpoint 进入同一 OpenCode server/session。
- 如果 OpenCode 当前版本不能让 attach client 与 Web API 实时共享同一 session timeline，必须降级能力声明，普通 Web chat 仍可用但不能声称实现 TUI continuity。
- Stop 能中断当前 turn，不退出整个 TUI/server。
- OpenCode 1.14.41 real prompt abort probe passed 2026-05-09：`abort` succeeded and server/session remained archivable.
- 模型与 variant 选择在真实请求中生效。
- OpenCode abort/error/tool/todo/reasoning 能按 RAH event taxonomy 展示。

### Phase 4: Claude tui_mux_fallback 稳定化

目标：

- Claude 默认继续走 zellij/TUI mux fallback，但边界要明确。
- Claude 不参与 Codex/OpenCode native server 假设。
- Claude 的 Web chat 操作要尽可能稳定，但不能承诺它有官方本地 server 级别能力。

当前实测证据：

- 2026-05-09：`RAH_ZELLIJ_REAL_TUI_PROBE_PROVIDERS=claude npm run test:smoke:zellij-real-tui-launch` 通过。真实 Claude Code 2.1.138 TUI 在 zellij 中启动，RAH diagnostics、dump-screen、PTY output 均可观测，archive/close 后 zellij session 被移除。
- 2026-05-09：`RAH_ZELLIJ_REAL_TUI_PROBE_PROVIDERS=claude RAH_ZELLIJ_REAL_TUI_PROBE_EXIT=1 RAH_ZELLIJ_REAL_TUI_PROBE_EXIT_INPUT=$'/exit\r' npm run test:smoke:zellij-real-tui-launch` 通过。RAH 观察到 provider exit input 后，live session、zellij session、pane 均退出。
- 上述探针不发送模型请求，不证明真实 Claude turn、Stop during thinking、quota、权限弹窗或 iOS/PWA 行为；这些仍保留为人类验收项。

任务：

- 保留 zellij session/pane lifecycle。
- archive 必须优雅结束 zellij session 和 Claude TUI，不能残留遮盖或空 zellij。
- 本地 terminal 与 Web TUI surface lease 必须明确：同一时刻只有一个 TUI surface attach。
- Web chat 的结构化显示继续来自 Claude JSONL parser/watcher。
- Stop 行为按 Claude 当前可行方式实现，并明确显示 abort info。
- 在 Session Info 中说明 Claude 当前 runtime kind 与 attach/restore 指令。

验收：

- `rah claude` 本地 TUI 可用，Web chat 可旁路展示历史/新增消息。
- Web TUI 接管后本地终端遮盖，归还后恢复。
- archive/exit/ctrl-c 状态能同步。
- 不再把 Claude 当成 `native_local_server` 来展示错误能力。

### Phase 5: Canonical Timeline 与去重

目标：

- Codex/OpenCode live/event/history 合流使用 canonical id。
- Claude fallback 也提供 best-effort identity，但不能污染 native id 语义。

任务：

- 定义 `canonicalItemId` / `canonicalTurnId` / `sourceCursor` / `identityStrength`。
- Codex: 使用 app-server thread/turn/item id，history rollout 使用 provider 原始 id 或 file cursor。
- OpenCode: 使用 server/db session/message/part id。
- Claude: 使用 JSONL uuid/parent uuid/line cursor。
- 前端 upsert 优先 canonical id，legacy 文本去重只作为旧数据 fallback。

验收：

- 同一句“继续”连续发两次必须显示两次。
- live 先到、history 后到不重复。
- history 先打开、live 后接入不重复。
- reasoning/tool/user/assistant/abort/error 都有覆盖测试。

### Phase 6: UI 与能力边界恢复

目标：

- 恢复并简化模型、参数、权限选择。
- 这些选择只在“启动前”默认可调。运行中仅当 transport 明确支持时才开放。

任务：

- New session composer 恢复 provider model/mode/option catalog。
- Resume/claim 前允许选择支持的 prelaunch config。
- Live session control 根据 capability 展示：
  - Codex/OpenCode 如果 native server 支持运行中设置，则开放。
  - Claude 默认不开放运行中改模型/权限，提示去 TUI 或重新启动。
- iOS/PWA 保持紧凑布局。

验收：

- UI 不出现“按钮能点但实际无效”的假能力。
- provider 模型/参数选择能在真实 session 请求里被证明生效。
- 权限模式描述不漂移，来自 provider catalog 或明确映射。

### Phase 7: Council 插件化集成

目标：

- Council 作为 RAH 独立页面/功能模块，复用 provider runtime、timeline、model catalog、session UI。
- 不引入 agent-council 的 Python 运行时作为生产核心。

任务：

- Council participant 配置使用 RAH provider catalog。
- 每个 participant 是一个 RAH provider session 或 provider transport child session。
- Council 聚合 timeline 为多 speaker chat：每个气泡标注 agent/provider/model。
- 底层 TUI 可通过 provider 的 TUI view 进入，不为 Council 单独造 TUI 技术栈。
- Council 代码保持模块边界，未来可移除。

验收：

- 可以创建 Codex/OpenCode/Claude 多 agent council。
- 每个 agent 的消息进入统一 council room。
- 单个 agent 出错不拖垮整个 council。
- Council 不破坏普通单 session 工作台。

### Phase 8: 测试策略

自动化测试：

- Unit: provider capability/catalog/runtime kind。
- Contract: Codex/OpenCode native server event mapping。
- Integration: fake native server for deterministic tests。
- Real smoke: 本机真实 Codex app-server、OpenCode serve、Claude zellij fallback。
- Web tests: composer prelaunch config、timeline upsert、session state。
- Capability truth tests: `structuredLiveEvents`、`structuredControl`、`tuiContinuity`、`supportsCrossClientSync` 分别断言，禁止因为 provider 名字误亮 UI。

必须新增的 drift/probe 测试：

- Codex/OpenCode local server protocol probe：启动、create/resume、send、interrupt、subscribe 都必须能跑通；失败时输出 provider 版本和协议错误。
- Cross-client sync probe：A client 发送的问题必须能被 B client 或 Web event stream 观察到；反方向也要测。
- Codex remote TUI probe：只有能证明 official TUI remote client 接入 RAH app-server 并同步同一 thread，才允许把 Codex `tuiContinuity` 标为 true。
- OpenCode attach probe：`opencode attach <url> --session <providerSessionId>` 必须能接入 RAH 管理的 server/session；Web 发和 attach client 发都必须被另一端观察到。
- History backfill probe：live turn 完成后重新读取 provider history，不得重复、不丢失、不改变 turn 顺序。
- Fallback probe：native server 不可用时，UI 必须显示降级或失败原因，不能无限 thinking。
- Security probe：local server 绑定地址、auth token、client/session 权限必须可检查；未经授权的 WebSocket/HTTP client 不得注入输入或读取 attach 信息。

人工测试清单：

1. Codex Web new -> Web chat 提问 -> 本地 TUI client 同步看到。
2. Codex 本地 TUI 提问 -> Web chat 同步看到。
3. Codex Stop/abort/连续追问/工具调用/权限请求。
4. Codex 历史刷新后不重复、不丢失、不乱序。
5. OpenCode Web new -> Web chat 提问 -> TUI attach 同步看到。
6. OpenCode TUI 提问 -> Web chat 同步看到。
7. OpenCode Stop/abort/模型 variant/工具调用。
8. Claude `rah claude` 本地 TUI -> Web chat 展示 JSONL 解析结果，并且 `/command` 等交互式 TUI 能力仍可在 TUI 中使用。
9. Claude Web TUI 接管/归还/archive/exit 同步。
10. iOS/PWA 仅浏览 chat 不误触发 TUI attach；只有进入 TUI view 才触发表面接管。
11. Claude zellij fallback 在本地 terminal、Web TUI、Web chat 三者之间不会出现孤儿 zellij、残留遮盖或 archive 后空 pane。
12. `stream_json_fifo` 如实现，只能作为 Claude/Council 自动化 runtime，不能替代 Claude 默认 TUI mux。
13. Codex/OpenCode provider server 崩溃、端口被占用、协议字段漂移时，Web UI 必须显示明确错误或 fallback，不得卡死。
14. Session Info 必须能看到 runtime kind、live source、provider id、attach 命令和最近错误，便于人类测试定位问题。
15. Codex 若仍处于 `tuiContinuity=false`，Session Info 必须明确写出“structured live 可用，TUI remote continuity 未验证/未启用”，避免误判。

人类测试记录格式：

- Provider 与版本：例如 `codex --version`、`opencode --version`、`claude --version`。
- RAH session id 与 provider session id。
- Runtime Info：runtimeKind、features truth table、attach state、server endpoint 是否存在、最近 cursor/error。
- 测试入口：Web new、Web resume、`rah <provider>`、`rah attach <sessionId>`。
- 测试动作：send、连续追问、stop/abort、archive/exit、history refresh、TUI attach/deattach、模型/权限启动参数。
- 结论：pass/fail/unverified，并附失败截图或错误文本。失败项不能靠推测改成 pass。

## Cutover Gate

某个 provider 从 fallback 切到默认 `native_local_server` 前，必须满足：

- 真实 provider smoke 通过，而不是只通过 fake server。
- Web send、interrupt、permission response、连续追问、工具调用、错误/abort 都来自 provider server event。
- provider 原生历史 backfill 后 timeline 不重复、不乱序。
- Session Info 能显示 provider server endpoint、attach 状态、provider session id、最后 cursor/error。
- native server 崩溃、端口占用、协议字段变化时，UI 能明确失败或降级，不会卡在 thinking。
- 如果声明 `tuiContinuity=true`，必须证明本地 TUI client 与 Web client 双向同步同一 session。
- 如果任何一项不满足，只能作为 experimental 或 fallback-disabled path，不能成为默认入口。

## 安全与生命周期边界

- local server 默认只绑定 localhost；如需局域网访问，必须通过 RAH daemon 的已有访问边界暴露，不直接暴露 provider server。
- attach/auth token 不得写入普通 timeline、browser log 或可复制的错误文本；Session Info 只在必要时展示可执行 attach 命令，并应尽量走一次性或短期 token。
- Web client 的 send/interrupt/attach 必须绑定 RAH session id 与 client/control lease，不允许只凭 provider endpoint 操作任意 session。
- archive 必须终止对应 provider server/session 或解除 RAH 管理关系，不能留下孤儿 server、zellij pane、遮盖状态或 stale live state。
- provider server crash 必须转换成明确 runtime failure event，并允许用户重新创建/降级，而不是继续显示 idle 或 thinking。

## 当前验证状态

2026-05-09 当前分支 `refactor/native-local-server-core` 的自动化与 smoke 状态：

- `npm run typecheck` 通过。
- `git diff --check` 通过。
- `npm run test:web` 通过，166 pass。
- `npm run test:provider-contracts` 通过，167 pass。
- `npm run test:runtime` 通过，404 pass。
- `npm run build:web` 通过。
- `npm run test:smoke:native-local-server` 通过；Codex 0.130.0 app-server initialize、OpenCode 1.14.41 serve/session/archive 均通过。
- `RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=codex RAH_NATIVE_LOCAL_SERVER_PROBE_CODEX_REMOTE_TUI=1 npm run test:smoke:native-local-server` 通过；Web/API -> Codex remote TUI、remote TUI -> Web/API 双向 marker 同步通过。
- `RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=codex RAH_NATIVE_LOCAL_SERVER_PROBE_REAL_TURN=1 RAH_NATIVE_LOCAL_SERVER_PROBE_INTERRUPT=1 npm run test:smoke:native-local-server` 通过；`turn/start`、`turn/interrupt request`、event stream、`turn completed with interrupted status` 均通过。
- `RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=opencode RAH_NATIVE_LOCAL_SERVER_PROBE_OPENCODE_CROSS_CLIENT=1 npm run test:smoke:native-local-server` 通过；Web/API、OpenCode attach client、server timeline 双向 marker 同步通过。
- `RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=opencode RAH_NATIVE_LOCAL_SERVER_PROBE_REAL_TURN=1 RAH_NATIVE_LOCAL_SERVER_PROBE_INTERRUPT=1 npm run test:smoke:native-local-server` 通过；`prompt_async`、`abort`、event stream、archive 均通过。
- `RAH_ZELLIJ_REAL_TUI_PROBE_PROVIDERS=claude npm run test:smoke:zellij-real-tui-launch` 通过；真实 Claude Code 2.1.138 可被 zellij fallback 启动、观测并 archive 清理。
- `RAH_ZELLIJ_REAL_TUI_PROBE_PROVIDERS=claude RAH_ZELLIJ_REAL_TUI_PROBE_EXIT=1 RAH_ZELLIJ_REAL_TUI_PROBE_EXIT_INPUT=$'/exit\r' npm run test:smoke:zellij-real-tui-launch` 通过；Claude `/exit` 后 RAH live session、zellij session、pane 均退出。
- `npm run test:smoke:native-codex-browser` 与 `RAH_NATIVE_BROWSER=webkit npm run test:smoke:native-codex-browser` 通过；覆盖 Codex native TUI replay、Chat/TUI 切换、dirty prompt queue、Stop、reload/foreground recovery、canvas/mobile input bridge。
- `npm run test:smoke:native-provider-browser` 与 `RAH_NATIVE_BROWSER=webkit npm run test:smoke:native-provider-browser` 通过；覆盖 Claude zellij fallback 与 OpenCode native provider 的 Chat/TUI、dirty prompt、Stop/idle、TUI replay、foreground recovery，以及 OpenCode DB mirror reasoning/tool/usage。
- `RAH_NATIVE_BROWSER=firefox npm run test:smoke:native-codex-browser` 与 `RAH_NATIVE_BROWSER=firefox npm run test:smoke:native-provider-browser` 通过；Firefox smoke 覆盖桌面 Chat/TUI/Canvas/Stop/replay/foreground recovery。移动端 input bridge 子用例只在 Chromium/WebKit 跑，因为 Playwright Firefox 不支持 mobile context。
- `npm run test:smoke:native-manual-qa-status` 仍失败是预期状态：26 项人工 QA 仍是 `pending`，包括真实 Web/PWA/iPad、真实 provider 长 turn、权限弹窗、Stop、连续追问、archive/history recover 等。
- `test-results/native-manual-qa.json` 模板已按当前 worktree 生成；manual QA verifier 会校验 `worktreeFingerprint`，防止同一 commit 下的 dirty diff 漂移导致旧 QA 结果误通过。

## 明确不做

- 不恢复 Gemini/Kimi CLI 一等 provider。
- 不把 Claude 强行做成 `native_local_server`。
- 不把 Claude SDK/headless/stream-json 当成原生 TUI 无缝接续的替代品。
- 不采用 Claude `--sdk-url` 等未公开内部协议作为默认主线。
- 不用自研 PTY mux 继续追 tmux/zellij 级别终端语义。
- 不把 RAH 做成 provider session 数据库的替代品。
- 不为了统一 UI 而隐藏 provider 能力差异。
- 不把 Council 深度耦合进普通 session runtime。

## 风险与应对

### Codex/OpenCode 官方协议继续变化

应对：

- adapter 只依赖最小稳定能力：create/resume/send/interrupt/subscribe。
- provider event mapping 以 contract tests 锁定。
- 保留 fallback 诊断，不静默失败。

### Claude fallback 体验不如官方 native server

应对：

- UI 明确显示 Claude runtime kind。
- Claude 保留原生 TUI 优先，不把 SDK/headless 伪装成 live attach。
- zellij/TUI mux 必须把 archive/exit/attach/deattach 生命周期做稳，这是 Claude 无缝接续的生产路径。
- 后续可实验 Claude official Remote Control、ACP 或公开 local server，但不阻塞本轮。
- `capsule-code` 类 stream-json/FIFO 方案只吸收其 cursor、buffer、JSON 解析经验，不照搬为主运行时。

### 逆向内部协议诱惑

应对：

- 默认拒绝 `--sdk-url` 这类 hidden flag 作为生产能力。
- 如果未来研究，必须隔离为 `internal_experimental` runtime。
- 进入默认路径前必须具备协议快照、合约测试、漂移监控和明确回滚开关。

### Native server 与历史文件合并仍重复

应对：

- Phase 5 前就为 Codex/OpenCode live 事件使用 provider 原生 id。
- history backfill 只补缺口，不覆盖已确认 live turn。
- 前端 text/time dedupe 降为 legacy fallback。

### Council 扩大复杂度

应对：

- Council 只复用 provider runtime，不改 provider runtime。
- Council 有独立 namespace、store、route、tests。
- Council 不成为 native server 重构的阻塞项。

## 成功标准

这次重构成功不是“所有 provider 长得一样”，而是：

- Codex/OpenCode 的 live 链路比 zellij/PTY 更稳、更结构化、更少补丁。
- Claude 的 fallback 边界清晰，不再拖累 Codex/OpenCode 的架构。
- Web/PWA 可以继续承担 RAH 的核心场景：桌面 agent 工作的移动衔接。
- 普通 session、history、TUI view、Council 都复用同一套 provider capability/timeline 基础设施。
- 后续 provider 更新时，RAH 主要维护 adapter contract，而不是反复修 TUI 屏幕解析和 prompt 状态猜测。
