# Council MCP Session Projection

RAH Council 通过 `rah_council` MCP server 让不同 CLI agent 进入同一个 council。这个 MCP 会产生大量工具调用事件，但普通 provider session 单独浏览时，用户真正关心的是“这个 agent 在 Council 里说了什么”，而不是 `channel_wait_new`、`channel_set_status` 这类内部同步工具。

因此 RAH 有一个从 Council 功能衍生出来的 session projection 模块：它负责把 provider session 里的 Council MCP 调用包装、解析、过滤并投影成普通 chat history 可以理解的 timeline item。

这不是 Council 页面本身的消息源，也不是前端显示层的补丁。它是 runtime-daemon 的 adapter 侧语义层，目标是让一个 Council agent 的原始 CLI session 被单独打开时，仍然能像正常对话一样阅读。

关键边界：

- Provider adapter 负责解析各家原始格式。例如 Codex rollout、Claude transcript、OpenCode ACP/API 事件。
- Adapter 解析后生成一个薄的 `NormalizedCouncilMcpToolCall`。
- `council-mcp-projection` 只理解 RAH 自己定义的 `channel_*` MCP 语义，并决定投影结果。
- Adapter 负责把投影结果补回 provider 上下文，例如 `runtimeModel`、canonical identity、turn 归属、分页窗口上下文。
- 前端不按文本猜测，也不决定 Council MCP 哪些显示、哪些隐藏。

## 为什么需要这个模块

没有这一层时，Council agent 的 provider session 会出现三类问题：

- 内部 MCP 轮询刷屏：`channel_wait_new`、`channel_peek_control` 等工具会大量出现，污染普通 session history。
- 真实发言不可读：agent 通过 `channel_post` 发出的 Council 回复会被当成工具输出，而不是普通 assistant message。
- 模型信息丢失：`channel_post` 自身通常不携带模型 metadata，如果不从 provider 原始上下文继承，session 气泡上会退化成 provider 名称或空白。

这个模块的设计目标是：

- 单独浏览 Council agent session 时，`channel_post` 显示为正常回答。
- 高频内部 MCP 调用默认隐藏。
- model/effort/variant 等 runtime metadata 只从当前 provider session 内可靠来源继承，不跨 council、跨文件或跨 session 猜测。
- live replay、stored history、分页 tail loading 的输出语义保持一致。

## 投影规则

默认规则：

- `channel_post` 是 agent 发到 Council 的真实发言，应投影成普通 session history 里的 `assistant_message`。
- `channel_wait_new`、`channel_peek_control`、`channel_set_status`、`channel_join` 等轮询、控制、状态同步工具默认隐藏。
- `channel_claim_file`、`channel_release_file`、`channel_list_claims` 属于 Council 协作状态，可给 Council 页面使用，但默认不污染普通 session chat history。
- 非 `rah_council` MCP 工具不由本模块处理，交回各 provider adapter 的常规工具展示逻辑。

投影只在工具调用成功且内容非空时发生：

- started/pending 的 `channel_post` 不显示。
- failed 的 `channel_post` 不显示。
- output 表示 `ok: false` 或包含 `error` 时不显示。
- `args.content` 优先作为回答文本，兼容 `args.text`。

## 为什么不是 raw 格式复用

各家 CLI 的消息格式不一样，不能在 raw event 层强行复用：

- Codex stored history 主要来自 rollout JSONL 的 `response_item/function_call/function_call_output`。
- Claude 和 OpenCode 可能来自各自的 transcript、ACP/API 或其它事件模型。

因此共享层只接收标准化后的 MCP 调用：

```ts
type NormalizedCouncilMcpToolCall = {
  provider: ProviderKind;
  providerSessionId?: string;
  callId: string;
  toolName: string;
  args?: Record<string, unknown>;
  status: "started" | "completed" | "failed";
  output?: unknown;
};
```

这个边界避免把 provider 私有解析和 RAH Council 语义混在一起。

## Adapter 接入方式

每个 provider adapter 都应该按相同顺序接入：

1. 在 provider 原始事件中识别 `rah_council` MCP 工具名。
2. 使用 `normalizeCouncilMcpToolCall()` 生成 `NormalizedCouncilMcpToolCall`。
3. 使用 `projectCouncilMcpToolCall()` 决定隐藏或投影。
4. 如果投影成 `assistant_message`，adapter 再把 provider 自己掌握的上下文补上去。
5. 输出到统一 timeline，交给 history/live projection 和前端渲染。

共享模块只负责 Council MCP 语义，不负责解析 provider 文件格式。

### Codex

Codex adapter 在解析 rollout 时：

1. 遇到 `rah_council` 工具调用，先标准化并作为 hidden pending call 保存。
2. 对 `channel_post`，等对应 `function_call_output` 成功后再投影成 `assistant_message`。
3. 对轮询/控制类工具，完成后仍然隐藏。
4. 非 Council 工具继续走原来的 tool call / observation 显示逻辑。
5. `runtimeModel` 从当前 turn/response 的 native metadata 继承，例如 model id 和 reasoning effort。

这样可以同时满足：

- 普通 session history 能看到 Council agent 的真实发言。
- `channel_wait_new` 等高频内部 MCP 不刷屏。
- 分页窗口中 `function_call` 和 `function_call_output` 分开出现时，frozen loader 仍要保留足够上下文，把 `channel_post` 和之前的 model metadata 拼回同一个可读回答。

### Claude

Claude transcript 中 `tool_use` 和 `tool_result` 可能分开出现。Claude adapter 的职责是：

- 在 assistant record 中看到 `tool_use` 时记录 pending call。
- 同时保存该 assistant record 上的 native `message.model`。
- 等后续 `tool_result` 成功返回后，调用 Council projection。
- 如果投影成 `assistant_message`，把 pending call 保存的 `runtimeModel` 补回气泡。

Claude 的 `channel_post` 本身不应被当成普通 tool result 直接展示。

### OpenCode

OpenCode 的事件和 DB 历史以 message/part 为核心。OpenCode adapter 的职责是：

- 从 message metadata 建立 `messageId -> runtimeModel` 映射。
- 在 MCP tool part 上识别 `rah_council_*` 工具名。
- 对成功的 `rah_council_channel_post` 投影为 `assistant_message`。
- 使用该 part 所属 message 的 runtime model 补回气泡。
- 隐藏 polling/status/control 类 Council MCP 工具。

OpenCode 的 reasoning、step、tool part 仍走 OpenCode adapter 原有逻辑；Council projection 只处理 RAH Council MCP 的语义。

### Gemini

Gemini CLI 的 Council 接入走 `tui_mux`，启动时 RAH 通过临时 `GEMINI_CLI_SYSTEM_SETTINGS_PATH` 注入 `rah_council` MCP server，避免改写用户 `~/.gemini/settings.json`，也不隔离用户登录态和原生 history。这个临时 system settings 会保留已有 Gemini system settings，并为 Council MCP session 写入 `model.disableLoopDetection=true`；原因是 Council agent 会长期重复调用 `channel_wait_new`，Gemini CLI 的通用 loop detector 会把这种监听循环误判为潜在循环并弹出交互确认，阻断 MCP listen。

Gemini CLI 的 MCP 工具全名是 `mcp_<server>_<tool>`，因此 `rah_council.channel_post` 在 Gemini session 文件中表现为：

```text
mcp_rah_council_channel_post
```

Gemini adapter 的职责是：

- 在 `toolCalls` 上识别 `mcp_rah_council_*` 工具名。
- 隐藏 `channel_wait_new`、`channel_set_status`、`channel_peek_control` 等轮询/状态工具。
- 对成功的 `mcp_rah_council_channel_post` 投影为 `assistant_message`。
- 使用该 Gemini message 自带的 native `model` metadata 补回气泡。

Gemini 没有 native local server；Council 与普通 live session 一样使用 tmux/TUI mux + 原生 JSON session history mirror。

## Model Resolver 边界

Council `channel_post` 通常没有直接的 model metadata。当前规则是：

- 只从同一个 provider session 内已经出现的 native metadata 继承。
- Codex 使用当前 turn/response 已解析出的 runtime model。
- Claude 使用发起 tool_use 的 assistant message model。
- OpenCode 使用 tool part 所属 message 的 runtime model。
- 如果找不到可靠 model metadata，不跨 Council、`councils.json` 或其它 session 文件补猜。

这个边界很重要：用户可能在普通 CLI session 中切换模型；只有 provider session 自身的 native metadata 才能证明某条回答使用了哪个模型。Council 里的 agent 配置只能作为启动意图，不能反向覆盖 provider history。

## History Paging 边界

历史浏览是 tail-first + 向上分页。Council MCP projection 必须满足：

- 分页不能把 tool call 上下文切断后丢失 `channel_post`。
- 如果 `tool_use` 在上一页、`tool_result` 在当前页，loader 应保留上下文窗口完成投影。
- projection 后的 `assistant_message` 仍应进入普通 history timeline，而不是只在 Council history 里可见。
- 不允许为了补 model 信息去跨 session 读外部状态。

目前 Codex 和 Claude 已有跨 page window 的回归测试；OpenCode 使用 message/part metadata 绑定 model，重点测试 live/history projection 与 tool 隐藏。

## 测试要求

修改本模块或任一 provider 的 Council MCP 解析时，至少补/跑以下测试：

- `packages/runtime-daemon/src/codex-rollout-activity.test.ts`
- `packages/runtime-daemon/src/codex-stored-sessions.test.ts`
- `packages/runtime-daemon/src/claude-session-files.test.ts`
- `packages/runtime-daemon/src/opencode-activity.test.ts`
- `packages/runtime-daemon/src/opencode-stored-sessions.test.ts`

最低必须覆盖：

- `channel_post` 成功时显示为 `assistant_message`。
- polling/status/control 工具隐藏。
- failed/empty post 不显示。
- model metadata 能继承时必须出现在投影后的 item 上。
- 无可靠 model metadata 时不得伪造。
- stored history 分页不破坏 projection。

## 代码位置

- 共享语义层：`packages/runtime-daemon/src/council/council-mcp-projection.ts`
- Codex rollout/history：`packages/runtime-daemon/src/codex-rollout-activity.ts`
- Claude transcript/history：`packages/runtime-daemon/src/claude-session-files.ts`
- OpenCode live/history：`packages/runtime-daemon/src/opencode-activity.ts`
