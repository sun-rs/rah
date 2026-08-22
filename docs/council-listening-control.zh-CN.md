# Council Delivery and Listening Control Boundary

本文记录 RAH Council 的 daemon 订阅、直接唤醒、短时热监听与 pause/recovery 控制边界。目标是在不复制聊天室全文、不永久占用模型 turn 的前提下，让新消息以一次投递直接到达 agent。

## 结论

Council 的成员关系与消息投递由 daemon 持有，模型不再通过 bootstrap 自行建立成员关系。

- managed session 启动后，daemon 立即登记 Council/agent/session 订阅；Codex/OpenCode 直接进入 `sleeping · subscribed`，Claude 等 MCP `tools/list` ready 后进入同一状态。
- 新消息优先命中仍阻塞在 `channel_wait_new` 的热 waiter；没有热 waiter 时，daemon 在 120ms 窗口内合并消息，把 canonical 原文批次直接作为带稳定 input identity 的新 turn 注入原 managed session。
- daemon 不发送“有新消息，请再读 inbox”的通知；wake prompt 已包含完整消息，因此没有 Raft 式 notice→read 两段延迟。
- agent 完成本批工作后只进行一次短时 `channel_wait_new`。timeout 返回 `sleeping: true / next_action: end_turn`，模型结束 turn，但 daemon 订阅和 provider session 保持温热。
- agent 忙碌或上一 wake 尚未完成时，新消息只进入该 agent 的 daemon 队列；收到精确 `session.input.accepted` 才推进 delivery cursor，收到 turn terminal event 后再合并唤醒下一批。
- 明确的 `@<agent name>` 由 daemon 确定性缩小投递范围；`@all` 与无已知 mention 的普通消息保持广播语义。
- Pause 会先建立按 Council/agent 隔离的持久暂停门，再结束当前
  `rah_council.channel_wait_new`。
- 暂停门存在时，agent 即使再次调用 `channel_wait_new`，也只会立即收到
  `paused: true`，不能自行恢复监听。
- Pause 随后通过 provider 控制层结束当前 Council turn，确保 agent 真的回到 idle，
  而不是只改变 RAH 展示状态。
- Recovery wake 复用原 managed session，只允许在没有 active waiter 和 active wake 时执行。Codex/OpenCode 直接进入 structured input adapter；Claude 继续使用 TUI/tmux 输入路径。
- UI 可以提供 `Wake/Recover`、`Pause` 和 `Disconnect`，但正常消息不依赖人工 Wake。

## 状态机

daemon 对每个 Council agent 只维护一份 delivery 状态：

```text
starting/waiting MCP
        │ ready
        ▼
sleeping · subscribed ──message──► waking ──accepted──► working
        ▲                                │                │
        │                                │ busy messages  │ channel_wait_new
        │                                ▼                ▼
        └──── timeout/end turn ◄──── queued ◄──── hot · listening
```

- `hot · listening`：provider turn 正阻塞在 MCP waiter，新消息由 waiter 直接返回，延迟最低。
- `sleeping · subscribed`：没有模型 turn，但 session 与 daemon 订阅都存在；下一条消息直接 wake。
- `waking`：完整消息批次已交给 canonical session input queue，等待同一 `clientMessageId` 的 acceptance。
- `working · N queued`：agent 正在处理，后续消息在 daemon 合并，不并发注入第二个 turn。
- `listening paused`：用户暂停了该 agent；消息可以保留为 pending，但不会自动 wake，直到显式恢复。

生命周期状态行只用于 Web 投影，不能进入 `channel_wait_new` / `channel_peek_inbox` 的 agent 输入。共享 Council JSONL 仍是对话权威日志；delivery coordinator 是瞬时调度 owner，不创建第二份 transcript。

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

普通热等待 timeout 与 Pause 不同。timeout 不 interrupt provider，而是要求当前模型 turn 自然结束：

```json
{
  "ok": true,
  "timed_out": true,
  "sleeping": true,
  "next_action": "end_turn"
}
```

daemon 订阅不会随 turn 结束；新消息到达时由 delivery coordinator 直接构造下一次 wake。禁止把 timeout 重新解释为 heartbeat 并无限再次调用 `channel_wait_new`。

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
- runtime 在 start 前建立 readiness race barrier；ready 即使早于 session start response 也不会丢失。
- ready 只把 agent 转为 `sleeping · subscribed`，不消耗模型 turn。ready 之前到达的消息留在 daemon 队列，ready 后作为一个完整批次直接 wake。

Claude Recovery wake 仍要求 MCP ready、没有 active waiter 且没有 active wake；它复用同一个 tmux managed session，不 interrupt TUI。

### Codex

Codex Council 正在监听时同样优先 MCP soft pause。

Codex managed session 启动后不发送 join/bootstrap turn，直接登记 daemon 订阅。首次用户消息通过 structured input queue 唤醒；wake 也必须携带稳定 `clientMessageId/clientTurnId`。

如果没有 active waiter，Pause 仍会保留持久暂停门，并通过 Codex structured
interrupt 结束当前工作；不依赖向 TUI 猜测性发送按键。

Council Stop 关闭 Codex managed session 时具有幂等语义：如果 app-server 对
`turn/interrupt` 精确返回 `no active turn to interrupt`，说明 provider 端 turn 已经
结束，RAH 继续执行 session disposal。其他 RPC、网络或 turn identity 错误不会被吞掉，
Council 保持 `stopping`，允许用户重试。

### OpenCode

OpenCode 与其他 provider 使用同一持久暂停门：

- 启动后不发送 join/bootstrap turn，首次消息与 Codex 一样直接 structured wake；
- active waiter 由 MCP soft pause 正常返回；
- agent 再次调用 `channel_wait_new` 仍会收到 paused 响应；
- 没有 active waiter 但仍在执行时，通过 OpenCode structured interrupt 停止当前 run；
- 不发送双 `Esc`，避免把网页控制语义重新耦合到 TUI 光标状态。

## UI 控制按钮

Council UI 可以展示三个明确动作：

- `Wake/Recover`：在没有新消息时人工唤醒原 managed session，要求 agent 进入一次短时热监听；正常消息不需要点击它。
- `Pause`：暂停该 agent 的热等待和 daemon 自动 wake。
- `Disconnect`：关闭并解绑该 agent 的 managed session，不影响其他 agent。

这些按钮不是只修改 UI 状态。后端保留二次保护：

- recovery 会检查 active waiter、active wake、MCP readiness 和 live managed session。
- 如果 agent 仍在 `channel_wait_new` 或已存在 wake transaction，recovery 会被跳过。
- Disconnect 只有在 managed session 确认关闭后才清除 session binding。
- 最后一个 agent Disconnect 后，Council 转为 stopped。

因此 UI 状态判断即使短暂滞后，也不会把第二份 recovery prompt 塞进正在监听或工作的 agent。

## Mention 输入规则

Council composer 支持 `@` mention，用于把消息明确指向某个 agent 或全体 agent。

- `@all` 是唯一的全体广播目标，表示所有 agent 都应参与当前讨论。
- 具体 agent 使用 `@<agent name>`，agent name 来自 council 中展示的唯一 agent 名称。
- 可以在同一条消息里多次 mention，例如 `@all 先看问题。 @GPT-5.5-XHigh 重点检查实现。`
- `@` 菜单只在行首、文本开头或空白/括号/引号之后触发。
- 普通正文内部的 `@` 不触发菜单，例如邮箱、代码片段、`foo@bar`、`正文@gpt`。
- 这是刻意的保守策略：宁可要求用户在 mention 前加空格或换行，也不要在普通文字里误弹菜单。
- `@council` 不作为公开目标；它和 `@all` 语义重复，统一用 `@all` 表达全体讨论。
- daemon 与 composer 使用同一保守 mention 边界：命中一个或多个已知 agent name 时只向这些订阅者投递；命中 `@all` 或没有命中已知 name 时广播。邮箱和普通正文内部的 `@` 不缩小投递范围。

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

- Council membership/subscription/cursor 由 daemon 持有；`channel_join` 不是成员关系真相。
- active `channel_wait_new` 是热监听的权威 runtime fact；timeout 结束 turn，不删除订阅。
- wake 必须携带 canonical 消息原文，不能只发 notice 再要求 agent 读 inbox。
- 同一 agent 同时最多一个 wake transaction。busy/active wake 阶段只排队并合并，不并发塞入第二个 turn。
- 只有精确 `session.input.accepted.clientMessageId` 能推进该 wake 的 delivery cursor；RPC 返回、PTY write 或队列消失都不是 acceptance。
- lifecycle/status system rows 不得成为 agent inbox 消息，也不得唤醒其他 agent。
- persistent pause gate 是 agent 是否允许热等待和自动 wake 的权威 runtime fact。Pause 必须先建立暂停门并结束 waiter，再调用 provider interrupt。
- Recovery 不应在 active listener 或 active wake 存在时执行；恢复暂停门后仍复用原 managed session。
- Archive / Stop council 才负责结束 PTY 和 agent 进程。Disconnect 只结束目标 agent，不得影响其他 managed session。
- Council Stop 必须完成所有 managed session 的关闭后才提交 `ended`；失败时保留 session binding 和 `stopping` 状态供重试。

## 测试要求

相关行为必须由 runtime 单测覆盖：

- active Claude waiter pause 返回 `paused: true`，并调用统一 provider interrupt。
- Codex/OpenCode/Claude 启动时都不发送 bootstrap turn；Claude `tools/list` readiness 前的消息保留在 daemon 队列。
- MCP ready 早于 start response 时不能丢失；ready 只提交 subscribed 状态，不发送模型输入。
- 两条快速消息合并为一次包含完整原文的 wake；busy turn 结束前不能发送第二次 wake。
- wake input 带稳定 identity，精确 acceptance 后才推进 cursor；后到消息在 terminal event 后形成下一批。
- hot waiter 命中时不创建 wake input；system lifecycle row 永不进入 wake/inbox。
- timeout 返回 `sleeping/end_turn`，不再返回 heartbeat/re-wait 指令。
- 明确 agent mentions 缩小投递范围，`@all`、普通文本和邮箱边界行为确定。
- active OpenCode waiter pause 不写 raw TUI escape，并返回 `paused: true`。
- paused agent 再次调用 `channel_wait_new` 仍然保持 paused。
- Recovery 成功后允许重新进入监听；跳过或抛错时保持 paused。
- pause 不关闭 agent session，后续仍可 recovery wake。
- Disconnect 关闭目标 agent 后，其他 agent 仍保持原 session 和 listening 状态。
- Codex `no active turn to interrupt` 关闭响应按幂等成功处理。
- managed session 关闭失败时 Council Stop 可重试，不能提前清除 binding 或提交 ended。
