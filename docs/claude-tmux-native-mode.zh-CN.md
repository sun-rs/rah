# Claude Tmux Native Mode Boundary

本文记录 RAH 对 Claude Code 的 tmux/native TUI 路线边界。该模式的目标不是把 Claude TUI 伪装成一个权威 chat server，而是保留原生 TUI 的可接续能力。

## 结论

Claude tmux native mode 的事实边界：

- TUI 是实时交互真相。
- Chat 是 Claude session JSONL/history 的镜像解析。
- Web composer 通过 tmux bracketed-paste 原子写入文本，并只提交一次 Enter。
- Web Esc 向原生 TUI 发送 interrupt key；后续输入前用 Claude 原生的 Ctrl-C 语义清理完整 multiline composer。
- RAH 只维护发送排序所需的运行状态，不把它宣称为 provider 的权威 thinking 状态。
- 当前 turn 尚未终止时，后续 Web 输入在 RAH 内按 FIFO 等待，不能直接污染 Claude composer。
- Web Esc 绑定最近一次尚未确认的提交；迟到的 JSONL user/turn_started 仍落入原 turn，并立即收口为 interrupted。
- RAH 不伪造 `Conversation interrupted` 文本气泡；Chat 的可见正文仍来自 Claude JSONL/history。

## 为什么这样设计

Claude Code 当前没有 Codex/OpenCode 那种稳定的 native local server 事件流。tmux 只能提供终端画面和输入转发，不能提供“当前 turn 正在 thinking”“某次 Esc 中断了哪个 turn”这类语义事件。

Claude TUI 本身允许 thinking 期间继续输入，但这种终端队列不是 Web Chat 可以依赖的结构化协议。因此：

- `thinking` 不等于不可输入。
- `prompt_clean` 不等于唯一可发送时机。
- JSONL 落盘结果是历史事实，不是实时控制状态。
- Web 直接向 busy composer 继续注入会引入错发、拼接残留和顺序漂移风险。

所以 Claude tmux 的正确抽象是：

```text
TUI = source of interaction truth
JSONL/history = source of chat display truth
RAH = ordered input bridge + session lifecycle reconciliation
```

## 行为规则

### Council MCP Listening

Council 是 Claude tmux 的特殊场景：Claude agent 会通过 `rah_council.channel_wait_new` 阻塞等待 council 消息。

这个状态下不应使用 Web Esc 暂停监听。`channel_wait_new` 是 RAH 自己定义的 MCP tool，正确暂停方式是让该 tool 正常返回 `paused: true / stop_wait_loop`，让 Claude 自己退出等待循环。

如果对正在执行 MCP tool call 的 Claude TUI 直接发送 Esc，Claude 可能不会回到普通 composer，后续 prompt 注入和 Enter 提交都会失效，表现为 TUI 卡住但进程仍存活。

完整规则见 [Council Listening Control 边界](./council-listening-control.zh-CN.md)。

### Send

Web chat 发送时，RAH 把整段文本放入 tmux 独立 buffer，再用 `paste-buffer -p` 交给 Claude 的 bracketed-paste 输入协议，最后只发送一次 Enter。不能重新使用逐字符 `send-keys` 加双 Enter：长提示会进入 Claude 的 paste 判定窗口，第二个 Enter 还可能恢复或重复部分 multiline draft。

用户在 RAH 中明确选择 `Bypass Permissions` 时，这个选择本身就是 Claude 首次危险模式确认的
用户意图。RAH 在启动或 Resume 前以原子写入方式设置 Claude 当前的
`skipDangerousModePermissionPrompt`，同时继续写入工作区 trust；其它 permission mode 不写该项。
这样首条用户消息不会误落到 Claude 2.1.207 新增的 `No, exit / Yes, I accept` 对话框并确认默认
退出项，也不依赖识别 TUI 文案来绕过启动门。

第一条输入建立当前 submitted identity。该 turn 尚未出现 completed / failed / canceled 事实时，后续 Web 输入进入 RAH 的每 session FIFO；终止事实到达后再注入下一条。这个队列只负责输入顺序，不推断 Claude 的思考内容。

如果之前触发过 Web Esc，下一次 Send 前 RAH 会先向 Claude composer 发送 Ctrl-C。真实 Claude 2.1.207 验证表明 Ctrl-U / Ctrl-K 只能影响当前视觉行，无法清掉恢复出来的完整 multiline draft；Ctrl-C 能清空完整草稿且不会关闭 TUI。

### Esc / Stop

Claude tmux 下的 Stop 应理解为黄色 Esc 动作：

- 向 Claude TUI 发送 Esc。
- 标记下一次输入前需要清理 TUI composer。
- 把 interrupt identity 绑定到最近尚未由 JSONL 确认的 submitted input。
- 如果 JSONL user/turn_started 在 Esc 完成后才到达，先保留原生 user identity，再对同一个 provider turn 发布 canonical interrupted lifecycle。
- interrupted lifecycle 只负责结束 Working 和释放 FIFO，不额外生成一条伪造的 assistant 文本。

### Chat Timeline

Chat timeline 只展示 Claude JSONL/history 能解析出的用户消息、助手消息、工具调用和错误信息。

不应把以下运行时提示写入 Claude tmux chat timeline：

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

Claude tmux 不应伪装成 structured live server；但 RAH 必须把 JSONL 原生 identity、Web submitted identity 和终端控制 intent 对齐，否则会持续产生重复气泡、interrupt 漂移和 stop 卡住。

## 不变量

- Claude tmux 同一 session 的 Web Send 严格串行；当前 turn 活动时，后续输入进入有界 FIFO。
- Claude 自己在工作中接收第二次输入时，会在 JSONL 写入 `queue-operation: enqueue`，随后写
  `remove` 和 `queued_command` attachment。RAH 只把 `enqueue` 投影为当前 turn 内的有序 user item；
  后两者是队列生命周期/附件事实，不再生成第二份用户气泡。
- Claude 自己写出的 queue-operation 只是 provider 历史事实，不再额外生成第二份用户气泡；RAH FIFO 真正注入后，以 JSONL 原生 user UUID 升级 optimistic identity。live 与 stored replay 使用相同解析规则。
- Claude tmux Web Esc 可以发布 canonical interrupted lifecycle，但必须锚定同一个 provider turn，且不能伪造聊天正文。
- prompt state 只用于输入桥和状态栏；Chat 消息顺序只由 canonical event / JSONL provider sequence 决定。
- submitted input 被标记 interrupted 后，在对应 JSONL user identity 到达并完成同 turn 收口前，不得释放下一条排队输入。
- Archive/close 仍必须结束 tmux session 和 Claude TUI，不能留下孤儿进程。
- Codex/OpenCode 路径不因 Claude 边界收缩而改变。
