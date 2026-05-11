# Session Control 能力真实回归测试

本文件记录 `session control` 的真实 provider 验证边界。它用于回答一个具体问题：

> Web UI 里选了 model / effort / plan mode 后，provider 真实 turn 到底有没有按这些配置执行？

权限模式暂不纳入本测试。权限语义在不同 provider 之间差异较大，需要单独定义。

## 命令

```bash
npm run test:smoke:session-control-capabilities
```

只跑单家 provider：

```bash
npm run test:smoke:session-control-capabilities -- --provider codex
npm run test:smoke:session-control-capabilities -- --provider opencode
```

保留测试 session 便于人工检查：

```bash
npm run test:smoke:session-control-capabilities -- --keep-sessions
```

## 测试性质

这是显式 opt-in 的真实 provider E2E，不属于 `test:runtime` 或 `test:web`：

- 会启动真实 Codex / OpenCode session。
- 会真实发送 prompt。
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
RAH_OPENCODE_PROBE_GROK_MODEL=aihubmix/grok-4.3
RAH_OPENCODE_PROBE_DEEPSEEK=1
RAH_OPENCODE_PROBE_DEEPSEEK_MODEL=deepseek/deepseek-v4-pro
RAH_SESSION_CONTROL_REQUIRE_TOKEN_ORDER=1
RAH_SESSION_CONTROL_TOKEN_TRIALS=1
RAH_SESSION_CONTROL_TOKEN_MIN_RATIO=1
```

测试会记录 high / low 的 reasoning token 差异，但默认不把它作为硬断言。原因是 provider metadata 已能确认 `effort/variant` 生效，而实际 reasoning token 仍受题目、缓存、采样和 provider 调度影响，不能保证单次 high 都严格大于 low。

如果需要临时把 token 差异升级成强断言：

```bash
RAH_SESSION_CONTROL_REQUIRE_TOKEN_ORDER=1 npm run test:smoke:session-control-capabilities
```

打开该模式时，默认跑 1 组硬数学题的 paired 验证：同一组题分别跑 low / high，再比较 reasoning token。可以通过 `RAH_SESSION_CONTROL_TOKEN_TRIALS` 升级为多组 aggregate 验证，通过 `RAH_SESSION_CONTROL_TOKEN_MIN_RATIO` 设置最低 high/low 比值。

这不会影响 provider 原生 metadata 的 model / effort / plan 断言。

## Codex 证据

测试通过 RAH API 启动 `native_local_server` Codex session，然后通过运行中 session control API：

```text
POST /api/sessions/:id/model
POST /api/sessions/:id/mode
```

设置：

- `model`
- `optionValues.model_reasoning_effort`
- `plan` / 非 plan mode
- `plan` / 非 plan mode

权威证据来自 Codex rollout JSONL：

- `turn_context.payload.model`
- `turn_context.payload.effort`
- `turn_context.payload.collaboration_mode.mode`
- `event_msg.token_count.info.last_token_usage.reasoning_output_tokens`

测试会断言：

- low turn 的 `turn_context.effort` 是 low。
- high/xhigh turn 的 `turn_context.effort` 是 high/xhigh。
- plan on turn 的 `collaboration_mode.mode` 是 `plan`。
- plan off turn 的 `collaboration_mode.mode` 不是 `plan`。
- high/xhigh 的 `reasoning_output_tokens` 会被记录为诊断证据；只有设置 `RAH_SESSION_CONTROL_REQUIRE_TOKEN_ORDER=1` 时才作为聚合通过条件。

## OpenCode 证据

测试通过 RAH API 启动 `native_local_server` OpenCode session，然后通过运行中 session control API 设置：

- `model`
- `optionValues.model_reasoning_variant`
- `plan` / `build`

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
- plan on / off

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

- RAH session control 的 model / effort / plan 参数链路没有断。
- Codex / OpenCode 的真实 provider 记录确认了这些参数。
- reasoning token 诊断会被输出；如设置 `RAH_SESSION_CONTROL_REQUIRE_TOKEN_ORDER=1`，才会强制要求 high 大于 low。

测试不表示：

- 权限模式正确。
- Claude zellij fallback 支持运行中 model/effort 切换。
- 所有模型的每一种 provider-specific option 都有语义差异。
