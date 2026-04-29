# Provider Adapter 协议与能力边界

Date: 2026-04-29

本文记录 RAH 当前的 provider adapter 标准协议。目标是让 Codex / Claude / Gemini / Kimi / OpenCode 的差异尽量收在 adapter 内部，前端只面对 RAH 自己的稳定能力协议。

## 1. 总原则

RAH 不把某一家 CLI 的原生概念直接暴露成前端公共逻辑。

正确边界是：

- `runtime-protocol` 定义跨 provider 的能力字段和请求/响应。
- `runtime-daemon` 的 `ProviderAdapter` 负责把 RAH 请求翻译成 provider-native 行为。
- `client-web` 只消费 `SessionSummary`、`ProviderModelCatalog`、`RahEvent` 和通用 API。
- provider 原生 id 可以作为 `modeId` / `modelId` 的值存在，但它们的解释权属于 adapter。

因此，前端不应该写：

- Codex 的 `approvalPolicy + sandbox` 怎么组合。
- Claude 的 `bypassPermissions` 是否等于 full auto。
- Gemini 的 `yolo` 应该怎么启动。
- Kimi 的 `default/yolo` 是否需要重启 wire client。
- OpenCode 的 `opencode/full-auto` 如何写 session permission ruleset。

这些都属于 adapter。

## 2. ProviderAdapter 标准能力

当前 adapter seam 位于 `packages/runtime-daemon/src/provider-adapter.ts`。

代码上 `ProviderAdapter` 已拆成类型层面的 capability slices：

- `ProviderLifecycleAdapter`
- `ProviderInputControlAdapter`
- `ProviderModeCapabilityAdapter`
- `ProviderModelCapabilityAdapter`
- `ProviderActionCapabilityAdapter`
- `ProviderPermissionCapabilityAdapter`
- `ProviderWorkspaceCapabilityAdapter`
- `ProviderStoredHistoryAdapter`
- `ProviderContextCapabilityAdapter`
- `ProviderDiagnosticAdapter`
- `ProviderDebugAdapter`
- `ProviderShutdownAdapter`

这些 slice 目前仍组合成一个 `ProviderAdapter` 传给 runtime engine，但协议含义已经分层。新增 provider 时应逐项确认，而不是把所有能力当成“start/sendInput 附属功能”。

核心能力：

| 能力 | Adapter 方法 / 字段 | 说明 |
| --- | --- | --- |
| 创建 live session | `startSession(request)` | Web new 入口。接收 RAH 标准 `StartSessionRequest`，adapter 决定 provider-native 启动方式。 |
| 恢复 live session | `resumeSession(request)` | Web claim/resume 入口。接收 RAH 标准 `ResumeSessionRequest`。 |
| 输入 | `sendInput(sessionId, request)` | 只对 live controllable session 有效。 |
| 中断 | `interruptSession(sessionId, request)` | Adapter 自己决定是否能传 provider-native interrupt。 |
| 关闭/归档 | `closeSession` / `destroySession` | 关闭 RAH 管理的执行体，不删除 provider 历史。 |
| 重命名 | `renameSession` | 原生支持则写 provider 存储；不支持则由 RAH 本地 override。 |
| 模式切换 | `setSessionMode(sessionId, modeId)` | 运行中切权限/plan 等 mode。具体实现 adapter-owned。 |
| 模型切换 | `setSessionModel(sessionId, request)` | 运行中原子切换模型和该模型声明的 optionValues。具体实现 adapter-owned。 |
| 模型/模式目录 | `listModels(options)` | 返回 `ProviderModelCatalog`，里面包含模型、mode、config、profile。 |
| 权限响应 | `respondToPermission` | 把 RAH 的通用 approval response 翻译成 provider-native 回复。 |
| 历史分页 | `listStoredSessions` / `getHistoryPage` | provider 原始历史解析为 canonical timeline。 |
| 文件/Git | `getWorkspaceSnapshot` / `getGitStatus` / `getGitDiff` / apply actions | 使用 workspace scope，不能让请求方自带任意 root 绕过边界。 |

新增 provider 时，不能只实现 `startSession/sendInput`。至少要明确声明：

- 是否支持 native rename。
- 是否支持 delete stored session。
- 是否支持 mode catalog。
- 是否支持 runtime mode switch。
- 是否支持 model catalog。
- 是否支持 runtime model switch。
- 是否支持 permission response。
- 是否支持 stored history paging。

## 3. Mode 协议

### 3.1 RAH 请求只传 `modeId`

`StartSessionRequest` 和 `ResumeSessionRequest` 都支持：

```ts
modeId?: string;
```

前端不再把 mode 翻译成 provider-native 参数。比如：

- Codex 不由前端拆成 `approvalPolicy=never` + `sandbox=danger-full-access`。
- Claude 不由前端把 `bypassPermissions` 转成 `approvalPolicy=never`。
- OpenCode 不由前端写 `providerConfig.rah_session_mode`。

前端只传 `modeId`。Adapter 负责解释。

### 3.2 Mode catalog

`ProviderModelCatalog` 可以返回：

```ts
defaultModeId?: string;
modes?: SessionModeDescriptor[];
```

`SessionModeDescriptor` 当前包含：

```ts
{
  id: string;
  role?: "ask" | "auto_edit" | "full_auto" | "plan" | "custom";
  label: string;
  description?: string;
  applyTiming?: "immediate" | "next_turn" | "idle_only" | "restart_required" | "startup_only";
  hotSwitch: boolean;
}
```

`id` 是 provider/adapter 原生可执行 id。`role` 是 RAH UI 可理解的语义角色。`applyTiming` 描述该 mode 在 live session 中的应用时机：

| applyTiming | 语义 |
| --- | --- |
| `immediate` | Adapter 可以同步到当前 live control plane；如果当前正在生成，产品层仍可选择等 idle。 |
| `next_turn` | 当前 turn 不变，下一次用户输入开始生效。 |
| `idle_only` | 只能在 session idle 时切换，通常因为要重启/重配 provider client。 |
| `restart_required` | 需要重启 live session 才能完整生效。 |
| `startup_only` | 只能在创建/claim 前选择，live 后不能切换。 |

前端可以用 `role` 做稳定展示：

| role | UI 语义 |
| --- | --- |
| `ask` | 需要确认/较低权限模式，统一展示为 Ask |
| `auto_edit` | 自动编辑/低摩擦模式，统一展示为 Auto edit |
| `full_auto` | 最大权限/最低打断模式，统一展示为 Full auto |
| `plan` | plan/planning 模式，作为独立开关展示 |
| `custom` | 无法归入上面角色的 provider-specific mode，展示 adapter label |

注意：`role` 不等于 provider 的实现方式。Codex 的 `on-request/read-only` 仍然可能通过 approval 请求提升权限，因此 UI 不应把它叫成绝对意义上的“只读系统”。它的稳定语义是 `ask`。

### 3.3 当前 mode 映射

| Provider | RAH mode id | role | applyTiming | 说明 |
| --- | --- | --- | --- | --- |
| Codex | `on-request/read-only` | `ask` | `next_turn` | approval on-request + read-only sandbox，写操作可请求提升 |
| Codex | `on-request/workspace-write` | `auto_edit` | `next_turn` | workspace-write sandbox，越界再问 |
| Codex | `never/workspace-write` | `full_auto` | `next_turn` | 不问 approval，但仍保留 workspace sandbox |
| Codex | `never/danger-full-access` | `full_auto` | `next_turn` | 不问 approval，无 sandbox，默认 |
| Codex | `plan` | `plan` | `next_turn` | app-server collaboration mode |
| Claude | `default` | `ask` | `immediate` | SDK permission mode default |
| Claude | `acceptEdits` | `auto_edit` | `immediate` | 自动接受编辑，风险操作仍可能问 |
| Claude | `bypassPermissions` | `full_auto` | `immediate` | 默认 |
| Claude | `plan` | `plan` | `immediate` | Claude 原生 plan mode |
| Gemini | `default` | `ask` | `next_turn` | Gemini approval mode default |
| Gemini | `auto_edit` | `auto_edit` | `next_turn` | 自动批准编辑类工具 |
| Gemini | `yolo` | `full_auto` | `next_turn` | 默认 |
| Gemini | `plan` | `plan` | `next_turn` | Gemini plan mode |
| Kimi | `default` | `ask` | `idle_only` | wire client 默认审批 |
| Kimi | `yolo` | `full_auto` | `idle_only` | `--yolo`，默认 |
| Kimi | `plan` | `plan` | `idle_only` | `set_plan_mode` |
| OpenCode | `build` | `ask` | `next_turn` | native build mode + permission ask ruleset |
| OpenCode | `opencode/full-auto` | `full_auto` | `next_turn` | RAH 写入 permission allow ruleset，默认 |
| OpenCode | `plan` | `plan` | `next_turn` | native plan mode |

## 4. Model / Reasoning / Config 协议

模型选择已经标准化为“模型 id + 模型声明的 option map”：

```ts
model?: string;
optionValues?: Record<optionId, SessionConfigValue>;
```

运行中切换使用：

```ts
setSessionModel(sessionId, { modelId, optionValues? })
```

`ProviderModelCatalog.models` 返回基础模型列表；模型自己的参数放在：

- `SessionModelDescriptor.reasoningOptions`
- `ProviderModelCatalog.configOptions`
- `ProviderModelCatalog.modelProfiles`
- `ManagedSession.config`
- `ManagedSession.modelProfile`

`optionValues` 的 key 只能来自当前模型可见的 `SessionConfigOption.id`。如果 Codex 模型只声明 `model_reasoning_effort`，请求就只能传：

```ts
{ optionValues: { model_reasoning_effort: "xhigh" } }
```

如果未来 Gemini 某个模型声明 `thinking_budget`，请求就只能传：

```ts
{ optionValues: { thinking_budget: 8192 } }
```

不存在“所有 provider 参数塞进同一个大对象再让 adapter 猜”的语义；未声明的 key 必须被拒绝。

原则：

- 不把所有 provider 的参数强行叫成 `effort`。
- Codex 的 reasoning effort、Claude 的 effort/max、Gemini 的 thinking budget/level、Kimi 的 thinking、OpenCode 的 variant 都是 adapter-owned option。
- 前端可以展示这些 option，但不能推断 provider-native wire shape。
- session 启动后，runtime-resolved `ManagedSession.model/config/modelProfile` 优先于 prelaunch catalog。
- `reasoningId` 仍是兼容字段，只映射到当前模型的第一个 reasoning/thinking/variant option；新调用应使用 `optionValues`。

## 5. Context Usage 协议

上下文余量是标准协议能力，不属于某个 provider 的 UI 补丁。

标准事件：

```ts
type ContextUsageBasis = "context_window" | "turn";
type ContextUsagePrecision = "exact" | "estimated";

interface ContextUsage {
  usedTokens?: number;
  contextWindow?: number;
  percentUsed?: number;
  percentRemaining?: number;
  basis?: ContextUsageBasis;
  precision?: ContextUsagePrecision;
  source?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalCostUsd?: number;
}
```

字段语义：

| 字段 | 语义 |
| --- | --- |
| `usedTokens` | token 数。只有 `basis=context_window` 时才表示“已占用上下文”。 |
| `contextWindow` | 当前模型/会话上下文总窗口。 |
| `percentRemaining` | 剩余上下文百分比。前端默认显示此语义，例如 `96% context` 表示还剩 96%。 |
| `percentUsed` | 已使用上下文百分比。作为派生字段保留，Daemon 会和 `percentRemaining` 互相补齐。 |
| `basis=context_window` | `usedTokens/contextWindow/percentUsed/percentRemaining` 表示上下文窗口占用。 |
| `basis=turn` | provider 只报告了本轮/累计 token 用量，不能当作上下文余量。 |
| `precision=exact` | provider 原生报告或 adapter 可确定计算。 |
| `precision=estimated` | adapter 通过模型目录、默认窗口或 fallback 估算。 |
| `source` | adapter 调试来源，例如 `codex.app_server.token_usage`。 |

Daemon 侧统一通过 `normalizeContextUsage()` 规范化：

- 当同时有 `usedTokens + contextWindow` 时，统一计算 `percentUsed` 和 `percentRemaining`，并默认 `basis=context_window`。
- 当只有 `percentUsed` 或 `percentRemaining` 时，Daemon 会补齐另一侧百分比并默认 `basis=context_window`。
- 当只有 `usedTokens` 且没有窗口时，默认 `basis=turn`，前端不能显示上下文百分比。
- 如果 adapter 没有声明 `precision`，默认视为 `exact`；如果使用硬编码/模型目录 fallback，adapter 必须显式写 `precision=estimated`。
- SessionStore 不再给所有 session 写死 `0 / 1,000,000`，未知就不显示上下文百分比。

前端展示规则：

- Header 继续只显示现有文本形式：`96% context`，语义为“剩余 96% 上下文”。
- 鼠标 hover 显示 token 明细，例如 `Used context: 40K / 1,000,000 tokens · 96% remaining`。
- 如果 `precision=estimated`，tooltip 用 `Estimated used context`。
- 不新增 composer 圆环，不把 provider-specific token 结构写入 UI。

当前 provider 状态：

| Provider | Context usage 状态 | 说明 |
| --- | --- | --- |
| Codex | `context_window / exact` | app-server `thread/tokenUsage/updated` 提供 token usage 与 model context window。 |
| Kimi | `context_window / exact` | status / session file 提供 `context_tokens`、`max_context_tokens`、`context_usage`。 |
| OpenCode | `context_window / exact` 或 `estimated` | ACP `usage_update` 是 exact；PromptResponse fallback 使用 provider catalog 的 `model.limit.context`。 |
| Claude | `context_window / estimated` 或 `turn / exact` | SDK 提供 usage；窗口以 AionUi `modelContextLimits` 表为基准，并额外支持 RAH CLI alias。模型 id 不可见时降级为 turn usage。 |
| Gemini | `context_window / estimated` | stats 提供 total/input/cache/output；窗口以 AionUi `modelContextLimits` 表为基准，并额外支持 `auto-gemini-*` alias。 |

## 6. Rename / Delete / Archive / Info

RAH 统一把 session 操作建模为 action capability：

```ts
actions: {
  info: boolean;
  archive: boolean;
  delete: boolean;
  rename: "none" | "local" | "native";
}
```

语义：

- `archive` / `close`：关闭 RAH 管理的 live 执行体，不删除 provider 历史。
- `delete`：删除或移入废纸篓 provider stored session。
- `info`：显示 session/provider/workspace/source 信息。
- `rename: native`：写入 provider 原生历史，使非 RAH TUI 的 resume list 也能看到。
- `rename: local`：provider 不支持原生 rename，RAH 持久化 display title override。
- `rename: none`：不支持。

兼容说明：`SessionCapabilities.renameSession` 是旧 boolean 字段，已由 `actions.rename` 取代。旧字段暂时保留给旧客户端，但应与 `actions.rename !== "none"` 保持一致。新逻辑只能读取 `actions.rename`。

当前状态：

- Codex / Claude / Kimi：native rename。
- Gemini：local rename。Gemini CLI 没有等价原生 rename，RAH 不假装它是 native。
- OpenCode：当前 rename/delete 仍按 adapter 能力声明，不由 UI 猜测。

Gemini local rename 需要维护 `provider:providerSessionId -> title` 的持久化 override；live session 尚未拿到 providerSessionId 时，先挂 pending override，拿到 id 后再迁移。

## 7. Permission Response 与 Permission Mode

RAH 区分两件事：

- Permission response：provider 正在问某一次 tool/action 是否允许。
- Permission mode：整个 session 的全局权限/plan/auto setting。

协议上：

- Permission response 走 `respondToPermission(sessionId, requestId, response)`。
- Permission mode 走 `setSessionMode(sessionId, modeId)`。

`livePermissions=true` 只表示可以回答 runtime approval，不表示可以修改全局 mode。

Terminal handoff session 通常是 `external_locked` mode：Web 可以观察/接管输入/回答部分 approval，但不从 Web 改 provider TUI 的全局权限设置。

## 8. 初始输入

前端不再判断某个 provider 是否要在 start request 中 bootstrap 首条 prompt。

当前规则：

1. 前端 `startSession` 创建 live session。
2. 若 composer 有首条输入，前端在 session 创建完成且 mode/model 对齐后调用标准 `sendInput`。
3. Adapter 如果要支持 API 调用者直接传 `initialPrompt`，可以自己消费，但 Web UI 不依赖 provider-specific bootstrap。

这样避免了 OpenCode 或其他 provider 的特判泄漏到前端。

## 9. 历史解析和 workspace metadata

历史解析属于 adapter 能力，不属于前端能力。

Adapter 负责：

- 发现 provider stored session。
- 解析 provider 原始 transcript。
- 过滤 provider 内部 bootstrap/control tags。
- 生成 canonical timeline。
- 恢复 `cwd/rootDir/title/preview/createdAt/updatedAt`。
- 对旧 session 做合理 metadata recovery。

Gemini 的特殊点：

- Gemini project hash / cache dir hash 都是 sha256，算法上不可逆。
- 但本机候选集可枚举，所以可以通过“对候选路径重新哈希比对”找回 workspace。
- 原始 session JSON/JSONL 中的 `displayContent` 是用户可见原文，`content` 可能包含 `@file` 展开后的全文；RAH 展示历史时必须优先用 `displayContent`，不能把扩展后的文件全文塞回用户消息。

## 10. ACP 的位置

RAH 不把 ACP 当作替代核心协议。

ACP 可以作为某个 adapter 的传输/控制实现，例如 OpenCode ACP。但 RAH 对前端和 runtime 的产品协议仍然是自己的：

- `ProviderAdapter`
- `ProviderModelCatalog`
- `ManagedSession`
- `RahEvent`
- `SessionModeDescriptor`
- `SessionActionCapabilities`

原因：

- AionUi 等成熟产品也会在 ACP 外保留产品层 session/mode/config 语义。
- 不同 provider 对 ACP 的支持不完整，Codex/Gemini/Kimi/Claude/OpenCode 能力边界并不一致。
- RAH 需要表达 terminal handoff、history replay、local rename override、workspace metadata recovery 等 ACP 不覆盖的产品语义。

## 11. 新 provider 接入检查清单

新增 adapter 或大改 adapter 时，至少检查：

- `listModels` 是否返回 `models/defaultModeId/modes`。
- `modes` 是否带正确 `role`。
- `startSession` / `resumeSession` 是否消费 `modeId/model/optionValues`，以及是否兼容旧 `reasoningId`。
- `setSessionMode` 是否和启动 mode 语义一致。
- `setSessionModel` 是否和启动 model 语义一致。
- `actions.rename/delete/archive/info` 是否准确声明。
- `rename: local/native/none` 是否准确。
- context usage 是否正确声明 `basis/precision/source`，不把 turn token 伪装成 context window。
- `livePermissions` 是否只表示 approval response，不混入 mode switching。
- terminal handoff 是否使用 `external_locked`，避免 Web 错误显示可修改全局权限。
- stored history 是否能 tail-first paging，不一次性全量加载。
- metadata cache 是否能稳定恢复 workspace/title/preview。
- provider-native 原始字段是否只保留在 adapter/raw，不泄漏进主 UI。

## 12. 前端允许保留的 provider 分支

不是所有 `provider === "codex"` 都是坏味道。前端允许保留的 provider 分支只限于展示和索引：

- Provider logo、颜色、显示名。
- 当前选中的 provider。
- 按 provider 分桶缓存 `ProviderModelCatalog`。
- 按 provider 记住上次选择的模型和参数。
- 按 provider/session id 查找同一个历史 session 或 live projection。

前端不允许保留的 provider 分支：

- 把 `modeId` 拆成 Codex `approvalPolicy/sandbox`。
- 把 Claude permission mode 映射成 RAH 权限文案。
- 把 Gemini `yolo/default/auto_edit` 直接写进 UI 菜单。
- 把 Kimi `--yolo` 或 wire restart 规则写在 Web UI。
- 把 OpenCode permission ruleset 写在 Web UI。
- 为某个 provider 特判首条消息发送方式。

如果前端为了实现一个能力必须知道 provider-native 字段，说明这个能力还没有被 adapter 协议化。

## 13. 兼容字段

`StartSessionRequest` / `ResumeSessionRequest` 里仍保留这些字段：

- `providerConfig`
- `approvalPolicy`
- `sandbox`
- `initialPrompt`

它们是 API 兼容和 adapter 内部 escape hatch，不是 Web UI 的公共设计入口。

当前 Web UI 规则：

- 创建/claim 时只发送 `modeId/model/optionValues`；`reasoningId` 只作为旧接口兼容别名保留。
- 首条 composer 输入不走 `initialPrompt` 特判，而是在 session 创建完成后通过标准 `sendInput` 发送。
- 如果 adapter 需要兼容外部 API 调用者传 `initialPrompt`，可以自己消费，但不能要求前端知道这个差异。

未来如果要移除兼容字段，必须先确认所有非 Web API 调用路径已经迁移。
