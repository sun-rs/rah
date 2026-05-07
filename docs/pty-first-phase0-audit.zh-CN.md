# PTY-First Phase 0 代码盘点审计

日期：2026-05-07

分支：`refactor/pty-first-core`

依据：

- 根目录 `RAH_PTY_FIRST_SEAMLESS_WORKBENCH_PLAN.zh-CN.md`
- 根目录 `desgin.md`
- 当前代码状态

## 1. Phase 0 目标拆解

Phase 0 不做大规模删除。目标是先把当前代码按新边界分类，并找出阻碍 “唯一 PTY Session Runtime” 的重复路径。

| 目标 | 证据 | 当前状态 |
|---|---|---|
| 确认当前分支 | `git rev-parse --abbrev-ref HEAD` 输出 `refactor/pty-first-core` | 已确认 |
| 读取最高边界文件 | `RAH_PTY_FIRST_SEAMLESS_WORKBENCH_PLAN.zh-CN.md` | 已确认 |
| 读取用户 goal 文件 | `desgin.md` | 已确认 |
| 盘点 core / mirror / enhancement / legacy structured | 本文第 2-5 节 | 已完成 Phase 0 初版 |
| 找出 Web new / Web claim / rah xxx / rah xxx resume 重复生命周期 | 本文第 6 节 | 已完成 Phase 0 初版 |
| 不把测试通过当作完成信号 | 本次只改文档，不声明实现完成 | 已遵守 |

## 2. Core PTY 模块

这些模块属于 PTY-first 主链路，应保留并继续收敛。

| 模块 | 当前职责 | Phase 1 方向 |
|---|---|---|
| `pty-hub.ts` | PTY output seq/replay、exit replay、WebSocket 输出来源 | 保留为核心；作为所有 attach client 的 replay 基础 |
| `independent-terminal.ts` | daemon 内启动 shell/TUI 的 PTY process wrapper | 保留；后续成为 PTY session runtime 的 process 层 |
| `runtime-terminal-coordinator.ts` | 当前同时管理 independent terminal、daemon-owned native TUI、terminal wrapper façade | 需要瘦身；把 PTY create/attach/control 生命周期抽成唯一 runtime |
| `runtime-session-events.ts` | attach、claim、created/started/state event 统一发布 | 保留；作为 client attach/control event 层 |
| `session-store.ts` | live session、attached clients、control lease、runtime state | 保留；后续明确 detach 不等于 close |
| `http-server-websocket.ts` | PTY WebSocket input/output/resize/replay | 保留；后续统一 Web/PWA/canvas attach 行为 |
| `TerminalPane.tsx` | Web/canvas TUI 渲染、input bridge、fromSeq replay | 保留；Phase 4 继续优化 PWA/iOS |
| `terminal-viewport.ts` / tests | visual viewport / keyboard inset 计算 | 保留；Phase 4 继续强化真机 QA |

当前已符合的 PTY-first 部分：

- Web native TUI session 已由 daemon `IndependentTerminalProcess` 启动真实 TUI。
- `onData` 会写入 `PtyHub.appendOutput()`，Web 通过 `TerminalPane` 接收 `pty.output`/`pty.replay`。
- `handlePtyInput()` 和 `handlePtyResize()` 已可向 daemon-owned TUI PTY 写入 input/resize。
- Web reload 可基于 `fromSeq` replay。

当前未完全符合的部分：

- `RuntimeTerminalCoordinator` 仍同时持有 native TUI runtime、independent terminal、terminal wrapper façade，职责过宽。
- daemon-owned native TUI 与 `rah xxx` wrapper 没有统一成同一个 create/resume PTY runtime。
- 当前 close native TUI 会关闭 process；detach 与 close 的边界还需要在所有入口上统一校验。

## 3. Structured Mirror 模块

这些模块属于 “原厂 jsonl/db/session 文件 -> WebUI 友好展示” 的 structured truth，不应和 PTY lifecycle 混在一起。

| 模块 | 当前职责 | Phase 3 方向 |
|---|---|---|
| `native-tui-provider-runtime.ts` | 分发 launch spec、binding probe、output observation、mirror update | 拆分：launch/binding 留 provider runtime，mirror 进入独立 mirror layer |
| `native-tui-*-provider-handler.ts` | 各 provider 的 binding/mirror handler | 保留 provider-specific 能力，但把 mirror parser 与 PTY runtime 解耦 |
| `codex-rollout-activity.ts` | Codex rollout JSONL -> provider activity | mirror core，继续保留 |
| `claude-session-files.ts` | Claude JSONL -> stored activity/history | mirror core，继续保留 |
| `gemini-session-files.ts` / `gemini-conversation-utils.ts` | Gemini conversation JSON/JSONL -> history/mirror | mirror core，继续保留 |
| `kimi-session-files.ts` | Kimi wire/session files -> activity/history | mirror core，继续保留 |
| `opencode-activity.ts` / `opencode-stored-sessions.ts` | OpenCode DB/API-backed records -> activity/history | mirror core，继续保留 |
| `history-snapshots.ts` | materialized/frozen history 去重和 paging snapshot | mirror/workbench core，继续保留 |
| `*-timeline-identity.ts` | canonical identity | mirror core，继续保留 |

当前已符合的部分：

- Codex/Claude/Gemini/Kimi/OpenCode 的 Chat mirror 都来自原厂文件/DB/records，而不是 ANSI screen scrape。
- `NativeTuiMirrorUpdate` 已显式支持 `missing` / `failed` / `unsupported`，并由 diagnostics 记录。
- `RuntimeTerminalCoordinator.mirrorNativeTuiSession()` 对 mirror failure 做 warning/diagnostics，不直接杀 TUI process。

当前未完全符合的部分：

- mirror tick 仍由 `RuntimeTerminalCoordinator` 直接调度并应用，导致 PTY runtime 仍知道太多 structured mirror 细节。
- `NativeTuiProviderRuntime` 同时负责 launch spec、binding、mirror，Phase 3 应拆成更窄接口。

## 4. Enhancement 模块

这些能力可以保留，但不能阻塞 PTY-first core，也不能再被视为统一 provider 控制台主线。

| 能力/模块 | 当前职责 | 后续定位 |
|---|---|---|
| `session-mode-utils.ts` | provider mode descriptors、external_locked mode | 降级为 optional enhancement；native TUI 默认 external locked |
| `session-model-options.ts` / `*-model-catalog.ts` | provider model catalog/optionValues | 降级为 optional enhancement |
| `RuntimeSessionLifecycle.setSessionMode()` | idle-only mode hotswitch | 只适合 structured/enhanced session；native TUI core 不依赖 |
| `RuntimeSessionLifecycle.setSessionModel()` | idle-only model hotswitch | 只适合 structured/enhanced session；native TUI core 不依赖 |
| `session-store-session-startup.ts` 的 mode/model 传参 | Web new/claim 前置选项 | Phase 6 应明确 provider-specific，不影响 create PTY session |
| `SessionModelControls` / session controls UI | model/mode/plan UI | Phase 6 文档化为 provider-specific enhancement |

当前已符合的部分：

- native TUI capabilities 中 `structuredControl: false`、`modelSwitch: false`。
- native TUI session mode 使用 `external_locked`，说明真实 TUI 权限/模型状态受外部控制。

当前风险：

- Web start/claim 仍会向 native TUI launch spec 传 `modeId`/`model`/`optionValues`，这是启动增强可以保留，但不能让失败影响 PTY create。
- Web claim 后仍有 `api.setSessionMode()` / `api.setSessionModel()` fallback 逻辑；对 native TUI session 目前通常不会触发，因为 mode/model 不 mutable，但 Phase 6 应继续收紧语义。

## 5. Legacy Structured Live 模块

这些模块不应继续扩大为主链路。它们可以作为兼容/实验/历史功能存在，但 PTY-first 主线不应依赖它们。

| 模块 | 当前职责 | 后续定位 |
|---|---|---|
| `ProviderAdapter.startSession()` / `resumeSession()` | structured live start/resume 主接口 | 降级为 legacy structured path |
| `RuntimeStructuredProviderCoordinator.startSession()` / `resumeSession()` | 非 native_tui 请求走 adapter structured live | 保留兼容，但不作为默认 provider 主链路 |
| `codex-live-client.ts` / `codex-live-rpc.ts` | Codex structured JSON-RPC live | legacy/enhancement |
| `claude-live-client.ts` / helpers | Claude SDK structured live | legacy/enhancement |
| `gemini-live-client.ts` | Gemini structured CLI/live path | legacy/enhancement |
| `kimi-live-client.ts` / RPC | Kimi structured live path | legacy/enhancement |
| `opencode-live-client.ts` / ACP | OpenCode structured API/ACP path | legacy/enhancement |
| `ProviderInputControlAdapter.sendInput()` / `interruptSession()` | structured live input/interrupt | legacy path；native TUI core 走 PTY input/interrupt |

当前已符合的部分：

- Web 对五家 provider 默认 `liveBackend: "native_tui"`。
- `RuntimeEngine.startSession()` / `resumeSession()` 已在 `liveBackend === "native_tui"` 时绕过 `RuntimeStructuredProviderCoordinator`，直接走 native TUI launch spec + terminal coordinator。

当前未完全符合的部分：

- `ProviderAdapter` 仍是一个肥接口，包含 lifecycle、model/mode、input control、workspace、history、diagnostics 等全部能力。
- structured live 仍与 stored history、rename/delete、workspace tools 混在同一 adapter 接口里；Phase 6 之前至少需要文档化边界，避免继续扩大。

## 6. 入口等价关系审计

目标等价关系：

```text
rah <provider>
Web New Session
Canvas New Session
  -> create PTY session + attach client

rah <provider> resume <id>
Web Claim History
  -> resume launch spec + create PTY session + attach client
```

当前状态：

| 入口 | 当前链路 | 是否已经等价 |
|---|---|---|
| Web New Session | client default `liveBackend: "native_tui"` -> `RuntimeEngine.startSession()` -> `nativeTuiProviders.startLaunchSpec()` -> `RuntimeTerminalCoordinator.startNativeTuiSession()` -> daemon-owned PTY | 基本符合 |
| Canvas New Session | 复用 Web start command，默认 `native_tui` | 基本符合 |
| Web Claim History | client default `liveBackend: "native_tui"` -> `RuntimeEngine.resumeSession()` -> `nativeTuiProviders.resumeLaunchSpec()` -> `startNativeTuiSession()` | 基本符合 |
| `rah <provider>` | terminal wrapper process 启动真实 TUI，在外部 terminal 中运行；daemon 通过 `wrapper.hello` 注册 session，PTY output 由 wrapper 转发为 `wrapper.pty.output` | 不等价；不是 daemon create PTY |
| `rah <provider> resume <id>` | 同上，带 `resumeProviderSessionId` 注册 wrapper session | 不等价；不是 daemon resume launch spec + create PTY |
| PWA/Web attach live | attach existing session + PTY WebSocket replay/input | 对 daemon-owned native TUI 基本符合；对 terminal wrapper session 取决于 wrapper 仍在线 |

核心差距：

1. Web-owned native TUI 是 daemon-owned PTY。
2. `rah xxx` wrapper 是 terminal-owned TUI + daemon session registry + output relay。
3. 这两者现在共享 `PtyHub` 输出面和 `SessionStore`，但不共享同一个 PTY process lifecycle。
4. 因此 “关闭桌面 terminal 只 detach、不杀 session” 对 daemon-owned native TUI 可实现；对当前 `rah xxx` wrapper 不成立或不稳定，因为真实 TUI 仍由用户 terminal/wrapper 生命周期承载。

Phase 1 的首要任务：

> 把 `rah xxx` 从 “terminal-owned wrapper handoff” 改造为 “请求 daemon 创建/resume PTY session，然后当前 terminal attach 到这个 PTY session”。

这会让 `rah xxx` 和 Web New 真正共享同一条 runtime。

## 7. Phase 1 建议迁移顺序

按风险从低到高推进：

1. 定义 `PtySessionRuntime` 的 contract 和状态模型，不立刻移动实现。
2. 从 `RuntimeTerminalCoordinator.startNativeTuiSession()` 抽出 daemon-owned PTY create/resume helper。
3. 让 independent terminal 和 native TUI process lifecycle 使用同一内部 session/process record。
4. 把 terminal wrapper 的 session 注册改为 attach 到已有/新建 PTY session 的客户端语义。
5. 新增或改造 wrapper smoke：断开 terminal client 不应调用 `markExited()` 或移除 daemon-owned session。
6. 再考虑删除旧 wrapper-owned lifecycle。

不建议第一步就删除 structured adapters。原因：

- 它们仍承载 stored session discovery、rename/delete、workspace file/git、diagnostics/model catalog 等非 live 功能。
- PTY-first 的首要复杂度收益来自统一 live lifecycle，而不是一次性删除所有 legacy structured 代码。

## 8. 必须保留的测试/gate

当前可用 gate：

- `npm run typecheck`
- `npm run test:runtime`
- `npm run test:web`
- `npm run build:web`
- `npm run test:native-tui`
- `npm run test:smoke:native-codex`
- `npm run test:smoke:native-providers`
- `npm run test:smoke:native-codex-browser`
- `npm run test:smoke:native-provider-browser`
- `npm run test:smoke:native-browser-webkit`
- `npm run test:smoke:wrapper`
- `git diff --check`

Phase 1 必须新增或更新的测试覆盖：

- `rah xxx` 路径不会创建独立于 Web New 的特殊 live lifecycle。
- terminal client detach 不会 close/remove daemon-owned PTY session。
- Web attach 到 `rah xxx` 创建的 session 与 Web New session 使用相同 PTY replay/input path。
- `rah xxx resume <id>` 与 Web Claim History 使用同一种 resume launch spec。

## 9. Phase 0 结论

当前代码已经具备 PTY-first 的大部分基础设施，但 live 主链路还没有完全唯一化。

已满足：

- Web New / Web Claim / Canvas New 默认 native TUI。
- daemon-owned native TUI 已是真实 PTY。
- TUI output 通过 `PtyHub` replay 到 Web。
- Chat mirror 来自原厂 session 文件/DB，不是 ANSI 反推。
- mirror failure 已有 diagnostics 路径。

未满足：

- `rah xxx` / `rah xxx resume` 仍是 terminal-owned wrapper 路径，不等价于 Web New / Web Claim。
- `RuntimeTerminalCoordinator` 仍是多职责聚合点。
- mirror parser 与 PTY runtime 仍在 coordinator 中耦合。
- legacy structured live adapter 仍是肥接口，虽然已不再是 Web 默认主链路。

下一步：

> Phase 1 从定义并抽出唯一 `PtySessionRuntime` 开始，然后把 `rah xxx` wrapper 改造成 attach client，而不是独立 live lifecycle。
