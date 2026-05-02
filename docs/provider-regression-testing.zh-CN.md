# Provider Regression Testing

目标：每次修改 RAH 后，用固定测试保护五家 provider 的基础会话能力，避免重复输出、连续追问丢失、Stop 卡住、权限/模型参数没有真正传给 CLI 这类回归。

## 测试分层

### 1. 确定性契约测试

命令：

```bash
npm run test:provider-contracts
```

特点：

- 不调用真实模型 API。
- 使用 mock CLI / mock SDK / fake ACP server。
- 必须适合作为日常代码更新后的快速 gate。
- 主要验证 RAH 自己的 adapter 协议、事件合并、队列、权限/模型参数传递、Markdown 渲染、Stop 状态收敛。

### 2. 全量本地单元测试

命令：

```bash
npm run typecheck
npm run test:web
npm run test:runtime
```

这是提交前默认 gate。`test:provider-contracts` 是 provider 主链路的重点子集，不替代完整 runtime/web 测试。

### 3. 真实 provider 冒烟测试

命令：

```bash
npm run test:smoke:provider-flows
npm run test:smoke:browser-providers
npm run test:smoke:wrapper
```

特点：

- 会依赖本机真实 Codex / Claude / Gemini / Kimi / OpenCode CLI、账号登录、API quota、网络状态。
- 不应作为所有机器的强制 gate。
- 用来证明真实 agent 确实理解 plan/mode/model，真实工具调用能落到文件系统，真实权限行为符合 provider 当前版本。

## 覆盖矩阵

| # | 能力 | 确定性契约覆盖 | 真实冒烟覆盖 |
|---|---|---|---|
| 1 | agent 是否进入 plan mode | Codex/Gemini/Kimi/OpenCode 断言 native mode 参数或 RPC；Claude 当前不声明 RAH planMode | provider-flows 可用 prompt 让 agent 自述当前模式 |
| 2 | command / tool 调用可见 | Codex exec bridge、Gemini/Kimi/OpenCode tool translation、web tool rendering | browser/flow smoke 要求读写文件或执行命令并检查 tool event |
| 3 | 用户问题与回答不重复 | canonicalItemId upsert、history/live echo 合并、Kimi reasoning/text 回归 | browser smoke 统计 user event/bubble 数量 |
| 4 | 连续追问不丢 | Codex/Claude/Gemini/Kimi/OpenCode queued input 回归测试 | provider-flows 连续发送第一问/第二问并验证文件/marker |
| 5 | web session 发送后立即 Stop | adapter interrupt 单测覆盖 active/pending turn 状态；真实 provider 仍需 smoke 验证 | browser/manual smoke 应在新 session 首问后立即 stop |
| 6 | `rah xxx` 新 session 立即 Stop | wrapper-control smoke 覆盖 daemon wrapper path；真实 TUI 需要手测 | `test:smoke:wrapper` + 手动 TUI |
| 7 | `rah xxx resume` thinking 中 web Stop 传回 TUI | wrapper-control 协议覆盖 close/inject/canonical event；真实 interrupt 需要手测 | terminal-browser / wrapper smoke |
| 8 | 启动前/启动后修改模型、参数、权限有效 | Codex/Claude/Gemini/Kimi/OpenCode 断言 native argv/RPC/SDK options | provider-flows 可用模型自述或 provider UI/log 验证 |
| 9 | 各权限行为符合预期 | OpenCode permission payload、Claude bypass/default、Kimi yolo/approval、Codex sandbox/approval 参数、Gemini approval-mode | 真实 CLI 版本可能变化，必须用 smoke/手测确认 |
| 10 | Markdown/流式输出是一条递增气泡 | web Markdown block 测试；Kimi ContentPart 合并为 `timeline.item.updated`；canonical upsert 测试 | browser smoke 观察最终 UI |

## 设计约束

- 前端不应该靠纯文本猜重复；新事件优先按 `canonicalItemId` upsert。
- 连续追问默认进入 adapter 队列；不允许 provider 的 “already has active turn” 泄漏成用户第二问丢失。
- Stop 必须清空 queued input；如果 turn 还在 start pending 阶段，adapter 要记录 pending interrupt，等拿到 native turn id 后立即取消。
- 权限/模型/参数验证优先看 native 入参或 SDK options；“agent 自述”只能作为真实 smoke 佐证，不作为确定性测试主证据。
- 真实 provider smoke 失败时先区分 RAH 回归、provider CLI 版本变化、账号/quota/网络问题。
