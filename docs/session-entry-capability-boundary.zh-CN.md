# Session 入口与权限边界

本文锁定四种入口的语义，避免以后把 terminal handoff、web new、web resume 混成同一件事。

## 1. 四种入口

| 入口 | Owner | 语义 | 是否有原生 TUI |
| --- | --- | --- | --- |
| `rah xxx` | daemon + terminal wrapper | 从当前终端启动一个 live session，并同步到 web 左侧 live sessions | 有 |
| `rah xxx resume <providerSessionId>` | daemon + terminal wrapper | 从当前终端恢复指定 provider session，并同步到 web | 有 |
| `web new` | daemon live adapter | Web UI 直接创建 daemon-owned live session | 无 |
| `web resume` | daemon live adapter | Web UI 从历史 provider session claim/resume 成 daemon-owned live session | 无 |

关键边界：

- `rah xxx` / `rah xxx resume` 是 terminal handoff：terminal 是一个 surface，web 是另一个 surface。
- `web new` / `web resume` 是 web-owned：不会恢复或 attach 到用户已有的本地 TUI 窗口。
- `rah xxx resume <id>` 必须是显式 provider session id，不支持 provider 原生 picker 模式。
- 如果用户在原生 TUI 内部 `/new` / `/resume` 切到另一个 session，当前不承诺所有 provider 都能自动 rebind。
- `livePermissions` 只表示 web 能回答运行时 approval/request，不等于 web 能修改该 session 的全局权限模式。
- terminal handoff session 的 mode state 是 `external_locked`，权限模式由启动参数或 provider 原生 TUI 决定；Web 不显示权限下拉。

## 2. Provider 能力矩阵

| Provider | `rah xxx` / `rah xxx resume` | `web new` / `web resume` | Approval / 权限边界 |
| --- | --- | --- | --- |
| Codex | 真实 terminal handoff；`rah codex` 新会话用 isolated `CODEX_HOME` 精准绑定；`resume <id>` 精确绑定；默认 `--dangerously-bypass-approvals-and-sandbox` | Codex app-server live session，可 new/resume | handoff 与 web-owned 都走 Codex app-server 控制面，web approval / interrupt 可接住 |
| Claude | 真实 terminal handoff；`rah claude` 用 `--session-id <uuid>`，`resume <id>` 用 `--resume <id>`；不支持裸 `claude --resume` picker | Claude SDK live session，可 new/resume | handoff 不接 provider-native web approval，默认 `bypassPermissions`；web-owned 默认 `bypassPermissions`，但支持 SDK permission callback 到 web approval |
| Gemini | 真实 terminal handoff；`resume <id>` 只走显式 id | Gemini stream-json live session，可 new/resume | handoff 不接 provider-native web approval，默认 `yolo`；web-owned Gemini 主要是 approval mode 控制，不承诺细粒度 web approval |
| Kimi | terminal wrapper live session，可 new/resume；默认 `--yolo` | Kimi wire live session，可 new/resume；默认 `--yolo` | Kimi permission round-trip 已接入 web；`default` 会显示 approval，`yolo` 自动批准 |
| OpenCode | terminal wrapper / OpenCode server API live session，可 new/resume；默认 full-auto permission override | OpenCode ACP/API live session，可 new/resume；默认 `opencode/full-auto` | web 可控制 OpenCode mode/permission 策略；细粒度事件以 OpenCode 暴露的 ACP/API 能力为准 |

## 3. Claude handoff 权限策略

`rah claude` 默认是全批准模式：

```bash
rah claude
# effective: claude --permission-mode bypassPermissions --session-id <uuid>
```

可显式覆盖：

```bash
rah claude --permission-mode default
rah claude --permission-mode acceptEdits
rah claude --permission-mode auto
rah claude --permission-mode bypassPermissions
rah claude --permission-mode plan

rah claude resume <providerSessionId> --permission-mode bypassPermissions
```

这个模式会同时用于：

- terminal 原生 Claude TUI
- web 接管时的 one-shot `claude --print`

因此 `rah claude --permission-mode default` 会让 web 接管轮次也进入 Claude 默认权限策略；但 handoff 目前没有 web approval bridge，如果 provider 在 one-shot 里要求 approval，可能卡在不可见 approval 上。

## 4. Gemini handoff 权限策略

`rah gemini` 默认是全批准模式：

```bash
rah gemini
# effective: gemini --approval-mode yolo
```

可显式覆盖：

```bash
rah gemini --approval-mode default
rah gemini --approval-mode auto_edit
rah gemini --approval-mode yolo
rah gemini --approval-mode plan
rah gemini --yolo

rah gemini resume <providerSessionId> --approval-mode yolo
```

这个模式会同时用于：

- terminal 原生 Gemini TUI
- web 接管时的 one-shot `gemini --prompt`

因此 `rah gemini --approval-mode default` 也可能让 web 接管轮次卡在不可见 approval 上。日常使用建议保持默认 `yolo`。

## 5. Web 入口的默认策略

Web 入口不是 handoff，不需要兼顾真实 terminal TUI。

- `web new` 创建 daemon-owned live session。
- `web resume` 从 provider history 恢复/claim 成 daemon-owned live session。
- Web 能否显示 approval 取决于 adapter 是否有 permission callback/control plane。

当前默认：

- Codex web：默认 `never/danger-full-access`，可切 `on-request/read-only`、`on-request/workspace-write`（Codex 低摩擦/自动编辑沙盒语义）、`never/workspace-write`、`never/danger-full-access`，支持 web approval/control。
- Claude web：默认 `bypassPermissions`，可切 `default`、`acceptEdits`、`bypassPermissions`、`plan`，支持 SDK permission callback 到 web approval；Claude 原生 `auto` 不进入前端主权限列表。
- Gemini web：默认 `yolo`，支持 mode 切换，但不承诺细粒度 web approval。
- Kimi web：默认 `yolo`，可切 `default`、`yolo`、`plan`；启动时原生传 `--yolo`，运行中切换会重启 Kimi wire client 来对齐 yolo/default。
- OpenCode web：默认 `opencode/full-auto`；权限只暴露 `Ask`（native `build` + permission `ask`）和 `Full auto`（native `build` + permission `* allow`）；`plan` 是单独的 OpenCode mode，不是权限项。

原则：

- 默认值统一选择“最大权限/最低打断”：Codex `never/danger-full-access`、Claude `bypassPermissions`、Gemini `yolo`、Kimi `yolo`、OpenCode `opencode/full-auto`。
- UI 的权限列表避免展示含糊的 `Default`；需要 approval 的默认策略统一叫 `Ask`。只有 OpenCode `opencode/full-auto` 是 RAH 在 OpenCode session permission API 上补出来的 overlay。
- 如果用户在创建前手动选择低权限，前端只把 RAH 标准 `modeId` 传给 daemon；具体如何转成 provider-native 启动参数由 adapter 负责，避免 provider 语义泄漏到 Web UI。

## 6. Web 权限项与 provider 原生能力映射

`Plan` 是独立模式开关，不属于权限下拉。下表只描述前端主权限列表。

| Provider | 前端权限项 | RAH mode id | role | applyTiming | Adapter 启动/切换实现 |
| --- | --- | --- | --- | --- | --- |
| Codex | `Ask` | `on-request/read-only` | `ask` | `next_turn` | Adapter 转成 `approvalPolicy=on-request` + `sandbox=read-only`；写操作仍可请求提升，不是绝对只读 |
| Codex | `Auto edit` | `on-request/workspace-write` | `auto_edit` | `next_turn` | Adapter 转成 `approvalPolicy=on-request` + `sandbox=workspace-write` |
| Codex | `Full auto · sandboxed` | `never/workspace-write` | `full_auto` | `next_turn` | Adapter 转成 `approvalPolicy=never` + `sandbox=workspace-write` |
| Codex | `Full auto` | `never/danger-full-access` | `full_auto` | `next_turn` | Adapter 转成 `approvalPolicy=never` + `sandbox=danger-full-access`；默认值 |
| Claude | `Ask` | `default` | `ask` | `immediate` | Adapter 使用 Claude SDK permission mode `default` |
| Claude | `Auto edit` | `acceptEdits` | `auto_edit` | `immediate` | Adapter 使用 Claude SDK permission mode `acceptEdits` |
| Claude | `Full auto` | `bypassPermissions` | `full_auto` | `immediate` | Adapter 使用 Claude SDK permission mode `bypassPermissions`；默认值 |
| Gemini | `Ask` | `default` | `ask` | `next_turn` | Adapter 使用 Gemini approval mode `default` |
| Gemini | `Auto edit` | `auto_edit` | `auto_edit` | `next_turn` | Adapter 使用 Gemini approval mode `auto_edit` |
| Gemini | `Full auto` | `yolo` | `full_auto` | `next_turn` | Adapter 使用 Gemini approval mode `yolo`；默认值 |
| Kimi | `Ask` | `default` | `ask` | `idle_only` | Adapter 启动 Kimi wire client 时不加 `--yolo` |
| Kimi | `Full auto` | `yolo` | `full_auto` | `idle_only` | Adapter 启动 Kimi wire client 时加 `--yolo`；默认值 |
| OpenCode | `Ask` | `build` | `ask` | `next_turn` | Adapter 使用 native `build` mode，并写 `ask` permission ruleset |
| OpenCode | `Full auto` | `opencode/full-auto` | `full_auto` | `next_turn` | Adapter 使用 native `build` mode，并写 `allow` permission ruleset；默认值 |

实现边界：

- `web new` 和 `web resume` 创建的是 daemon-owned live session，mode state 为 `mutable: true` 时，前端可以显示并切换上述权限项。
- 前端展示权限项时依赖 `SessionModeDescriptor.role`，不依赖 provider-native `id`。`id` 只作为提交给 adapter 的 opaque value；是否 immediate / next turn / idle-only 由 `applyTiming` 表达。
- `rah xxx` 和 `rah xxx resume <id>` 创建的是 terminal handoff live session。Web 侧只观察、接管输入、关闭/归档，以及在 provider 支持时回答 live approval；不在 session mode 下拉里修改 provider 原生权限。这类 session 的权限应在启动时通过 `rah xxx` 参数或 provider 原生 TUI 配置确定。
- terminal handoff 中，Codex / Kimi / OpenCode 的 `livePermissions=true` 表示可以处理运行时 approval；Claude / Gemini handoff 不接 provider-native web approval，默认用全批准模式降低卡住概率。
- Kimi 是唯一明确要求 idle 切换权限的 provider，因为 `default` / `yolo` 会影响 wire client 启动参数；active turn 中切换会被拒绝。
- OpenCode 的 `Ask` / `Full auto` 不是 OpenCode `plan/build` 本身，而是 RAH 在 OpenCode session permission API 上写入的 `ask` / `allow` ruleset。

## 7. Approval 与权限模式切换不是同一件事

RAH 里有两个容易混淆的能力：

- **Approval response**：provider 正在请求一次性批准/拒绝某个 tool/action，Web 能不能点 Allow / Deny。
- **Permission mode switching**：session 已经 live 后，Web 能不能把全局权限模式从 `Ask` 切成 `Full auto`，或反向切换。

这两个能力独立。`livePermissions=true` 只表示 Web 可以回答运行时 approval，不表示 Web 可以改全局权限模式。

| 入口 | Provider | Web approval response | Web permission mode switching | 说明 |
| --- | --- | --- | --- | --- |
| `rah xxx` / `rah xxx resume` | Codex | 支持 | 不支持 | terminal handoff mode 为 `external_locked`；Web 可处理 approval，但不能改全局模式 |
| `rah xxx` / `rah xxx resume` | Claude | 不支持 | 不支持 | handoff 默认 `bypassPermissions`，避免 web 接管 turn 卡在不可见 approval |
| `rah xxx` / `rah xxx resume` | Gemini | 不支持 | 不支持 | handoff 默认 `yolo`，避免 web 接管 turn 卡在不可见 approval |
| `rah xxx` / `rah xxx resume` | Kimi | 支持 | 不支持 | terminal wrapper 可转发 Kimi approval；全局 `default/yolo` 由启动参数决定 |
| `rah xxx` / `rah xxx resume` | OpenCode | 支持 | 不支持 | terminal wrapper 可转发 OpenCode permission；默认写入 full-auto permission override |
| `web new` / `web resume` | Codex | 支持 | 支持 | daemon-owned live session，mode `mutable:true` |
| `web new` / `web resume` | Claude | 支持 | 支持 | SDK permission callback 接入 Web；mode `mutable:true` |
| `web new` / `web resume` | Gemini | 不承诺细粒度 approval | 支持 | Web 主要控制 Gemini approval mode，不承诺所有 provider-native approval 都能弹到 Web |
| `web new` / `web resume` | Kimi | 支持 | 支持，idle only | active turn 中不允许切换；`default/yolo` 切换会重启 wire client |
| `web new` / `web resume` | OpenCode | 支持 | 支持 | 通过 OpenCode ACP/API 和 session permission ruleset 实现 |

当前设计原则：

- terminal handoff 的目标是保留真实本地 TUI 体验，因此全局权限模式在启动时锁定，不从 Web 动态改。
- web-owned live session 的目标是由 daemon 托管执行，因此可以由 Web 改 mode。
- 如果未来要支持 `rah codex/kimi/opencode` 在 Web 改全局权限，需要新增 wrapper `mode.change` 控制消息，并分别实现 provider-specific 同步逻辑；不能复用 `livePermissions` 语义。

## 8. Web 创建/claim 前选择与 live 后切换

对 `web new` / `web resume` 来说，创建或 claim 前看到的权限选项，与 session live 后看到的权限选项，语义上是同一套 RAH mode。

差异只在实现时机：

- 创建/claim 前：前端把选中的 `modeId` 放进 `startSession` / `resumeSession` 请求，daemon 交给对应 adapter 在创建 live session 时直接按该 mode 启动 provider。
- 创建/claim 后：前端调用 `setSessionMode`，daemon 对已经 live 的 provider adapter 执行 mode switch。

这不是“claim 前只能靠 CLI `--xxx`，claim 后就失控”的设计。Web-owned session 一旦 claim 成功，owner 是 daemon，mode state 为 `mutable:true`，后续仍可通过 Web 控制权限模式。

实现路径如下：

| Provider | 创建/claim 前如何应用 | live 后如何应用 | 是否存在首轮空窗 |
| --- | --- | --- | --- |
| Codex | Adapter 解释 `modeId`，转成 `approvalPolicy` + `sandbox` 启动参数 | 更新 live session 的 `approvalPolicy` / `sandboxMode`，用于后续 turn | 无；首条输入在 mode 对齐后发送 |
| Claude | Adapter 解释 `modeId`，设置 SDK permission mode | 更新 SDK permission mode；当前 query 支持时同步到 query | 无；首条输入在 mode 对齐后发送 |
| Gemini | Adapter 解释 `modeId`，设置 Gemini approval mode | 更新 live session approval mode，用于后续 turn | 无；首条输入在 mode 对齐后发送 |
| Kimi | Adapter 解释 `modeId`，`yolo` 会用 `--yolo`，`plan` 会调用 `set_plan_mode` | idle 时重启 Kimi wire client 对齐 `default` / `yolo`，并设置 plan mode | 无；但 active turn 中不能切 |
| OpenCode | Adapter 解释 `modeId`，设置 native mode 并写 OpenCode session permission | 通过 ACP/API 切 native mode，并写 session permission ruleset | 无；首条输入在 mode/model 对齐后通过标准 `sendInput` 发送 |

因此：

- `web new` 默认最大权限；用户创建前改了权限，首轮也按该权限执行。
- `web resume/claim history` 默认最大权限；用户 claim 前改了权限，claim 出来的 live session 也按该权限恢复。
- live 后继续改权限仍可用，除 Kimi 要求 idle。
- 以上结论不适用于 `rah xxx` terminal handoff；handoff session 是 `external_locked`，Web 不改全局权限模式。
