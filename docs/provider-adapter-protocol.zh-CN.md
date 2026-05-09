# Provider Adapter 协议与能力边界

日期：2026-05-08

本文记录当前 provider runtime 主线下 provider adapter 的边界。旧 structured/enhanced adapter 只作为 legacy/test harness 保留，不再是公开 live 主路径。

当前 core live provider：

- Codex
- Claude
- OpenCode

Gemini/Kimi CLI 一等支持已移除；相关模型通过 OpenCode/API provider 承载。

## 1. 总原则

RAH 不把某一家 CLI 的原生概念直接暴露成前端公共逻辑。

正确边界：

- `runtime-protocol` 定义跨 provider 的能力字段和请求/响应。
- Codex/OpenCode 的 provider native local server event 是 live truth。
- Claude fallback 的 zellij/TUI session 是 live surface truth，Claude 原厂 JSONL 是 structured chat truth。
- provider 原厂 jsonl/db/session history 是 backfill/audit truth。
- `client-web` 只消费 `SessionSummary`、`ProviderModelCatalog`、`RahEvent` 和通用 API。
- provider 原生 id 可以作为 `modeId` / `modelId` / `optionValues` 的值存在，但解释权属于 daemon/provider layer。

前端不应该写：

- Codex 的 approval/sandbox 组合规则。
- Claude 的 permission mode 语义。
- OpenCode permission ruleset 写法。
- provider 首条消息发送方式。

这些都属于 provider-owned implementation。

## 2. Provider Runtime Seam

当前 live 主路径由这些能力组成：

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| runtime descriptor | `session-runtime-descriptor.ts` | 声明 runtime kind、live source、TUI role 和 feature status。 |
| native local server runtime | Codex app-server / OpenCode serve client | Codex/OpenCode 的 create/resume/send/interrupt/event 主链路。 |
| TUI mux fallback | `ZellijMuxBackend` / `RuntimeTerminalCoordinator` | Claude 与无 native server provider 的 TUI 工作现场接管、归还、archive。 |
| launch/resume spec | provider runtime/capability layer | 把 RAH 标准 start/resume request 翻译成 provider 启动参数或 server config。 |
| mirror parser | provider 原厂 history/jsonl/db parser | 只读 provider 原始存储，输出 canonical provider activity，用于 backfill/audit。 |
| minimal TUI control | runtime / provider handler | Claude fallback 的 Stop/interrupt、prompt dirty、surface lease，不复刻 provider 私有 live RPC。 |

## 3. Capability Slices

`ProviderAdapter` 本身应保持 identity-only；行为通过显式 capability maps 注册。当前需要理解的能力类型：

- `ProviderStoredHistoryAdapter`：发现和分页 provider 原厂历史。
- `ProviderEnhancedModeAdapter`：可选 mode/plan 增强。
- `ProviderEnhancedModelAdapter`：可选 model/config 增强。
- `ProviderActionCapabilityAdapter`：rename/delete/archive/info 等 action。
- `ProviderDiagnosticAdapter`：CLI/version/launch health。
- `ProviderShutdownAdapter`：daemon shutdown 的 best-effort 清理。
- `ProviderStructuredLifecycleAdapter` / input / permission：legacy structured live test surface。

新增 provider 或重构 provider 时，不能把所有能力重新塞回一个大 adapter。

## 4. Mode 协议

`StartSessionRequest` 和 `ResumeSessionRequest` 可以携带：

```ts
modeId?: string;
```

语义：

- `modeId` 是 provider-owned opaque value。
- UI 只依赖 `SessionModeDescriptor.role` 展示 `ask`、`auto_edit`、`full_auto`、`plan`、`custom`。
- `applyTiming` 描述增强能力的应用时机，不是 core session 生命周期。
- native TUI session 运行中以官方 TUI 为最终事实，RAH 不承诺跨 provider 热切权限/plan 永远可用。

当前 mode 映射只覆盖 Codex、Claude、OpenCode。

## 5. Model / Config 协议

模型选择标准化为“模型 id + 模型声明的 option map”：

```ts
model?: string;
optionValues?: Record<string, SessionConfigValue>;
```

关键规则：

- `optionValues` 的 key 只能来自当前模型可见的 `SessionConfigOption.id`。
- 不把所有 provider 参数强行叫成 `effort`。
- Codex 的 reasoning effort、Claude 的 effort/max、OpenCode 的 variant 都是 provider-owned option。
- 前端可以展示这些 option，但不能推断 provider-native wire shape。
- `reasoningId` 只是兼容字段；新调用应优先使用 `optionValues`。

OpenCode 边界：

- TUI fallback 启动只稳定支持 `--model provider/model`。
- `opencode run --variant` 和 ACP `provider/model/variant` 是已验证路径。
- RAH 不把未公开的 TUI `--variant` 当作稳定启动参数；OpenCode native local server/ACP 路径可声明并使用已验证的 variant 能力。

## 6. Context Usage

上下文余量是标准协议能力，不属于某个 provider 的 UI 补丁。

标准显示：

- Header 显示现有文本形式，例如 `96% context`，语义为剩余上下文。
- hover 显示 token 明细，例如 `Used context: 40K / 1,000,000 tokens · 96% remaining`。
- `precision=estimated` 时 tooltip 使用 estimated 文案。

Provider 状态：

| Provider | Context usage 状态 | 说明 |
| --- | --- | --- |
| Codex | `context_window / exact` | app-server token usage 与 model context window。 |
| Claude | `context_window / estimated` 或 `turn / exact` | SDK usage + known context-window fallback。 |
| OpenCode | `context_window / exact` 或 `estimated` | ACP usage 或 provider catalog context limit。 |

## 7. Actions

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

## 8. ACP 的位置

RAH 不把 ACP 当作替代核心协议。

ACP 可以作为某个 provider 的传输/控制实现，例如 OpenCode ACP。但 RAH 对前端和 runtime 的产品协议仍然是自己的：

- `ProviderAdapter`
- `ProviderModelCatalog`
- `ManagedSession`
- `RahEvent`
- `SessionModeDescriptor`
- `SessionActionCapabilities`

原因：

- ACP 不覆盖 RAH 的 terminal attach、history replay、workspace metadata、canvas/workbench 行为。
- RAH 需要同时管理 PTY live truth 和 structured mirror truth。
- OpenCode ACP 是 provider-specific implementation，不应反向定义整个 RAH 协议。

## 9. 新 Provider 接入检查清单

新增 adapter 或大改 adapter 时，至少检查：

- launch/resume spec 是否能进入 daemon-owned PTY。
- provider session id 是否能稳定绑定。
- stored history 是否能 tail-first paging。
- mirror parser 是否只读 provider 原厂文件/DB。
- mirror failure 是否只进 diagnostics，不影响 PTY session。
- `listModels` 是否准确声明 models/defaultModeId/modes/options。
- `setSessionMode` / `setSessionModel` 是否和启动语义一致；不支持就不要暴露 mutable。
- `actions.rename/delete/archive/info` 是否准确声明。
- context usage 是否正确声明 `basis/precision/source`。
- `livePermissions` 是否只表示 approval response，不混入 mode switching。

## 10. 前端允许保留的 provider 分支

允许：

- Provider logo、颜色、显示名。
- 当前选中的 provider。
- 按 provider 分桶缓存 `ProviderModelCatalog`。
- 按 provider 记住上次选择的模型和参数。
- 按 provider/session id 查找同一个历史 session 或 live projection。

不允许：

- 在 Web UI 中解释 provider-native mode id。
- 在 Web UI 中拼 provider-native CLI 参数。
- 在 Web UI 中写 OpenCode permission ruleset。
- 为某个 provider 特判首条消息发送方式。
