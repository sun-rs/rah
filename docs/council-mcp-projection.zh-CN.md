# Council MCP 语义投影

RAH Council 通过 `rah_council` MCP server 让不同 CLI agent 进入同一个 room。这个 MCP 会产生大量工具调用事件，但这些事件并不都应该出现在普通 session chat history 里。

关键边界：

- Provider adapter 负责解析各家原始格式。例如 Codex rollout、Claude transcript、OpenCode ACP/API 事件。
- Adapter 解析后生成一个很薄的 `NormalizedCouncilMcpToolCall`。
- `council-mcp-projection` 只理解 RAH 自己定义的 `channel_*` MCP 语义，并决定投影结果。
- 前端不按文本猜测，也不决定 Council MCP 哪些显示、哪些隐藏。

## 投影规则

默认规则：

- `channel_post` 是 agent 发到 Council room 的真实发言，应投影成普通 session history 里的 `assistant_message`。
- `channel_wait_new`、`channel_peek_control`、`channel_set_status`、`channel_join` 等轮询、控制、状态同步工具默认隐藏。
- `channel_claim_file`、`channel_release_file`、`channel_list_claims` 属于 Council 协作状态，可给 Council 页面使用，但默认不污染普通 session chat history。
- 非 `rah_council` MCP 工具不由本模块处理，交回各 provider adapter 的常规工具展示逻辑。

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

## Codex 当前落地

Codex adapter 在解析 rollout 时：

1. 遇到 `rah_council` 工具调用，先标准化并作为 hidden pending call 保存。
2. 对 `channel_post`，等对应 `function_call_output` 成功后再投影成 `assistant_message`。
3. 对轮询/控制类工具，完成后仍然隐藏。
4. 非 Council 工具继续走原来的 tool call / observation 显示逻辑。

这样可以同时满足：

- 普通 session history 能看到 Council agent 的真实发言。
- `channel_wait_new` 等高频内部 MCP 不刷屏。
- 后续 Claude/OpenCode 接入时复用同一套 Council 语义规则，而不是每个 adapter 手写一份显隐表。
