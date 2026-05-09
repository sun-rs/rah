# Session 入口与权限边界

本文锁定入口与权限边界。当前 `refactor/native-local-server-core` 分支已把 live 主链路收敛为 provider runtime 分层：

- Codex / OpenCode 默认走 `native_local_server`，由 provider 官方本地 server 管 live session，RAH 通过结构化协议发送 turn、订阅事件、执行 stop/abort。
- Claude 默认走 `tui_mux_fallback`，由 zellij/TUI mux 保持原生 TUI 工作现场，RAH 的结构化 Chat 来自 Claude 原厂 JSONL mirror。
- zellij 不再是所有 provider 的统一默认主线，而是 Claude 当前默认路径和未来无 server provider 的 fallback。

旧的 “terminal handoff vs web-owned structured live” 仍作为 legacy/enhancement 参考保留，但不再从公开 `rah xxx` 入口暴露。

2026-05-07 后的维护边界进一步收敛为：

- Core live provider：Codex、Claude、OpenCode。
- Gemini/Kimi CLI：一等 provider 代码已移除，不再作为 live、history-only、diagnostics 或默认 QA 对象。
- OpenCode 是低频 API-key / 中转站模型容器；Kimi、GLM、MiniMax、Gemini、Grok、DeepSeek 等按量模型优先通过 OpenCode 配置使用。

## 1. 四种入口

| 入口 | Owner | 语义 | 是否有原生 TUI / Client |
| --- | --- | --- | --- |
| `rah codex` / `rah opencode` | provider native local server + official client | 请求 daemon 创建 native local server session，然后本地终端用官方 remote/attach client 接入同一 provider session | 有，provider client view |
| `rah claude` | zellij/TUI mux fallback + terminal attach client | 请求 daemon 启动 Claude TUI，然后当前终端 attach 到 zellij surface | 有，TUI owner surface |
| `rah codex/claude/opencode resume <providerSessionId>` | 按 provider runtime 选择 owner | 请求 daemon resume 指定 provider session；Codex/OpenCode 接 native server，Claude 接 zellij fallback | Core provider 有 |
| `web new` | 按 provider runtime 选择 owner | Codex/OpenCode 走 structured native server；Claude 走 zellij/TUI fallback；可在 Chat/TUI 视图间切换 | Core provider 有 |
| `web resume` / claim history | 按 provider runtime 选择 owner | Web 从历史 session claim/resume 成 live session；只读浏览不触发 live | Core provider 有 |

关键边界：

- 入口不再强行进入同一个 PTY runtime；Codex/OpenCode 的普通 Chat control 进入 provider server，Claude 进入 TUI mux。
- `rah xxx resume <id>` 必须是显式 provider session id，不支持 provider 原生 picker 模式。
- 如果用户在原生 TUI 内部 `/new` / `/resume` 切到另一个 session，当前不承诺所有 provider 都能自动 rebind。
- `livePermissions` 只表示 web 能回答运行时 approval/request，不等于 web 能修改该 session 的全局权限模式。
- `native_local_server` session 的运行中权限/模型/plan 只有 provider transport 明确支持时才开放；Claude/TUI fallback 的全局权限/模型/plan 以 provider 原生 TUI 为最终事实。
- 公开 `rah xxx` 入口不再提供旧 terminal wrapper handoff 逃生口。

## 2. Provider 能力矩阵

| Provider | 默认 runtime | Structured source | Approval / 权限边界 |
| --- | --- | --- | --- |
| Codex | `native_local_server`，Codex app-server + `codex --remote ... resume <threadId>` | app-server event + rollout/session history backfill | mode/model 可走启动前和 next-turn/runtime config；具体能力以 runtime feature 为准 |
| Claude | `tui_mux_fallback`，Claude TUI + zellij | `.claude/projects/**/*.jsonl` | permission/model/effort 尽量作为启动参数；运行中以原生 TUI 为准 |
| OpenCode | `native_local_server`，OpenCode serve/session/attach | OpenCode server/session event + SQLite backfill | model/permission/variant 通过 OpenCode API/ACP 能力；UI 只能展示 capability 声明的可变项 |

## 3. 权限 / 模型 / Plan 的当前定位

Native local server / TUI fallback 分层后，权限、模型、effort、thinking、plan 不再是 live core 的正确性前提，而是 provider-specific enhancement。

启动前：

- Web New、Canvas New、Web Claim、`rah xxx` 可以把 `modeId`、`model`、`optionValues` 传给 provider runtime。
- daemon 尽量把这些值翻译成 provider-native 启动或 server config，例如 Codex app-server config、Claude `--model` / `--permission-mode`、OpenCode model/variant config。
- OpenCode 的 `opencode run --variant` 和 ACP `provider/model/variant` 是已验证路径；OpenCode TUI 入口没有稳定 `--variant` 参数，所以 PTY-first core 不把 variant/effort 当作启动成功条件。
- 如果 provider CLI 改名、废弃或改变某个参数，RAH 不应因此破坏 PTY create/attach/replay/close 主链路。

启动后：

- Claude/TUI fallback session 的最终真实状态属于 provider TUI。用户可以在 TUI 内使用官方 `/permission`、`/model`、`/plan`、`/goal` 等能力。
- Codex/OpenCode native local server session 的运行中配置只在 runtime feature 声明 `runtimeConfig: "available"` 时由 Web 暴露。
- RAH Web 只在 session 明确暴露 `mutable: true` 且 adapter 明确支持时显示 live 后切换；否则应表现为 `external_locked` 或不可变。
- `Plan` 是独立模式，不属于权限下拉；但是否可由 Web 热切取决于 provider 和当前 live backend。

原则：

- `livePermissions=true` 只表示 Web 可能可以回答一次运行时 approval/request，不等于 Web 可以修改全局权限模式。
- `SessionModeDescriptor.role` 是 UI 语义层；provider 原生 `id` 是提交给 adapter 的 opaque value。
- `SessionModeDescriptor.applyTiming` 只描述增强能力的时机，不是 core session 生命周期。

## 4. Legacy structured / wrapper 参考

显式 `liveBackend: "structured"` 是旧 adapter control plane。公开 HTTP API 拒绝该值；只允许测试注入 adapter 直接调用 engine 时使用；`preferStoredReplay` 的只读历史 replay 不受此限制。旧 terminal wrapper handoff 代码仍作为内部 legacy 参考和 synthetic test surface 存在，但公开 `rah xxx` CLI 不再进入该路径。保留这些 legacy surface 的目的只是测试/兼容，不是继续维护第三条 live 主链路。它们的权限/模型能力大致如下，但不再是 PTY-first core 的承诺：

| Provider | Legacy structured 能力边界 |
| --- | --- |
| Codex | app-server / JSON-RPC structured live，支持较完整的 approval / interrupt / mode / model 控制。 |
| Claude | SDK structured live，支持 SDK permission callback 和部分 model/effort 控制。 |
| OpenCode | ACP/API structured live，permission ruleset 和 model variant 通过 OpenCode 能力实现。 |

这个 legacy path 可以继续被测试覆盖，但新增产品能力必须优先保证 Codex/OpenCode native local server 与 Claude tui_mux_fallback 主线，而不是扩大旧 structured live 适配面。
