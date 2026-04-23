# `rah codex` 标准交付文档

## 1. 目标

`rah codex` 的目标不是“从 history claim 一个已存在 session”，而是：

- 在 mac terminal 里保持 **原生 Codex TUI**
- 同时把这条 TUI 会话接入 RAH daemon
- 让它立即出现在 web 左侧 `live sessions`
- terminal 和 web 成为同一个 live session 的两个 surface

当前这条链已经进入稳定可测状态。

## 2. 关键边界

### 2.1 live 的定义

只要 terminal wrapper 已经向 daemon 注册成功，这条 session 就是 `live`。

这和它当前是不是可输入是两件事：

- `live` = 已被 daemon 接管
- `ready / thinking / approval / unread` = live session 的子状态

### 2.2 session owner

`rah codex` 不引入第二个 owner。

当前唯一 session owner 仍然是 daemon：

- daemon 持有 session registry
- daemon 持有 canonical event bus
- daemon 持有 control / runtime state

terminal 和 web 都只是同一个 live session 的 surface。

### 2.3 不同步 draft，只同步 canonical turn

会同步：

- 已提交用户消息
- AI 回复
- runtime state
- permission / question
- stop / interrupt

不会同步：

- terminal 里尚未提交的草稿
- web 输入框草稿
- 光标位置
- 原生 TUI 的瞬时 UI 状态

## 3. 为什么现在能精准绑定

旧方案的问题是：

- 通过 `cwd + startup time + rollout 更新时间` 去猜当前 session
- 一旦同 cwd 下已经有外部裸 `codex` live，会错误绑到别的 session

当前稳定方案改成了：

- `rah codex` 新会话使用 **wrapper-owned isolated `CODEX_HOME`**
- 只共享 auth / config
- 不共享 `sessions/`

这意味着：

- `rah codex` 新开的 session 物理上就不会再看到外部裸 `codex` 的 live session 文件
- 因此不会再误绑到另一个运行中的 `codex`

相关实现：

- [codex-wrapper-home.ts](/Users/sun/Library/Mobile%20Documents/com~apple~CloudDocs/Lab/crates/AI/rah/packages/runtime-daemon/src/codex-wrapper-home.ts)
- [codex-stored-sessions.ts](/Users/sun/Library/Mobile%20Documents/com~apple~CloudDocs/Lab/crates/AI/rah/packages/runtime-daemon/src/codex-stored-sessions.ts)
- [codex-terminal-wrapper.ts](/Users/sun/Library/Mobile%20Documents/com~apple~CloudDocs/Lab/crates/AI/rah/packages/runtime-daemon/src/codex-terminal-wrapper.ts)

## 4. turn 生命周期

`rah codex` 现在不再主要靠 prompt 猜测 turn 结束。

wrapper 会直接读取 rollout 里的强信号：

- `task_started`
- `task_complete`

当前语义是：

- `task_started` => 当前 turn 开始，进入 `agent_busy`
- `task_complete` => 当前 turn 结束，直接回到 `prompt_clean`

这是这条链稳定下来的关键，因为它避免了：

- 第一条 web turn 结束后 `stop` 不消失
- 第二条 web turn 永远 `queued`

## 5. web / terminal 双向联动

### 5.1 terminal -> web

terminal 里的：

- 用户消息
- AI 回复
- tool 活动
- PTY 输出

会通过 wrapper 桥接成 canonical events 进入 daemon，再进入 web。

### 5.2 web -> terminal

web 发出的消息会：

1. 进入 terminal wrapper queue
2. 在 `prompt_clean` 时被下发为 `turn.inject`
3. 注入同一个原生 Codex TUI PTY

因此现在已经成立：

- web 里发一句话
- terminal 里的原生 Codex TUI 也会继续跑这一轮

## 6. 关闭语义

### 6.1 web 关闭

web `archive/close` 不是只删 UI 状态。

现在会：

1. 发 `wrapper.close`
2. 立刻从 sidebar 隐藏这条 session
3. 等 wrapper 真正退出后，再完成 backend 收口

因此不会再出现：

- close 后 terminal 卡死
- `Unknown session ...`

### 6.2 terminal 关闭

terminal 里的 wrapper / Codex TUI 自己退出后：

- wrapper 会发 `wrapper.exited`
- daemon 会同步把这条 live session 从 web 移除

## 7. 当前已经锁死的设计

当前 `rah codex` 这条线，已经可以认为锁死成下面这组边界：

- 原生 Codex TUI 保留
- daemon 是唯一 owner
- terminal / web 是双 surface
- 新会话通过 isolated `CODEX_HOME` 精准绑定
- turn 生命周期以 rollout 强信号驱动
- close 是双向联动，不是单边 UI 删除

一句话概括：

**`rah codex` = daemon-owned live session + terminal/web 双 surface + isolated session home + explicit turn lifecycle。**

## 8. 当前仍未承诺的范围

当前这份稳定交付 **没有** 承诺以下能力已经完成：

- 在同一个 Codex TUI 内 `/new` / `/resume` 后，RAH 自动把旧 live session 提升/切换成新的 live session
- web 侧 assistant 文本真正逐 token 流式显示到和 TUI 一样细
- `rah claude / gemini / kimi` 已达到和 `rah codex` 同等级别完成度

这些都属于下一阶段工作，不属于本次 `rah codex` 稳定交付的范围。
