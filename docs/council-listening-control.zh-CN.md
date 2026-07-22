# Council Listening Control Boundary

本文记录 RAH Council 中 `send_prompt / pause listening` 的控制边界。该边界是为了避免把 agent TUI，尤其是 Claude Code，打进不可输入状态。

## 结论

Council agent 的“暂停监听”不是统一的键盘中断。

- Pause 会先建立按 Council/agent 隔离的持久暂停门，再结束当前
  `rah_council.channel_wait_new`。
- 暂停门存在时，agent 即使再次调用 `channel_wait_new`，也只会立即收到
  `paused: true`，不能自行恢复监听。
- Pause 随后通过 provider 控制层结束当前 Council turn，确保 agent 真的回到 idle，
  而不是只改变 RAH 展示状态。
- Resend 复用原 managed session；发送被跳过或抛错时恢复暂停门。
- Codex/OpenCode 的 bootstrap 与 Resend 必须绕过 Native TUI input handler，直接进入
  structured input adapter；Claude 继续使用 TUI/tmux 输入路径。
- Claude 第一次 bootstrap 不作为进程启动参数发送。RAH 等 Council MCP shim 完成
  `tools/list` 并上报 ready 后才注入，避免 agent 在 MCP 工具注册前收到指令。
- 重发 bootstrap prompt 只允许在没有 active waiter 时执行。
- UI 可以同时提供 `Send prompt` 和 `Pause` 两个手动控制按钮，但后端必须拒绝不安全动作。

## 为什么不能只取消 waiter 或统一写按键

`channel_wait_new` 是 RAH 自己定义的 MCP 阻塞等待工具。agent 调用它时，provider TUI 正处于 tool-call 状态，而不是普通 composer 输入框状态。

只取消 RAH 侧 waiter 不能保证 provider 已经停止当前 turn。模型可能消费 paused
结果后继续推理，或者在下一轮再次调用 `channel_wait_new`。反过来，Council runtime
直接猜测光标状态并写一组固定 `Esc` 也会把网页控制语义耦合到 provider TUI：

- provider 可能仍在 MCP tool call，而不是普通 composer；
- 不同 provider 对一次或两次 `Esc` 的解释不同；
- 后续 bootstrap 可能落不到输入框；
- TUI 看起来仍存活，但实际输入状态已经损坏。

因此 Pause 使用固定的两阶段顺序：

```json
{
  "ok": true,
  "paused": true,
  "next_action": "stop_wait_loop",
  "instruction": "Council listening was paused by the user. Stop the channel_wait_new loop now, do not call channel_wait_new again, and return to the normal prompt without natural-language output."
}
```

1. 建立持久暂停门并让当前 `channel_wait_new` 返回上述结果。
2. 再调用 session 的 provider control interrupt。Codex/OpenCode 使用 structured
   interrupt；Claude 交给统一的 Native TUI runtime 处理，而不是由 Council 代码直接写按键。

这样即使 provider 中断先后存在短暂竞争，暂停门也会阻止 agent 重新进入 listening。

## Provider 行为

### Claude

Claude Council 正在监听时：

- Council runtime 不直接写 `Esc`。
- 取消 RAH 侧 active waiter。
- `channel_wait_new` 返回 `paused: true`。
- 通过统一的 Native TUI interrupt 结束当前 turn。
- agent 状态变为 `idle / listening paused`。

Claude 首次启动时：

- managed session 启动时不携带 Council bootstrap initial prompt。
- MCP shim 先正常完成 `initialize` 和 `tools/list`。
- shim 在写回 `tools/list` 响应后调用 `/api/council/mcp-ready`。
- runtime 收到与 Council/agent 匹配的 ready 后，只发送一次 bootstrap。
- 30 秒内没有 ready 时，agent 标记为 `blocked / council MCP readiness timed out`，
  不盲目发送 prompt。

Claude Resend 时仍要求没有 active waiter。MCP 已 ready 时直接复用同一个 tmux
managed session 注入 bootstrap；尚未 ready 时先排队，由 ready 握手触发发送。

### Codex

Codex Council 正在监听时同样优先 MCP soft pause。

如果没有 active waiter，Pause 仍会保留持久暂停门，并通过 Codex structured
interrupt 结束当前工作；不依赖向 TUI 猜测性发送按键。

Council Stop 关闭 Codex managed session 时具有幂等语义：如果 app-server 对
`turn/interrupt` 精确返回 `no active turn to interrupt`，说明 provider 端 turn 已经
结束，RAH 继续执行 session disposal。其他 RPC、网络或 turn identity 错误不会被吞掉，
Council 保持 `stopping`，允许用户重试。

### OpenCode

OpenCode 与其他 provider 使用同一持久暂停门：

- active waiter 由 MCP soft pause 正常返回；
- agent 再次调用 `channel_wait_new` 仍会收到 paused 响应；
- 没有 active waiter 但仍在执行时，通过 OpenCode structured interrupt 停止当前 run；
- 不发送双 `Esc`，避免把网页控制语义重新耦合到 TUI 光标状态。

## UI 控制按钮

Council UI 可以展示三个明确动作：

- `Resend`：向该 agent 的原 managed session 重新注入 Council bootstrap prompt。
- `Pause`：暂停该 agent 的 Council listening loop。
- `Disconnect`：关闭并解绑该 agent 的 managed session，不影响其他 agent。

这些按钮不是只修改 UI 状态。后端保留二次保护：

- `writeCouncilBootstrapPrompt()` 会检查 `hasActiveCouncilWaiter()`。
- 如果 agent 仍在 `channel_wait_new`，prompt 重发会被跳过。
- Disconnect 只有在 managed session 确认关闭后才清除 session binding。
- 最后一个 agent Disconnect 后，Council 转为 stopped。

因此 UI 状态判断即使短暂滞后，也不会把第二份 bootstrap prompt 塞进正在监听的 agent。

## Mention 输入规则

Council composer 支持 `@` mention，用于把消息明确指向某个 agent 或全体 agent。

- `@all` 是唯一的全体广播目标，表示所有 agent 都应参与当前讨论。
- 具体 agent 使用 `@<agent name>`，agent name 来自 council 中展示的唯一 agent 名称。
- 可以在同一条消息里多次 mention，例如 `@all 先看问题。 @GPT-5.5-XHigh 重点检查实现。`
- `@` 菜单只在行首、文本开头或空白/括号/引号之后触发。
- 普通正文内部的 `@` 不触发菜单，例如邮箱、代码片段、`foo@bar`、`正文@gpt`。
- 这是刻意的保守策略：宁可要求用户在 mention 前加空格或换行，也不要在普通文字里误弹菜单。
- `@council` 不作为公开目标；它和 `@all` 语义重复，统一用 `@all` 表达全体讨论。

## 与普通 Session Stop 的区别

Council listening pause 只处理 Council MCP 等待循环。

它不等价于：

- provider 原生 turn cancel
- shell/tool execution cancel
- council archive
- 终止 agent 进程

普通 session 的 Stop 仍按 provider 能力处理：

- Codex / OpenCode：优先 provider native local-server cancel / interrupt。
- Claude tmux：只能作为 TUI interrupt/escape 动作处理，不能承诺精确 turn lifecycle。

## 不变量

- RAH 不用定时器猜 agent 是否“离开监听”并自动补发 prompt。
- active `channel_wait_new` 是判断 Council listening 的权威 runtime fact。
- persistent pause gate 是判断 agent 是否允许重新进入监听的权威 runtime fact。
- Pause 必须先建立暂停门并结束 waiter，再调用 provider interrupt。
- Resend 不应在 active listener 存在时执行；发送跳过或失败时必须恢复暂停门。
- Archive / Stop council 才负责结束 PTY 和 agent 进程。
- Disconnect 只结束目标 agent，不得影响其他 managed session。
- Council Stop 必须完成所有 managed session 的关闭后才提交 `ended`；失败时保留
  session binding 和 `stopping` 状态供重试。

## 测试要求

相关行为必须由 runtime 单测覆盖：

- active Claude waiter pause 返回 `paused: true`，并调用统一 provider interrupt。
- Claude 启动时 initial prompt 为空；`tools/list` readiness 前不发送 bootstrap。
- Claude readiness 上报后恰好发送一次 bootstrap；Resend 复用同一个 managed session。
- active OpenCode waiter pause 不写 raw TUI escape，并返回 `paused: true`。
- paused agent 再次调用 `channel_wait_new` 仍然保持 paused。
- Resend 成功后允许重新进入监听；Resend 跳过或抛错时保持 paused。
- pause 不关闭 agent session，后续仍可重新注入 bootstrap prompt。
- Disconnect 关闭目标 agent 后，其他 agent 仍保持原 session 和 listening 状态。
- Codex `no active turn to interrupt` 关闭响应按幂等成功处理。
- managed session 关闭失败时 Council Stop 可重试，不能提前清除 binding 或提交 ended。
