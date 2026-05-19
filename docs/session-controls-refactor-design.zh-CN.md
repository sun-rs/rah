# Session Controls 重构设计

本文定义下一阶段 `Session Controls` 模块的重构目标、provider 能力边界、API 感知策略、前端呈现规则和验收标准。

结论先行：

- `Session Controls` 不是“权限菜单”，而是每个 provider 可控项的统一入口。
- UI 不再强行把所有 provider 包装成 `Ask / Readonly / Full auto`。
- Codex 暴露独立 `Plan` 与权限 preset；Claude 暴露互斥 `Session Mode`，其中 `plan` 是一个原生 `permission-mode` 值。
- OpenCode 暴露 `Agent` 选择，来源优先使用 OpenCode server/API/ACP 同源的 `app.agents()`，不把 agent 伪装成权限。
- 三家都尽量通过 provider-native 能力探知 model 和 effort / variant；只有探知不到时才使用缓存或静态 fallback。

## 0. 当前落地状态

截至 2026-05-11，当前代码已经落地以下行为：

- Codex new session composer 显示独立 `Plan` toggle，权限 preset 显示为 `Default / Auto Review / Full Access`。
- Codex provider catalog 会返回 `Plan`，当前默认 mode 仍是最大权限 `Full Access`。
- Codex 提交时会保留两个维度：普通权限通过 access preset modeId 表达；Plan 打开时使用 provider-owned opaque id `plan:<accessPreset>`，例如 `plan:auto-review/workspace-write`。后端进入 Plan 时仍按该 access preset 设置 approval/sandbox/reviewer。
- Codex live session 在 Plan 中切换权限会保持 Plan，只更新底层 access preset；关闭 Plan 会回到后端保存的 last non-plan access preset。
- Claude 不显示独立 `Plan` toggle；`Plan` 是 `Session Mode` 下拉中的一个互斥选项，和 `Default / Accept Edits / Bypass Permissions` 同级。
- Claude `Session Mode` 优先从本机 `claude --help` 的 `--permission-mode <mode>` choices 解析；`auto` 和 `dontAsk` 不进入主 UI。
- OpenCode 不显示权限菜单，也不显示独立 `Plan` toggle；这里显示的是 `Agent` 选择，优先从 OpenCode server `/agent` 获取，过滤 `hidden === true` 和 `mode === "subagent"`，fallback 为 `build / plan`。
- OpenCode 自定义 agent label 按 provider 原样展示，不套用旧权限文案；native TUI 启动路径会拒绝未知 agent，避免把任意字符串传给 `--agent`。
- Chat 页面和历史页面继续使用 `Session Control` 图标入口；new session 大屏空间足够时展开，空间不足时折叠成同一个图标入口。
- 当前通用控件的无障碍文案使用 `Session mode`，避免把 OpenCode agent 选择误称为 `Access mode`。

当前已验证：

- `npm run typecheck`
- `npm run test:web`
- `npm run test:runtime`
- `npm run build:web`
- `npm run test:smoke:session-control-capabilities`

## 1. 背景与问题

旧设计把 `permission`、`mode`、`plan`、`model`、`effort` 混在同一个控制概念里，带来几个问题：

- `OpenCode build / plan` 实际是 agent 选择，不是权限模式。
- `Claude plan` 是 `--permission-mode plan` 的一种原生会话模式；它不能和 `acceptEdits / bypassPermissions / default` 同时生效，因此 UI 必须把它放在同一个互斥 `Session Mode` 下拉里，而不是拆成独立开关。
- `Claude /permissions` 里的 `allow / ask / deny / workspace` 是更细的工具和 workspace 规则，不是 Shift+Tab 那组会话模式。
- `Codex /permissions` 里的 `Default / Auto Review / Full Access` 是权限 preset；它和 plan/collaboration mode 是不同维度。
- 在 chat 页面和历史浏览页面，可用空间通常不稳定，控制项应该折叠成图标入口；在大屏 new session 页面，空间足够时应该展开显示。

本次重构要解决的是“控制面表达不准确”和“provider 能力边界不清楚”，不是重新设计 provider runtime。

## 2. 设计目标

- 建立一个 provider-specific 的 `Session Controls` 描述协议，由后端给前端可渲染 schema。
- UI 根据 schema 渲染，不猜 provider 的真实语义。
- 控制项的 label 必须准确：`Agent`、`Plan`、`Approval`、`Permission`、`Model`、`Effort`、`Variant` 分开表达。
- 每个控制项必须声明适用时机：`prelaunch`、`live`、`both`、`readonly`。
- 每个控制项必须声明来源：`native`、`api`、`config`、`cache`、`staticFallback`。
- Claude tmux/TUI fallback session 不假装支持运行中热切；运行中状态以 Claude 原生 TUI 为准。
- Codex / OpenCode native local server session 只有在 adapter 明确支持时才开放 live 修改。
- Chat 页面、历史浏览页面和 new session 页面复用同一套 schema 和控件渲染，不复制逻辑。

## 3. 非目标

- 不做全 provider 的统一权限枚举。
- 不在第一阶段实现 Claude `/permissions` 规则编辑器。
- 不解析 provider TUI 画面来判断可用控制项。
- 不因为 model/permission 探知失败阻塞 session 创建。
- 不把 OpenCode permission rules 暴露成普通用户一级菜单。
- 不承诺用户在 provider 原生 TUI 内 `/new`、`/resume`、切 agent 后 RAH 一定自动追踪所有状态变更。

## 4. 已查明事实

### 4.1 Claude

Claude Code 有两个不同控制面。

第一层是会话级 `permission-mode`。本机 `claude --help` 显示：

```text
--permission-mode <mode>
choices: acceptEdits, auto, bypassPermissions, default, dontAsk, plan
```

TUI 里 `Shift+Tab` 常见切换路径是：

```text
Accept Edits on
Plan Mode on
Bypass Permissions on
```

这组在 CLI 启动参数层面是同一个互斥字段，适合在 RAH 顶层表达为一个 `Session Mode` 下拉：

- `Default`
- `Accept Edits`
- `Plan`
- `Bypass Permissions`

不要把 Claude `Plan` 单独拆成 on/off；否则会产生无法真实表达的组合，例如 `Plan + Bypass Permissions`。

第二层是 Claude TUI `/permissions` 规则编辑器，里面的 `allow / ask / deny / workspace` 是工具和目录规则，不是会话级 mode。它对应的 CLI 能力更接近：

- `--allowedTools`
- `--disallowedTools`
- `--add-dir`

第一阶段不把 `/permissions` 规则编辑器放进一级 controls。

Claude 当前 RAH runtime 是 `tui_mux_fallback` / tmux。拉起后真实 TUI 是 owner，RAH 不应假装能可靠热切所有内部模式。因此 Claude controls 默认只在 `prelaunch` 生效。

### 4.2 Codex

Codex 的权限 preset 来自原生 `/permissions` 语义。当前应暴露：

```text
Default
Auto Review
Full Access
```

建议映射：

```text
Default     -> approval_policy=on-request + sandbox=workspace-write
Auto Review -> Default + approvals_reviewer=auto_review / guardian_subagent
Full Access -> approval_policy=never + sandbox=danger-full-access
```

`Read Only` 可以作为高级/隐藏项，默认不展示。原因是 Codex TUI 在 macOS/Linux 的 `/permissions` 中本来就不把它作为一线选项显示。

Codex 的 `Plan` 不应混在权限菜单里。它是 collaboration/work mode。RAH native local server path 可以通过 app-server / runtime config 把 plan 信息应用到 turn/session；如果某个入口只是纯 TUI CLI 参数且没有稳定参数支持，必须降级为不可预设，而不是伪造成功。

### 4.3 OpenCode

OpenCode 的 `build / plan` 不是传统权限模式，而是 agent 选择。

从 OpenCode ACP 源码确认：

- ACP 会调用 `app.agents()` 获取可用 agent。
- 过滤 `hidden` 和 `subagent`。
- 把可见 agent 映射成 `availableModes`。
- `session/set_mode` 实际上是设置 `session.modeId = modeId`。

因此如果用户配置了自定义 agent，例如 `sisyfus`，它也应该作为 OpenCode `Agent` 选项出现。

OpenCode 同时有底层 permission rules 引擎：

- permission key 包括 `edit`、`bash`、`read`、`webfetch` 等。
- action 是 `ask | allow | deny`。
- 工具触发审批时会产生结构化 `permission.asked` / `permission.replied` 事件。

但这不等于 OpenCode 有面向普通用户的 `permission mode` 菜单。RAH 第一阶段不暴露 OpenCode tool rules，只接运行时 approval 事件。

### 4.4 AionUi 参考结论

AionUi 对 OpenCode 的做法是“动态优先 + 静态 fallback”：

- UI 有 `opencode: build / plan` 的静态 fallback。
- 但 AgentModeSelector 优先使用运行时 `dynamicModes`。
- 其次使用缓存的 `acp.cachedModes` 或 `acp.cachedConfigOptions`。
- 最后才使用静态列表。

RAH 应吸收这个模式，但命名更准确：OpenCode 这里叫 `Agent`，不是 `Permission`。

## 5. 核心抽象

### 5.1 Session Controls

`Session Controls` 是一个 schema-driven 控制模块。后端返回当前 provider / session / workspace 下可用的控制项，前端按 schema 渲染。

建议协议形状：

```ts
type SessionControlsDescriptor = {
  provider: "codex" | "claude" | "gemini" | "opencode";
  context: "prelaunch" | "live" | "history";
  source: CapabilitySource;
  groups: SessionControlGroup[];
  diagnostics?: SessionControlDiagnostic[];
};

type CapabilitySource =
  | "native"
  | "provider_api"
  | "provider_config"
  | "cache"
  | "static_fallback";

type ApplyTiming = "prelaunch" | "live" | "both" | "readonly";

type SessionControlGroup = {
  id: string;
  label: string;
  role: "work_mode" | "approval" | "permission" | "agent" | "model" | "model_option" | "advanced";
  items: SessionControlItem[];
};

type SessionControlItem =
  | SessionControlSelect
  | SessionControlBoolean
  | SessionControlNestedSelect;
```

关键字段：

```ts
type BaseControlItem = {
  id: string;
  label: string;
  description?: string;
  applyTiming: ApplyTiming;
  mutable: boolean;
  disabledReason?: string;
  source: CapabilitySource;
  exact: boolean;
  providerNativeId?: string;
};
```

`exact=false` 表示该项来自静态 fallback 或缓存，只是 UI convenience，不代表 provider 当前版本一定支持。提交时后端仍必须验证。

### 5.2 Work Mode 与 Approval 分离

顶层必须区分：

- `Work Mode`: 是否进入 planning / build / agent 工作形态。
- `Approval / Permission`: 工具执行前如何确认、是否绕过审批、是否进入 full access。
- `Runtime Approval`: 某个工具调用发出的单次批准请求。

这三者不能混成同一个下拉。

但这个原则不能反过来强行改写 provider 原生命令行语义：

- Codex 的 `Plan` 与权限 preset 在 app-server / turn context 中是两个维度，因此 RAH 可以拆成独立 `Plan` toggle + `Permission` 下拉。
- Claude 的 `Plan` 是 `--permission-mode plan` 的一个值，因此 RAH 必须把它作为 `Session Mode` 互斥选项。
- OpenCode 的 `plan` 是 agent 名称，因此 RAH 必须把它作为 `Agent` 选项。

## 6. Provider 控制项设计

### 6.1 Codex

#### 控制项

```text
Plan
- Off
- On

Permission
- Default
- Auto Review
- Full Access

Model
- 动态 model list

Effort
- 仅当选中 model 有 effort options 时显示
```

#### 能力来源

| 控制项 | 来源 | fallback | prelaunch | live |
| --- | --- | --- | --- | --- |
| Plan | Codex app-server / runtime config | off | 可存为 first-turn/session config | native local server 可改 |
| Permission | 静态 Codex preset | Default | 可应用 | native local server 支持时可改 |
| Model | Codex app-server / config / cached runtime data | provider default | 可应用 | native local server 支持时可改 |
| Effort | Codex model option / config profile | provider default | 可应用 | native local server 支持时可改 |

#### `codex --help` 的定位

Codex `--help` 可以作为辅助探针，但不能作为 RAH Web/live controls 的唯一能力来源。

原因：

- `codex --help` 主要描述 CLI/TUI 启动参数。
- RAH 当前 Codex 主线是 `native_local_server`：web turn 通过 app-server `thread/start` / `turn/start` 控制，不是每次拼 `codex` CLI 参数。
- 这些 CLI 参数和 app-server 字段大多同源于 Codex core config，所以可以互相校验；但并非完全等价。

可利用的部分：

```text
--model
--sandbox <read-only|workspace-write|danger-full-access>
--ask-for-approval <untrusted|on-failure|on-request|never>
--dangerously-bypass-approvals-and-sandbox
-c model_reasoning_effort=...
```

这些可用于：

- 验证本机 Codex CLI 是否支持某个启动参数。
- 为 `rah codex` 真实 TUI client 启动参数提供 fallback。
- 作为 static fallback 的诊断来源。

不能只靠 `--help` 的部分：

- `Auto Review` 对应 app-server / config 的 `approvalsReviewer=auto_review`，CLI help 不会作为普通一线参数完整表达。
- `Plan` / collaboration mode 对应 app-server `collaborationMode/list` 和 `turn/start.collaborationMode`，不应从 CLI help 推断。
- live session 的 next-turn model/effort/permission 应以 app-server schema 和 provider 返回为准。

因此 Codex capability source 优先级应是：

```text
app-server schema / runtime capability
> config/read / collaborationMode/list
> model catalog / local config
> codex --help
> static fallback
```

#### 静态权限定义

```ts
const CODEX_PERMISSION_CONTROLS = [
  {
    id: "default",
    label: "Default",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  {
    id: "auto_review",
    label: "Auto Review",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "auto_review",
  },
  {
    id: "full_access",
    label: "Full Access",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
];
```

### 6.2 Claude

#### 控制项

```text
Session Mode
- Default
- Accept Edits
- Plan
- Bypass Permissions

Model
- 动态或缓存 model list

Effort
- 仅当可探知或手动配置时显示
```

#### 映射

```text
Default            -> --permission-mode default
Accept Edits       -> --permission-mode acceptEdits
Plan               -> --permission-mode plan
Bypass Permissions -> --permission-mode bypassPermissions
```

Claude 的 `plan` 和 `default / acceptEdits / bypassPermissions` 在启动参数层面是同一个互斥字段：`--permission-mode <mode>`。因此 Claude 不应拆成两个可同时选择的控件。

#### 能力来源

| 控制项 | 来源 | fallback | prelaunch | live |
| --- | --- | --- | --- | --- |
| Session Mode | `claude --help` permission-mode choices + fallback | Default | `--permission-mode <mode>` | 不支持，TUI owner |
| Model | Claude CLI / config / cache | provider default | `--model` | 不支持，TUI owner |
| Effort | Claude CLI / config / cache | provider default | `--effort` | 不支持，TUI owner |

#### `--permission-mode` 探知

Claude session mode options 不应完全硬编码。RAH 可以在本机启动前运行：

```bash
claude --help
```

并解析这一行：

```text
--permission-mode <mode>  Permission mode to use for the session (choices: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan")
```

解析规则：

- 从 `choices:` 后提取引号内的 mode id。
- `default`、`acceptEdits`、`plan`、`bypassPermissions` 进入一线 `Session Mode` 下拉。
- `auto`、`dontAsk` 默认隐藏；如果未来需要，可放入 Advanced。
- 如果 `claude --help` 不可用或解析失败，fallback 到当前静态列表：

```text
Session Mode: default / acceptEdits / plan / bypassPermissions
```

这种方式的好处是：Claude CLI 未来新增或移除 permission mode 时，RAH 至少能在诊断和 advanced UI 中感知变化，而不是完全依赖静态代码。

#### 不展示项

第一阶段不要展示：

- `auto`
- `dontAsk`
- `/permissions` 的 `allow / ask / deny / workspace`

原因：

- `auto / dontAsk` 不是清晰的一线 TUI 主路径。
- `/permissions` 是规则编辑器，应作为未来 `Advanced Claude Rules` 独立模块。

### 6.3 OpenCode

#### 控制项

```text
Agent
- 来自 OpenCode ACP/API availableModes
- fallback: build / plan

Model
- 来自 OpenCode provider config / server API

Variant
- 仅当选中 model 有 variants/reasoning options 时显示
```

#### 能力来源

| 控制项 | 来源 | fallback | prelaunch | live |
| --- | --- | --- | --- | --- |
| Agent | OpenCode server `/agent` / ACP `modes.availableModes`，同源于 `app.agents()` | build / plan | 可应用 | native local server 支持时可改 |
| Model | OpenCode providers/config/server API | provider default | 可应用 | API 支持时可改 |
| Variant | OpenCode model variants | model default | 可应用 | API 支持时可改 |
| Approval | `permission.asked` event | 无 | 不作为菜单项 | 单次事件响应 |

#### 命名要求

OpenCode 不显示 `Permission` 菜单。显示：

```text
Agent: build
Agent: plan
Agent: sisyfus
```

如果 OpenCode 返回的 mode name 是自定义 agent 名，RAH 原样展示。

实现细节：

- Prelaunch catalog 不应为了拿 agent 列表创建一次假 ACP session，因为这会污染 OpenCode 历史。
- RAH 启动 OpenCode server 后优先读 `/agent`；该 endpoint 与 ACP `loadAvailableModes()` 一样来自 OpenCode `app.agents({ directory })`。
- 已经存在的 live ACP/session response 若带 `availableModes`，可以覆盖或刷新当前 session 的 agent 列表。
- 如果 `/agent` 不可用，fallback 到 `build / plan`。

## 7. Model / Effort / Variant 探知策略

### 7.1 Source Ladder

能力来源优先级：

1. 当前 live provider server / ACP response。
2. provider native online capability endpoint。
3. provider local config / schema。
4. RAH 上次成功运行缓存。
5. 静态 fallback。

前端必须展示来源状态，至少用于调试：

```text
source: provider_api
exact: true
```

或：

```text
source: static_fallback
exact: false
```

### 7.2 菜单行为

Model 菜单选中后：

- 如果该 model 有 effort / variant options，显示第二级菜单。
- 如果没有 options，不显示第二级菜单，也不展示空状态。
- 如果 options 依赖 model，切换 model 后自动重算有效 option。
- 如果原选中的 option 不属于新 model，回退到该 model 的 default option。

### 7.3 权威证据

验证时不能依赖模型自述。必须使用 provider 原生 metadata：

- Codex: rollout JSONL / app-server turn context 中的 model、effort、collaboration mode。
- OpenCode: message API 中的 providerID、modelID、variant、mode、agent。
- Claude: prelaunch 参数构造和 Claude 原生日志/JSONL 可用字段；运行中以 TUI 为准。

## 8. 前端呈现规则

### 8.1 三种形态

同一个 `SessionControlsRenderer` 支持三种外壳：

```text
IconButton
ExpandedBar
Panel / Sheet
```

| 页面/状态 | 默认形态 | 说明 |
| --- | --- | --- |
| Chat 页面 | 图标 | 点击打开 popover / sheet |
| 历史浏览页面 | 图标 | 只读历史不应误导为 live 可变 |
| New Session 大屏 | 展开 | 空间足够时直接展示 provider、agent/permission、model、option |
| New Session 空间不足 | 图标 | 右侧 inspector 打开或 composer 宽度不足时折叠 |
| 移动端 | 图标 | 打开 bottom sheet |

### 8.2 宽度判定

不要用设备类型硬编码判断“iPad 竖屏像手机”。应使用实际可用宽度：

```text
availableComposerWidth >= controlsMinExpandedWidth -> ExpandedBar
otherwise -> IconButton
```

`controlsMinExpandedWidth` 应由当前 provider controls 的实际项目数量决定：

```text
baseComposerMinWidth
+ provider selector width
+ session controls width
+ model selector width
+ option selector width
+ gap tokens
```

如果打开右侧 inspector 后 composer 变窄，应自动折叠为图标。

### 8.3 Thinking / Running 时锁定

当 session 正在 thinking / tool running / stopping 时：

- `Session Controls` 图标整体 disabled。
- 点击 disabled 图标时，在图标附近显示轻量提示：

```text
Session controls are locked while the turn is running.
```

不要只禁用某一个子项。用户看到部分可点、部分不可点会误判。

### 8.4 Live / History / Prelaunch 文案

`prelaunch`：

```text
These controls will be applied when the session starts.
```

`live mutable`：

```text
Changes apply to the next turn.
```

`external_locked` / Claude tmux：

```text
This session is owned by the native TUI. Change this in the terminal TUI.
```

`history readonly`：

```text
History view is read-only. Resume or claim the session to change controls.
```

## 9. 后端 API 设计

### 9.1 Prelaunch Controls

建议新增或规范化 endpoint：

```http
GET /api/session-controls?provider=codex&cwd=/path/to/workspace&context=prelaunch
```

返回：

```json
{
  "provider": "opencode",
  "context": "prelaunch",
  "source": "provider_api",
  "groups": [
    {
      "id": "agent",
      "label": "Agent",
      "role": "agent",
      "items": [
        {
          "id": "agent",
          "type": "select",
          "label": "Agent",
          "value": "build",
          "options": [
            { "id": "build", "label": "build" },
            { "id": "plan", "label": "plan" }
          ],
          "applyTiming": "both",
          "mutable": true,
          "source": "provider_api",
          "exact": true
        }
      ]
    }
  ]
}
```

### 9.2 Live Session Controls

```http
GET /api/sessions/:id/controls
PATCH /api/sessions/:id/controls
```

`PATCH` 只接受后端已声明的 control id 和 option id。前端不能提交任意 provider-native 字符串。

示例：

```json
{
  "changes": {
    "codex.plan.enabled": true,
    "codex.permission.preset": "auto_review",
    "model.id": "gpt-5.5",
    "model.option.model_reasoning_effort": "xhigh"
  }
}
```

后端返回实际 applied 值：

```json
{
  "applied": {
    "codex.plan.enabled": true,
    "codex.permission.preset": "auto_review",
    "model.id": "gpt-5.5",
    "model.option.model_reasoning_effort": "xhigh"
  },
  "descriptor": {}
}
```

如果 provider 拒绝：

```json
{
  "error": {
    "code": "CONTROL_NOT_MUTABLE",
    "message": "Claude tmux sessions can only apply approval mode before launch."
  }
}
```

### 9.3 Start Session Request

`StartSessionRequest` 不应继续堆散字段。建议统一为：

```ts
type StartSessionRequest = {
  provider: ProviderKind;
  cwd: string;
  controls?: Record<string, unknown>;
};
```

为了兼容现有代码，可先双写：

```ts
{
  modeId,
  model,
  reasoningId,
  optionValues,
  controls
}
```

后端 adapter 内部以 `controls` 为新入口，旧字段作为兼容输入转换成 controls。

## 10. Provider Adapter 职责

每个 provider adapter 必须提供：

```ts
interface ProviderSessionControls {
  resolvePrelaunchControls(input): Promise<SessionControlsDescriptor>;
  resolveLiveControls(session): Promise<SessionControlsDescriptor>;
  applyPrelaunchControls(request, controls): ProviderLaunchConfig;
  applyLiveControls(session, changes): Promise<AppliedControls>;
}
```

最低要求：

- 没有能力时返回空 groups，而不是抛错。
- 静态 fallback 必须标记 `exact=false`。
- 所有提交值都必须后端验证。
- provider 原生 id 不稳定时，不写死成共享顶层枚举。

## 11. 与 runtime 的关系

### 11.1 Codex native local server

Codex controls 可以走 native local server / app-server：

- Start 前创建 thread/session 时应用 model、effort、plan、permission。
- Live 后通过 provider server 能力应用到 next turn。
- TUI 只是 attach client，不是唯一 state owner。

### 11.2 Claude tmux fallback

Claude controls 只负责启动参数：

- `--permission-mode`
- `--model`
- `--effort`

拉起后：

- RAH Web 显示 readonly/locked 状态。
- 用户在 TUI 内使用 Claude 原生 `Shift+Tab`、`/permissions`、`/model`。
- RAH 可以从 JSONL/history mirror 展示结果，但不声称控制了 TUI state。

### 11.3 OpenCode native local server

OpenCode controls 走 server / ACP：

- Agent 从 `availableModes` 动态探知。
- Model / variant 从 provider config/server API 探知。
- 运行时 approval 接 `permission.asked / permission.replied`，不做成权限菜单。

## 12. 测试计划

### 12.1 Unit Tests

- Descriptor schema 生成：
  - Codex static permission options。
  - Claude approval + plan override。
  - OpenCode dynamic agent options。
- Model -> option 联动：
  - 有 effort/variant 时显示。
  - 没有时不显示。
  - 切 model 后 invalid option 回退。
- Apply timing：
- Claude live controls disabled；Claude 的 `plan` 不作为独立 toggle。
  - Codex/OpenCode live mutable 只在 runtime feature 支持时开启。

### 12.2 Runtime Tests

- Codex launch config 映射：
  - Default / Auto Review / Full Access。
  - Plan on/off。
  - model + effort。
- Claude launch args 映射：
  - Plan on -> `--permission-mode plan`。
  - Plan off + Accept Edits -> `--permission-mode acceptEdits`。
  - Bypass -> `--permission-mode bypassPermissions` + required danger flag if current code path needs it。
- OpenCode:
  - 从 fake ACP/API 返回 custom agent `sisyfus`，UI descriptor 出现 `Agent: sisyfus`。
  - fallback 时出现 `build / plan` 且 `exact=false`。

### 12.3 Browser/UI Tests

- Chat 页面显示图标入口。
- 历史浏览页面显示图标入口，readonly 文案正确。
- New Session 大屏空间足够时 controls 展开。
- 打开右侧 inspector 后 composer 变窄，controls 自动折叠为图标。
- Thinking 时 controls 整体 disabled，点击显示提示。
- iPad 竖屏只要宽度足够仍展开，不按 device type 强制折叠。

### 12.4 Real Provider Smoke

沿用并扩展 `docs/session-control-capability-smoke.zh-CN.md`：

- Codex: 用 rollout / app-server metadata 证明 model、effort、plan、permission preset 生效；`Auto Review` 必须进入 app-server `approvalsReviewer=auto_review`。
- OpenCode: 用 message API 证明 providerID、modelID、variant、agent/mode 生效；agent 列表优先来自 `/agent`/ACP 同源数据。
- Claude: 只验证启动参数构造和 TUI 启动成功；运行中热切不作为承诺。

## 13. 落地顺序

### Phase 1: 协议与静态 provider controls

- 新增 `SessionControlsDescriptor` 协议类型。
- Codex 静态 permission presets。
- Claude 静态 session mode fallback；动态时从 `claude --help` 解析 `--permission-mode` choices。
- OpenCode fallback agent `build / plan`。
- 后端返回 descriptor，前端先只读展示。

### Phase 2: 动态能力探知

- OpenCode 接 server `/agent` 与 ACP `availableModes`。
- OpenCode 接 model / variant provider config。
- Codex 接 model / effort capability。
- Claude 接可获得的 model / effort 信息；无法探知时只显示 provider default 或缓存。
- Web 启动后立即静默预热 Codex、Claude、Gemini、OpenCode 四家 provider catalog；预热不得阻塞 app 初始化、session 创建、composer 输入或 TUI attach。
- Web 前端每 30 分钟静默全量刷新四家 provider catalog。这是固定后台预热循环，和 picker 的 TTL、Settings 手动刷新互相独立。
- 用户打开 provider/model picker、Session Control 或 Council 需要展示某家模型列表时，只检查这家 provider。当前实现使用 5 分钟 TTL；TTL 内复用缓存，过期后只后台刷新该 provider，不触发四家全量刷新。
- Settings Models tab 的手动刷新是第三种入口：用户点击某家 provider 的 refresh 后强刷这一家，不受 5 分钟 TTL 限制，也不等待 30 分钟周期。刷新关闭 Settings 后仍继续；成功后同步 Settings last-success、daemon catalog cache/TTL、前端全局 model store；失败或 fallback 不更新 last-success。
- Settings Models tab 按 provider 纵向展示为可折叠行；折叠标题行显示 provider 图标、名称、effective model 数量、last-success、catalog source 和 refresh 按钮。展开后显示当前 effective model list，也就是 provider 探测结果加 active manual supplements；这里复用 Session Control / Council model picker 的模型行语义，但在 Settings 中只读。
- Manual supplement 模型在所有 effective model picker/list 中都有颜色标识。若后续 native probe 返回同一个 model id，则 native entry 是事实来源，manual entry 从 effective list 中被 shadow，不再按 active manual 标识展示。
- 刷新失败必须降级：保留旧 catalog，记录 error，不阻断 composer、history 浏览、session 启动或页面渲染。
- `cwd` 变化目前不作为刷新维度的强制失效条件；如果未来 provider 明确把能力与 workspace 强绑定，再单独引入 workspace-aware cache key。

### Phase 3: UI 统一组件

- 抽 `SessionControlsRenderer`。
- 抽三种外壳：`IconButton`、`ExpandedBar`、`Panel/Sheet`。
- Chat / History / New Session 统一使用。
- 加实际宽度折叠逻辑。

### Phase 4: Apply 与验证

- Prelaunch controls 写入 start request。
- Codex/OpenCode live controls 接 apply API。
- Claude live controls 锁定。
- 补 unit/runtime/browser/smoke 测试。

## 14. 验收标准

重构完成后必须满足：

- 前端不再出现统一误导性的 `Permission Mode` 表述。
- OpenCode 显示 `Agent`，且能动态出现自定义 agent。
- Claude `Plan` 不再与 `Approval` 分离成两个控件；它作为 `Session Mode` 的互斥选项存在。
- Codex `Plan` 与 `Permission` 分离。
- Model 菜单和 effort/variant 菜单按 provider capability 动态展示。
- Chat / History 使用图标入口；New Session 大屏可展开，空间不足自动折叠。
- Thinking 中 controls 整体不可点，提示清楚。
- Claude live session 显示 locked，不假装可热切。
- 所有 controls 提交由后端验证，前端不能提交任意 provider-native 字符串。
- 真实 provider smoke 能证明 Codex/OpenCode 的关键控制项进入 provider 原生 metadata。

## 15. 当前建议的默认 UI

### Codex

```text
Plan: Off / On
Permission: Default / Auto Review / Full Access
Model: <dynamic>
Effort: <model-specific, optional>
```

### Claude

```text
Session Mode: Default / Accept Edits / Plan / Bypass Permissions
Model: <dynamic or cached>
Effort: <optional>
```

### OpenCode

```text
Agent: <dynamic from ACP/API, fallback build / plan>
Model: <dynamic>
Variant: <model-specific, optional>
```

OpenCode approval 不在菜单里。它是运行时 `permission.asked` 事件，出现在 turn 过程中。
