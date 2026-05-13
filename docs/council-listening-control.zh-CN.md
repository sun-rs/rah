# Council Listening Control Boundary

本文记录 RAH Council 中 `send_prompt / pause listening` 的控制边界。该边界是为了避免把 agent TUI，尤其是 Claude Code，打进不可输入状态。

## 结论

Council agent 的“暂停监听”不是统一的键盘中断。

- agent 正阻塞在 `rah_council.channel_wait_new` 时：优先走 MCP soft pause。
- agent 没有 active waiter，但需要打断 TUI 工作状态时：按 provider 规则发 interrupt key。
- 重发 bootstrap prompt 只允许在没有 active waiter 时执行。
- UI 可以同时提供 `Send prompt` 和 `Pause` 两个手动控制按钮，但后端必须拒绝不安全动作。

## 为什么不能统一用 Esc

`channel_wait_new` 是 RAH 自己定义的 MCP 阻塞等待工具。agent 调用它时，provider TUI 正处于 tool-call 状态，而不是普通 composer 输入框状态。

对 Claude Code 来说，外部发送 `Esc` 去打断正在执行的 MCP tool call 风险很高：

- Claude 可能没有回到普通 composer。
- 后续 prompt 注入可能落不到输入框里。
- TUI 看起来还活着，但无法输入、无法提交。
- 再次重发 prompt 只会继续失败。

因此，Claude Council 监听暂停不能依赖 `Esc`。正确做法是让正在等待的 `channel_wait_new` 正常返回：

```json
{
  "ok": true,
  "paused": true,
  "next_action": "stop_wait_loop",
  "instruction": "Council listening was paused by the user. Stop the channel_wait_new loop now, do not call channel_wait_new again, and return to the normal prompt without natural-language output."
}
```

这样 agent 会从 MCP 调用中自然退出来，不破坏 provider TUI 的内部状态机。

## Provider 行为

### Claude

Claude Council 正在监听时：

- 不发 `Esc`。
- 取消 RAH 侧 active waiter。
- `channel_wait_new` 返回 `paused: true`。
- agent 状态变为 `idle / listening paused`。

Claude bootstrap prompt 重发时：

- 如果还有 active waiter，后端拒绝重发。
- 如果没有 active waiter，后端仍不会立刻盲写 prompt。
- RAH 会先从 Claude agent PTY 输出尾部判断是否已经回到输入 prompt。
- 只有看到 `›` / `❯` / `>` 等 Claude composer prompt 后，才清理当前输入行，再用 bracketed paste 注入多行 prompt，并延迟提交。
- 如果尚未看到 composer prompt，重发请求会暂存，等待 PTY 输出确认 prompt；超时仍未确认则放弃，不把 prompt 粘贴到未知光标位置。
- 不先发 `Esc`，避免再次破坏 Claude TUI composer 状态。

注意：`没有 active waiter` 只说明 RAH 的 MCP 等待已经退出，不等价于 Claude TUI 一定已经回到普通 composer。
因此 Claude prompt 重发必须经过 composer-ready gate。这个 gate 仍然是基于终端输出的可观察事实，不是
Claude 官方控制协议；它能避免把 prompt 写到明显错误的位置，但不能让 Claude 暴露不存在的强一致 remote
control 能力。

### Codex

Codex Council 正在监听时同样优先 MCP soft pause。

如果没有 active waiter，但需要暂停/打断 TUI 当前状态，RAH 可以发一次 `Esc`。Codex 对 `Esc` interrupt 的行为相对稳定。

### OpenCode

OpenCode Council 暂停监听时不使用 MCP soft pause，即使当前存在 active `channel_wait_new` waiter。

RAH 会移除内部 waiter 记录，然后向 OpenCode TUI 发两次 `Esc`：

```text
Esc Esc
```

原因：

- OpenCode active run 中通常需要第二次 `Esc` 确认 interrupt。
- OpenCode 可能把 soft pause 的 `channel_wait_new` 返回值当成普通工具结果继续分析，然后再次调用 `channel_wait_new`。
- 因此 OpenCode 的“暂停监听”必须走 TUI 原生中断路径，而不是把 paused payload 交回模型。

## UI 控制按钮

Council UI 可以展示两个明确动作：

- `Send prompt`：向该 agent 的 TUI 重新注入 Council bootstrap prompt。
- `Pause`：暂停该 agent 的 Council listening loop。

这两个按钮不是状态切换按钮，用户可以根据 TUI 实际画面手工选择。后端保留二次保护：

- `writeCouncilBootstrapPrompt()` 会检查 `hasActiveCouncilWaiter()`。
- 如果 agent 仍在 `channel_wait_new`，prompt 重发会被跳过。

因此 UI 状态判断即使短暂滞后，也不会把第二份 bootstrap prompt 塞进正在监听的 agent。

## 与普通 Session Stop 的区别

Council listening pause 只处理 Council MCP 等待循环。

它不等价于：

- provider 原生 turn cancel
- shell/tool execution cancel
- room archive
- 终止 agent 进程

普通 session 的 Stop 仍按 provider 能力处理：

- Codex / OpenCode：优先 provider native local-server cancel / interrupt。
- Claude zellij：只能作为 TUI interrupt/escape 动作处理，不能承诺精确 turn lifecycle。

## 不变量

- RAH 不用定时器猜 agent 是否“离开监听”并自动补发 prompt。
- active `channel_wait_new` 是判断 Council listening 的权威 runtime fact。
- Pause active listener 不应写入 TUI 键盘中断。
- Send prompt 不应在 active listener 存在时执行。
- Archive / Stop room 才负责结束 PTY 和 agent 进程。

## 测试要求

相关行为必须由 runtime 单测覆盖：

- active Claude waiter pause 不写 `Esc`，并返回 `paused: true`。
- Claude prompt reinjection 不先写 `Esc`；未观察到 Claude prompt 时先排队，不写 PTY。
- Claude prompt reinjection 观察到 prompt 后，清空当前输入行，并用 bracketed paste 注入多行 prompt。
- OpenCode pause 始终使用双 `Esc`，包括 active waiter 场景。
- pause 不关闭 agent PTY，后续仍可重新注入 bootstrap prompt。
