# Claude Zellij Native Mode Boundary

本文记录 RAH 对 Claude Code 的 zellij/native TUI 路线边界。该模式的目标不是把 Claude TUI 伪装成一个权威 chat server，而是保留原生 TUI 的可接续能力。

## 结论

Claude zellij native mode 的事实边界：

- TUI 是实时交互真相。
- Chat 是 Claude session JSONL/history 的镜像解析。
- Web composer 只是把用户输入转交给原生 TUI。
- Web Esc 只是向原生 TUI 发送 interrupt key，并做输入框残留清理。
- RAH 不对 Claude zellij 维护权威 busy/idle。
- RAH 不在 Claude zellij 下维护隐藏消息队列。
- RAH 不把 Web Esc 生成的 synthetic interrupt 写入 chat timeline。

## 为什么这样设计

Claude Code 当前没有 Codex/OpenCode 那种稳定的 native local server 事件流。zellij 只能提供终端画面和输入转发，不能提供“当前 turn 正在 thinking”“某次 Esc 中断了哪个 turn”这类语义事件。

Claude TUI 本身允许 thinking 期间继续输入，并由 TUI 自己处理累计/排队。因此：

- `thinking` 不等于不可输入。
- `prompt_clean` 不等于唯一可发送时机。
- JSONL 落盘结果是历史事实，不是实时控制状态。
- RAH 自己排队会引入卡住、错发、拼接残留和顺序漂移风险。

所以 Claude zellij 的正确抽象是：

```text
TUI = source of interaction truth
JSONL/history = source of chat display truth
RAH = input forwarding + session lifecycle management
```

## 行为规则

### Council MCP Listening

Council 是 Claude zellij 的特殊场景：Claude agent 会通过 `rah_council.channel_wait_new` 阻塞等待 room 消息。

这个状态下不应使用 Web Esc 暂停监听。`channel_wait_new` 是 RAH 自己定义的 MCP tool，正确暂停方式是让该 tool 正常返回 `paused: true / stop_wait_loop`，让 Claude 自己退出等待循环。

如果对正在执行 MCP tool call 的 Claude TUI 直接发送 Esc，Claude 可能不会回到普通 composer，后续 prompt 注入和 Enter 提交都会失效，表现为 TUI 卡住但进程仍存活。

完整规则见 [Council Listening Control 边界](./council-listening-control.zh-CN.md)。

### Send

Web chat 发送时，RAH 直接把文本写入 zellij 中的 Claude TUI 并提交。

RAH 不根据 `prompt_clean` / `agent_busy` 决定是否排队。Claude 是否接受、累计或排队输入，由原生 Claude TUI 负责。

如果之前触发过 Web Esc，下一次 Send 前 RAH 会先清理 Claude TUI composer，避免旧输入残留与新输入拼接。

### Esc / Stop

Claude zellij 下的 Stop 应理解为黄色 Esc 动作：

- 向 Claude TUI 发送 Esc。
- 标记下一次输入前需要清理 TUI composer。
- 不生成 `turn.canceled` chat 事件。
- 不承诺精确绑定到某个 assistant bubble。

### Chat Timeline

Chat timeline 只展示 Claude JSONL/history 能解析出的用户消息、助手消息、工具调用和错误信息。

不应把以下运行时提示写入 Claude zellij chat timeline：

- synthetic interrupt notice
- reconnecting status
- native attach/detach status
- prompt clean / dirty 状态

这些信息如需展示，应放在状态栏、toast 或 TUI 面板，不参与消息顺序。

## 与 Codex/OpenCode 的区别

Codex 和 OpenCode 具有 native local server / 官方事件流能力，RAH 可以更权威地获得 turn lifecycle、status、interrupt 结果。

因此它们可以继续保留：

- structured stop
- running/idle 状态
- turn canceled/completed lifecycle
- provider-level event reconciliation

Claude zellij 不应强行复用这套语义，否则会持续产生重复气泡、interrupt 漂移和 stop 卡住。

## 不变量

- Claude zellij Send 不进入 RAH hidden queue。
- Claude zellij Web Esc 不发布 synthetic `turn.canceled`。
- Claude zellij Chat 不依赖 RAH prompt state 排序。
- Archive/close 仍必须结束 zellij session 和 Claude TUI，不能留下孤儿进程。
- Codex/OpenCode 路径不因 Claude 边界收缩而改变。
