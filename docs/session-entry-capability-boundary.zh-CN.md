# Session 入口与权限边界

本文锁定入口与权限边界。当前 `main` 已把 live 主链路收敛为 provider runtime 分层：

- Codex / OpenCode 默认走 `native_local_server`，由 provider 官方本地 server 管 live session，RAH 通过结构化协议发送 turn、订阅事件、执行 stop/abort。
- Claude / Gemini 默认走 `tui_mux_fallback`，由 tmux/TUI mux 保持原生 TUI 工作现场，RAH 的结构化 Chat 来自 provider 原厂历史文件 mirror。
- tmux 不再是所有 provider 的统一默认主线，而是 Claude 当前默认路径和未来无 server provider 的 fallback。

旧 terminal handoff / wrapper-control 运行时代码已经删除。用户入口不再暴露第三条 live 主链路；`liveBackend: "structured"` 只允许测试注入 adapter 使用。`native_tui` 保留为 daemon 诊断/回归测试入口，不是 Codex/OpenCode 的默认用户路径。

2026-05-07 后的维护边界进一步收敛为：

- Core live provider：Codex、Claude、Gemini、OpenCode。
- Gemini CLI：已恢复为 `tui_mux_fallback` provider；参数能力来自当前 `gemini --help`，结构化 Chat 来自 `~/.gemini/tmp/**/chats/session-*.json`。
- Kimi CLI：一等 provider 代码仍移除；Kimi、GLM、MiniMax、Grok、DeepSeek 等按量模型优先通过 OpenCode 配置使用。

## 1. 四种入口

| 入口 | Owner | 语义 | 是否有原生 TUI / Client |
| --- | --- | --- | --- |
| `rah codex` / `rah opencode` | provider native local server + official client | 请求 daemon 创建 native local server session，然后本地终端用官方 remote/attach client 接入同一 provider session | 有，provider client view |
| `rah claude` / `rah gemini` | tmux/TUI mux fallback + terminal attach client | 请求 daemon 启动对应官方 TUI，然后当前终端 attach 到 tmux surface | 有，TUI owner surface |
| `rah codex/claude/gemini/opencode resume <providerSessionId>` | 按 provider runtime 选择 owner | 请求 daemon resume 指定 provider session；Codex/OpenCode 接 native server，Claude/Gemini 接 tmux fallback | Core provider 有 |
| `web new` | 按 provider runtime 选择 owner | Codex/OpenCode 走 provider native local server；Claude/Gemini 走 tmux/TUI fallback；可在 Chat/TUI 视图间切换 | Core provider 有 |
| `web resume` / claim history | 按 provider runtime 选择 owner | Web 从历史 session claim/resume 成 live session；只读浏览不触发 live | Core provider 有 |

关键边界：

- 入口不再强行进入同一个 PTY runtime；Codex/OpenCode 的普通 Chat control 进入 provider server，Claude/Gemini 进入 TUI mux。
- `rah xxx resume <id>` 必须是显式 provider session id，不支持 provider 原生 picker 模式。
- 如果用户在原生 TUI 内部 `/new` / `/resume` 切到另一个 session，当前不承诺所有 provider 都能自动 rebind。
- `livePermissions` 只表示 web 能回答运行时 approval/request，不等于 web 能修改该 session 的全局权限模式。
- `native_local_server` session 的运行中权限/模型/plan 只有 provider transport 明确支持时才开放；Claude/Gemini TUI fallback 的全局权限/模型/plan 以 provider 原生 TUI 为最终事实。
- 公开 `rah xxx` 入口不再提供旧 terminal wrapper handoff 逃生口。

## 2. Provider 能力矩阵

| Provider | 默认 runtime | Structured source | Approval / 权限边界 |
| --- | --- | --- | --- |
| Codex | `native_local_server`，Codex app-server + `codex --remote ... resume <threadId>` | app-server event + rollout/session history backfill | mode/model 可走启动前和 next-turn/runtime config；具体能力以 runtime feature 为准 |
| Claude | `tui_mux_fallback`，Claude TUI + tmux | `.claude/projects/**/*.jsonl` | permission/model/effort 尽量作为启动参数；运行中以原生 TUI 为准 |
| Gemini | `tui_mux_fallback`，Gemini CLI TUI + tmux | `~/.gemini/tmp/**/chats/session-*.json` | approval-mode/model 作为启动参数；catalog 优先用 `gemini --acp` `session/new` 探测 `availableModels` / `availableModes`；ACP 不可用、未登录或超时则回退 `gemini --help` 和静态表；运行中以原生 TUI 为准 |
| OpenCode | `native_local_server`，OpenCode serve/session/attach | OpenCode server/session event + SQLite backfill | model/permission/variant 通过 OpenCode API/ACP 能力；UI 只能展示 capability 声明的可变项 |

### Gemini ACP 探针的已知限制

Gemini ACP 目前只用于启动前 capability/catalog 探测，不用于 live 对话传输。当前实测 Gemini CLI `0.42.0` 在 Google 授权状态不可直接复用时，`gemini --acp` 可能进入交互式 OAuth 文本流程，导致 JSON-RPC `initialize` 无响应；即使授权可用，ACP `session/new` 也可能需要数秒返回模型表。RAH 的处理策略是不中断 UI、不影响 session 创建，并在普通按需读取时可先回退到 `gemini --help` 与内置静态模型表，同时后台继续尝试升级到 ACP authoritative catalog。

这意味着 Gemini 的模型/权限列表在未解决授权复用前可能是 `provisional`，不是 provider online authoritative。Settings Models 手动刷新会等待同后台探针一致的长超时，只有拿到 `native` / `authoritative` catalog 才记为成功；失败或 static fallback 不更新 last-success。后续待解决的是：让 ACP probe 能稳定复用 Gemini 已登录上下文，且不能从 metadata 探测路径弹出 OAuth 或污染正式 TUI session。

## 3. 权限 / 模型 / Plan 的当前定位

Native local server / TUI fallback 分层后，权限、模型、effort、thinking、plan 不再是 live core 的正确性前提，而是 provider-specific enhancement。

启动前：

- Web New、Canvas New、Web Claim 可以把 `modeId`、`model`、`optionValues` 传给 provider runtime。
- `rah xxx` CLI 当前只暴露稳定的启动参数子集，主要是 provider、cwd、mux backend，以及 Claude 的 `--permission-mode` / `modeId`。
- daemon 尽量把 Web/Canvas 选择翻译成 provider-native 启动或 server config，例如 Codex app-server config、Claude `--model` / `--permission-mode`、Gemini `--model` / `--approval-mode`、OpenCode model/variant config。
- OpenCode 的 `opencode run --variant` 和 ACP `provider/model/variant` 是已验证路径；OpenCode TUI 入口没有稳定 `--variant` 参数，所以 PTY-first core 不把 variant/effort 当作启动成功条件。
- 如果 provider CLI 改名、废弃或改变某个参数，RAH 不应因此破坏 PTY create/attach/replay/close 主链路。

启动后：

- Claude/Gemini TUI fallback session 的最终真实状态属于 provider TUI。用户可以在 TUI 内使用官方 `/permission`、`/model`、`/plan`、`/goal` 等能力。
- Codex/OpenCode native local server session 的运行中配置只在 runtime feature 声明 `runtimeConfig: "available"` 时由 Web 暴露。
- RAH Web 只在 session 明确暴露 `mutable: true` 且 adapter 明确支持时显示 live 后切换；否则应表现为 `external_locked` 或不可变。
- `Plan` 是独立模式，不属于权限下拉；但是否可由 Web 热切取决于 provider 和当前 live backend。

原则：

- `livePermissions=true` 只表示 Web 可能可以回答一次运行时 approval/request，不等于 Web 可以修改全局权限模式。
- `SessionModeDescriptor.role` 是 UI 语义层；provider 原生 `id` 是提交给 adapter 的 opaque value。
- `SessionModeDescriptor.applyTiming` 只描述增强能力的时机，不是 core session 生命周期。

## 4. Structured test surface 参考

显式 `liveBackend: "structured"` 是测试 adapter control plane。公开 HTTP API 拒绝该值；只允许测试注入 adapter 直接调用 engine 时使用；`preferStoredReplay` 的只读历史 replay 不受此限制。旧 terminal wrapper handoff 和 Claude SDK/headless structured live 代码已经删除。保留 structured test surface 的目的只是让 RuntimeEngine 可被 fake adapter 直接验证，不是继续维护第三条 live 主链路。

| Provider | Structured test / provider-server 能力边界 |
| --- | --- |
| Codex | 当前生产 `native_local_server` control adapter 使用 app-server / JSON-RPC，支持 approval / interrupt / mode / model 控制。 |
| Claude | 没有 SDK/headless structured live 生产路径；Claude live 只走 tmux/TUI fallback。 |
| Gemini | 不恢复 ACP/headless structured live；Gemini live 只走 tmux/TUI fallback，历史解析只读取 Gemini CLI 当前 JSON session 文件。ACP 只作为 capability probe：探测模型和 approval modes，不作为生产 live transport。 |
| OpenCode | 当前生产 `native_local_server` control adapter 使用 OpenCode serve/session API，model variant 通过 OpenCode 能力实现。 |

新增产品能力必须优先保证 Codex/OpenCode native local server 与 Claude/Gemini tui_mux_fallback 主线，而不是扩大 structured test surface。
