# Session 入口与权限边界

本文锁定入口与权限边界。当前 `refactor/pty-first-core` 分支已把 live 主链路收敛为 PTY-first：`rah xxx`、Web New、Canvas New、Web Claim 默认都创建或恢复 daemon-owned native TUI PTY session，然后由不同客户端 attach。

旧的 “terminal handoff vs web-owned structured live” 仍作为 legacy/enhancement 参考保留，但不再从公开 `rah xxx` 入口暴露。

## 1. 四种入口

| 入口 | Owner | 语义 | 是否有原生 TUI |
| --- | --- | --- | --- |
| `rah xxx` | daemon native TUI PTY + terminal attach client | 请求 daemon 启动 provider TUI，然后当前终端 attach 到同一 PTY | 有 |
| `rah xxx resume <providerSessionId>` | daemon native TUI PTY + terminal attach client | 请求 daemon resume 指定 provider session，然后当前终端 attach | 有 |
| `web new` | daemon native TUI PTY + web attach client | Web UI 创建 daemon-owned native TUI session；可在 Chat/TUI 间切换 | 有 |
| `web resume` / claim history | daemon native TUI PTY + web attach client | Web 从历史 provider session claim/resume 成 native TUI live session | 有 |

关键边界：

- 四个入口都进入同一个 PTY runtime；差异只是初始 attach client 是 terminal 还是 web/canvas。
- `rah xxx resume <id>` 必须是显式 provider session id，不支持 provider 原生 picker 模式。
- 如果用户在原生 TUI 内部 `/new` / `/resume` 切到另一个 session，当前不承诺所有 provider 都能自动 rebind。
- `livePermissions` 只表示 web 能回答运行时 approval/request，不等于 web 能修改该 session 的全局权限模式。
- native TUI session 的全局权限/模型/plan 以 provider 原生 TUI 为最终事实；RAH 的 mode/model/option 只作为启动增强或 provider 明确支持的可变增强。
- 公开 `rah xxx` 入口不再提供旧 terminal wrapper handoff 逃生口。

## 2. Provider 能力矩阵

| Provider | 默认 native TUI entry | Structured mirror | Approval / 权限边界 |
| --- | --- | --- | --- |
| Codex | `codex --cd <cwd>` / `codex resume --cd <cwd> <id>`，必要时 isolated `CODEX_HOME` | rollout jsonl / sessions | mode/model 尽量作为启动参数；运行中以原生 TUI 和 Codex 自身 `/permission` 等能力为准 |
| Claude | `claude --session-id <uuid>` / `claude --resume <id>` | `.claude/projects/**/*.jsonl` | permission/model/effort 尽量作为启动参数；运行中以原生 TUI 为准 |
| Gemini | `gemini` / `gemini --resume <id>` | Gemini conversation file + cache | approval/model 尽量作为启动参数；无统一 effort；运行中以原生 TUI 为准 |
| Kimi | `kimi --session <uuid|id>` | Kimi wire jsonl / session files | model/thinking/mode 尽量作为启动参数；运行中以原生 TUI 为准 |
| OpenCode | `opencode [--session <id>] <cwd>` | OpenCode SQLite message store | model/permission ruleset 尽量作为启动参数；运行中以原生 TUI 为准 |

## 3. 权限 / 模型 / Plan 的当前定位

PTY-first 后，权限、模型、effort、thinking、plan 不再是 live core 的正确性前提，而是 provider-specific enhancement。

启动前：

- Web New、Canvas New、Web Claim、`rah xxx` 可以把 `modeId`、`model`、`optionValues` 传给 native TUI launch spec。
- daemon 尽量把这些值翻译成 provider CLI 启动参数，例如 Codex `--model` / `--ask-for-approval`、Claude `--model` / `--permission-mode`、Gemini `--model` / `--approval-mode`、Kimi `--model` / `--thinking` / `--yolo`、OpenCode `--model`。
- 如果 provider CLI 改名、废弃或改变某个参数，RAH 不应因此破坏 PTY create/attach/replay/close 主链路。

启动后：

- native TUI session 的最终真实状态属于 provider TUI。用户可以在 TUI 内使用官方 `/permission`、`/model`、`/plan`、`/goal` 等能力。
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
| Gemini | stream-json structured live，主要支持 approval mode / model，不承诺细粒度 approval 都能进入 Web。 |
| Kimi | wire/ACP structured live，`default/yolo/plan` 需要 idle 边界。 |
| OpenCode | ACP/API structured live，permission ruleset 和 model variant 通过 OpenCode 能力实现。 |

这个 legacy path 可以继续被测试覆盖，但新增产品能力必须优先保证 native TUI PTY 主线，而不是扩大 structured live 适配面。
