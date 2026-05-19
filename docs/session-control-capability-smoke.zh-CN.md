# Session Control 能力真实回归测试

本文件记录 `session control` 的真实 provider 验证边界。它用于回答一个具体问题：

> Web UI 里选了 model / effort / session mode / permission preset / agent 后，provider 真实 turn 到底有没有按这些配置执行？

本测试不再把三家 provider 强行套进同一个 `plan mode` 概念。它按 provider 原生语义验证：

- Codex: `Plan` 是独立 collaboration mode，权限是 `Default / Auto Review / Full Access` preset。
- Claude: `plan` 是 `--permission-mode` 的一个互斥值，和 `default / acceptEdits / bypassPermissions` 同级。
- OpenCode: agent 列表来自 provider 当前暴露的 `availableModes`；`build / plan` 只是常见值，不写死为测试前提。

## 当前状态

截至 2026-05-12，本测试脚本覆盖：

- Codex `model + effort` 真实进入 rollout `turn_context`。
- Codex `Plan on/off` 真实进入 rollout `collaboration_mode`。
- Codex `Auto Review / Default / Full Access` 权限 preset 通过 rollout `turn_context` 和真实跨 workspace 写文件行为验证。
- Claude `plan / acceptEdits / bypassPermissions` 通过真实 `--permission-mode` 启动和临时文件写入/不写入行为验证。
- OpenCode `model + variant` 真实进入 message API 的 `providerID / modelID / variant`。
- OpenCode 动态选择当前暴露的 agent，真实进入 message API 的 `mode / agent`。

## 命令

```bash
npm run test:smoke:session-control-capabilities
```

只跑单家 provider：

```bash
npm run test:smoke:session-control-capabilities -- --provider codex
npm run test:smoke:session-control-capabilities -- --provider claude
npm run test:smoke:session-control-capabilities -- --provider opencode
```

保留测试 session 便于人工检查：

```bash
npm run test:smoke:session-control-capabilities -- --keep-sessions
```

## 测试性质

这是显式 opt-in 的真实 provider E2E，不属于 `test:runtime` 或 `test:web`：

- 会启动真实 Codex / Claude / OpenCode session。
- 会真实发送 prompt。
- 权限行为 probe 会在系统临时目录创建隔离 workspace，并在测试后移入系统废纸篓/回收站；自清理不得直接 `rm -rf`，也不得扫描 provider 历史内容来删除 session 文件。
- 会消耗 provider 额度、API key 或订阅配额。
- 需要本机 RAH daemon 正在运行，默认地址是 `http://127.0.0.1:43111`。
- 默认 prompt 是一个四元整数分式分类证明题，不使用简单寒暄问题，目的是让 effort/variant 差异更容易暴露。

可用环境变量：

```bash
RAH_BASE_URL=http://127.0.0.1:43111
RAH_PROBE_WORKSPACE=/Users/sun/Code/repos/rah
RAH_CODEX_PROBE_MODEL=gpt-5.5
RAH_CODEX_PROBE_LOW_EFFORT=low
RAH_CODEX_PROBE_HIGH_EFFORT=xhigh
RAH_CLAUDE_PROBE_MODEL=opus
RAH_OPENCODE_PROBE_GROK_MODEL=aihubmix/grok-4.3
RAH_OPENCODE_PROBE_DEEPSEEK=1
RAH_OPENCODE_PROBE_DEEPSEEK_MODEL=deepseek/deepseek-v4-pro
RAH_SESSION_CONTROL_SKIP_MODEL_EFFORT_PROBES=1
RAH_SESSION_CONTROL_SKIP_PERMISSION_PROBES=1
RAH_SESSION_CONTROL_PERMISSION_TIMEOUT_MS=180000
RAH_SESSION_CONTROL_REQUIRE_TOKEN_ORDER=1
RAH_SESSION_CONTROL_TOKEN_TRIALS=1
RAH_SESSION_CONTROL_TOKEN_MIN_RATIO=1
```

测试会记录 high / low 的 reasoning token 差异，但默认不把它作为硬断言。原因是 provider metadata 已能确认 `effort/variant` 生效，而实际 reasoning token 仍受题目、缓存、采样和 provider 调度影响，不能保证单次 high 都严格大于 low。

如果需要临时把 token 差异升级成强断言：

```bash
RAH_SESSION_CONTROL_REQUIRE_TOKEN_ORDER=1 npm run test:smoke:session-control-capabilities
```

也可以直接使用固定入口：

```bash
npm run test:smoke:session-control-token-order
```

打开该模式时，默认跑 1 组硬数学题的 paired 验证：同一组题分别跑 low / high，再比较 reasoning token。可以通过 `RAH_SESSION_CONTROL_TOKEN_TRIALS` 升级为多组 aggregate 验证，通过 `RAH_SESSION_CONTROL_TOKEN_MIN_RATIO` 设置最低 high/low 比值。

这不会影响 provider 原生 metadata 的 model / effort / plan 断言。

只验证权限 / Plan / Agent，不跑 model + effort 数学题：

```bash
RAH_SESSION_CONTROL_SKIP_MODEL_EFFORT_PROBES=1 npm run test:smoke:session-control-capabilities
```

## Codex 证据

测试通过 RAH API 启动 `native_local_server` Codex session，然后通过运行中 session control API：

```text
POST /api/sessions/:id/model
POST /api/sessions/:id/mode
```

设置：

- `model`
- `optionValues.model_reasoning_effort`
- `plan:<accessPreset>` / 非 plan mode
- `modeId` 权限 preset

权威证据来自 Codex rollout JSONL：

- `turn_context.payload.model`
- `turn_context.payload.effort`
- `turn_context.payload.collaboration_mode.mode`
- `turn_context.payload.approval_policy`
- `turn_context.payload.sandbox_policy.type`
- `turn_context.payload.approvals_reviewer`
- `event_msg.token_count.info.last_token_usage.reasoning_output_tokens`

脚本不会把 Codex mode id 写死为固定字符串，而是先读取 provider catalog/session `availableModes`，再按 `role=ask / auto_edit / full_auto` 找到当前版本暴露的 mode id。

测试会断言：

- low turn 的 `turn_context.effort` 是 low。
- high/xhigh turn 的 `turn_context.effort` 是 high/xhigh。
- plan on turn 的 `collaboration_mode.mode` 是 `plan`。
- plan off turn 的 `collaboration_mode.mode` 不是 `plan`。
- `Auto Review` turn 的 `approval_policy=on-request`、`sandbox_mode=workspace-write`、`approvals_reviewer=auto_review`。
- `Default` 对 workspace 外部路径写入必须触发 approval/block，不能静默写入。
- `Full Access` 对 workspace 外部路径写入必须成功落盘，证明 bypass/sandbox 参数真实生效。
- high/xhigh 的 `reasoning_output_tokens` 会被记录为诊断证据；只有设置 `RAH_SESSION_CONTROL_REQUIRE_TOKEN_ORDER=1` 时才作为聚合通过条件。

注意：Codex `Default` 的准确语义是 `on-request + workspace-write`，它允许 workspace 内写入，但 workspace 外写入必须请求 approval。本测试验证的是这个边界，不把 `Default` 误解成全局只读。

## Claude 证据

测试通过 RAH API 启动 `tui_mux` Claude session，在启动前传入 `modeId`：

```text
default
acceptEdits
plan
bypassPermissions
```

Claude 的 `Plan` 不是独立 toggle，而是 `--permission-mode plan`。因此测试只在启动前验证，不测试运行中热切。
脚本不会硬编码这些字符串作为唯一事实，而是先读取 provider catalog/session `availableModes`，再按 `role=plan / auto_edit / full_auto` 选取当前版本真实暴露的 mode id。

权威证据由两部分组成：

- RAH session summary 中的 `mode.currentModeId`。
- 隔离临时 workspace 中的真实文件写入结果，以及 Claude transcript JSONL 中的 marker/tool/assistant 记录。

默认覆盖：

- `plan`: 要求不创建文件，证明该模式不会执行编辑。
- `acceptEdits`: 要求创建文件，证明文件编辑被接受。
- `bypassPermissions`: 要求创建文件，证明绕过权限提示生效。

`default` 的行为更依赖 Claude 当前版本和本地权限配置，自动化 probe 暂不把它设为硬断言；需要人工或扩展 probe 时可以按同一机制追加。

## OpenCode 证据

测试通过 RAH API 启动 `native_local_server` OpenCode session，然后通过运行中 session control API 设置：

- `model`
- `optionValues.model_reasoning_variant`
- `modeId=<agent id>`，这里表示 OpenCode agent。

权威证据来自 OpenCode server 的 message API：

```text
GET <serverEndpoint>/session/<providerSessionId>/message
```

测试会断言 assistant message 的：

- `info.providerID`
- `info.modelID`
- `info.variant`
- `info.mode`
- `info.agent`
- `info.tokens.reasoning`

默认覆盖：

- `aihubmix/grok-4.3`: low vs high
- 从当前 OpenCode catalog/session `availableModes` 中选择最多两个 agent。
- 优先选一个 plan/planner/planning-like agent；如果没有，就选择当前暴露的前两个 agent。

DeepSeek 不再默认覆盖。需要额外验证时显式设置：

```bash
RAH_OPENCODE_PROBE_DEEPSEEK=1 npm run test:smoke:session-control-capabilities -- --provider opencode
```

`info.tokens.reasoning` 会被记录为诊断证据；只有设置 `RAH_SESSION_CONTROL_REQUIRE_TOKEN_ORDER=1` 时才作为聚合通过条件。

## 为什么不用模型自报

模型回答里的 “exact model id” 只能作为辅助信息，不作为判定依据。

Codex 之前出现过模型自报 `GPT-5`，但 rollout JSONL 的 `turn_context.model` 明确是 `gpt-5.5`。因此本测试只信 provider 原生 metadata / usage 记录。

## 通过标准

测试通过表示：

- RAH session control 的 model / effort / provider-native mode 参数链路没有断。
- Codex / Claude / OpenCode 的真实 provider 记录或文件系统行为确认了这些参数。
- reasoning token 诊断会被输出；如设置 `RAH_SESSION_CONTROL_REQUIRE_TOKEN_ORDER=1`，才会强制要求 high 大于 low。

测试不表示：

- Claude tmux fallback 支持运行中 model/effort/permission 切换。
- OpenCode 有普通用户级 permission mode 菜单；当前 OpenCode 验证的是 agent。
- 所有模型的每一种 provider-specific option 都有语义差异。
