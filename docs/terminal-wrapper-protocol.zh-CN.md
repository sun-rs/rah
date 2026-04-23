# Terminal Wrapper Live Session 协议草案

## 1. 目标

这份文档是在
[Terminal Wrapper Live Session 设计](./terminal-wrapper-live-sessions.zh-CN.md)
之上，继续收成 **可实施接口草案**。

它回答四个问题：

1. `rah codex` wrapper 如何和现有 daemon 勾连
2. terminal 与 web 如何共享同一个 live session
3. 为什么不需要 hapi 那种 `local / remote mode`
4. 第一阶段只做 `rah codex` 时，最小协议应该长什么样

## 2. 范围

### 2.1 本文覆盖

- wrapper ↔ daemon 控制通道
- `operatorGroupId`
- `surfaceId`
- prompt 状态边界
- remote turn queue
- 第一阶段 `rah codex` 的最小消息集

### 2.2 本文不覆盖

- provider 原生 TUI 细节同步
- terminal 草稿同步
- 多用户协作策略
- `rah claude` 第二阶段协议细节

## 3. 设计基线

### 3.1 daemon 仍然是唯一 owner

wrapper 不是新的 session owner。

它只负责：

- 启动原生 provider CLI
- 采集 provider 活动
- 将活动桥接给 daemon
- 接收 daemon 下发的远端操作

真相仍在 daemon：

- session registry
- control
- canonical event bus
- web API / WS

### 3.2 同步的是 turn，不是 draft

terminal 和 web 共享：

- 已提交用户消息
- AI 回复
- permission / question
- tool / observation
- runtime status

terminal 和 web 不共享：

- 未提交草稿
- 光标位置
- provider 原生 TUI 的瞬时 UI

### 3.3 queue 替代 mode switch

系统不再引入：

- `local mode`
- `remote mode`
- `switchSession(sessionId, 'remote' | 'local')`

改用：

- `prompt_clean`
- `prompt_dirty`
- `agent_busy`
- `queuedInput`

即：

- 如果当前 prompt 可安全注入，远端 turn 立即送入 provider
- 如果当前 prompt 不安全，远端 turn 入队

## 4. 新增概念

## 4.1 `operatorGroupId`

一个控制主体，不等于一个 client。

同一个 `operatorGroupId` 下可以有多个 surface：

- terminal surface
- web surface
- iPhone / iPad surface

第一阶段建议生成方式：

- `rah codex` 启动时由 daemon 生成
- wrapper 和随后附着的本地 web surface 共享它

作用：

- 同一个人/同一台机器的多个 surface 不需要互相 claim
- 不同 operator group 之间仍然走现有 claim / observe 语义

## 4.2 `surfaceId`

一个连接端的标识。

例子：

- `terminal:<pid>:<nonce>`
- `web:<connectionId>`

作用：

- 标识当前消息来自哪个 surface
- 标识当前 focus surface
- 用于诊断和调试

`surfaceId` 不是 ownership 概念。

## 4.3 `promptState`

wrapper 向 daemon 上报的最小输入边界状态。

第一阶段只定义三个状态：

- `prompt_clean`
  - 当前在安全注入边界
  - terminal draft 为空
- `prompt_dirty`
  - 当前在安全注入边界
  - 但 terminal draft 非空
- `agent_busy`
  - provider 正在运行
  - 当前不是安全注入边界

## 4.4 `queued turn`

远端 surface 发来的 turn，在不能立即注入 provider 时进入 queue。

这是替代 hapi `mode switch` 的核心。

## 5. 现有协议的最小扩展建议

## 5.1 `ManagedSession`

当前已足够承载第一阶段：

- `launchSource: "terminal"`
- `capabilities.queuedInput`

第一阶段不建议为 wrapper 再造新的 session type。

建议后续可加，但第一阶段不强制：

- `operatorGroupId?: string`

如果不想立即改 `runtime-protocol`，也可以第一阶段先把它放到：

- daemon 内部 session metadata
- 不对 web 暴露

## 5.2 `AttachedClient`

建议后续扩展：

- `surfaceId?: string`
- `operatorGroupId?: string`

但第一阶段也可以只在 daemon 内部维护，不先冻结到 protocol。

## 5.3 `ControlLease`

最终方向建议是：

- `holderOperatorGroupId?: string`
- 保留 `holderClientId?` 作为当前活跃 surface 展示

但第一阶段为了最小落地，可以先不改 wire contract：

- daemon 内部把 terminal + web 视为同一组
- 对外仍沿用现有 `holderClientId`

这意味着：

- 第一阶段实现先偏 runtime 内部
- 第二阶段再决定是否冻结到 protocol

## 6. Wrapper ↔ daemon 控制通道

## 6.1 传输层

第一阶段建议：

- 直接复用 daemon 同源入口上的 localhost WebSocket

理由：

- 现有 daemon 已经提供 HTTP / WS
- 不需要再做第二套 hub
- 不需要先上 UDS 才能开始

未来如果有需要，再把 wrapper control channel 下沉到 Unix domain socket。

## 6.2 连接身份

wrapper 连接 daemon 时，建议携带：

- `provider`
- `cwd`
- `rootDir`
- `terminalPid`
- `launchCommand`
- `resumeProviderSessionId?`

daemon 返回：

- `wrapperSessionId`
- `sessionId`
- `operatorGroupId`
- `surfaceId`

其中：

- `sessionId` 是 runtime session id
- `surfaceId` 是 terminal surface id
- `operatorGroupId` 是本地 terminal + 同组 web 的控制主体

## 7. 第一阶段消息草案

以下消息名称是建议名，重点在语义，不要求立即照字面冻结。

## 7.1 wrapper -> daemon

### `wrapper.hello`

用途：

- 建立 wrapper 控制通道
- 请求创建或恢复 terminal-launched live session

示意：

```json
{
  "type": "wrapper.hello",
  "provider": "codex",
  "cwd": "/repo",
  "rootDir": "/repo",
  "terminalPid": 12345,
  "launchCommand": ["rah", "codex"],
  "resumeProviderSessionId": null
}
```

### `wrapper.provider_bound`

用途：

- wrapper 已经知道 provider 的真实 session / thread id
- 同一个 terminal surface 如果在 TUI 内 `/new` / `/resume` 切换到别的 session，
  必须再次发送这条消息

示意：

```json
{
  "type": "wrapper.provider_bound",
  "sessionId": "rah-session-1",
  "providerSessionId": "thread-abc",
  "providerTitle": "issue triage",
  "providerPreview": "Investigate production regression",
  "reason": "resume"
}
```

字段说明：

- `providerSessionId`
  - 当前 terminal surface 正在操作的 provider session
- `providerTitle?`
  - provider 当前暴露的 session 标题
- `providerPreview?`
  - provider 当前暴露的短预览
- `reason?`
  - 绑定变化的原因，第一阶段建议值：
    - `initial`
    - `resume`
    - `new`
    - `switch`

### `wrapper.prompt_state.changed`

用途：

- 上报当前是否可安全注入 remote turn

示意：

```json
{
  "type": "wrapper.prompt_state.changed",
  "sessionId": "rah-session-1",
  "state": "prompt_dirty"
}
```

### `wrapper.activity`

用途：

- 将 provider 活动桥接给 daemon

第一阶段建议 payload 直接靠近 `ProviderActivity`：

```json
{
  "type": "wrapper.activity",
  "sessionId": "rah-session-1",
  "activity": {
    "type": "turn_started",
    "turnId": "turn-1"
  }
}
```

### `wrapper.pty.output`

用途：

- 如果本地原生 TUI 有需要镜像到 secondary terminal surface，可透传

第一阶段不要求产品化，只保留通道能力。

### `wrapper.exited`

用途：

- wrapper 或底层 provider 进程退出

```json
{
  "type": "wrapper.exited",
  "sessionId": "rah-session-1",
  "exitCode": 0
}
```

## 7.2 daemon -> wrapper

### `wrapper.ready`

daemon 对 `wrapper.hello` 的响应：

```json
{
  "type": "wrapper.ready",
  "sessionId": "rah-session-1",
  "surfaceId": "terminal:12345:1",
  "operatorGroupId": "group-local-1"
}
```

### `turn.enqueue`

用途：

- 某个远端 surface 提交了 turn，但当前不能立即注入

```json
{
  "type": "turn.enqueue",
  "sessionId": "rah-session-1",
  "queuedTurnId": "queued-1",
  "sourceSurfaceId": "web:abcd",
  "text": "继续解释这个错误"
}
```

### `turn.inject`

用途：

- daemon 判断当前 prompt 安全，可将 queued turn 注入 provider

```json
{
  "type": "turn.inject",
  "sessionId": "rah-session-1",
  "queuedTurnId": "queued-1",
  "text": "继续解释这个错误"
}
```

### `turn.interrupt`

用途：

- 某个 surface 请求 stop / interrupt

### `permission.resolve`

用途：

- web 侧已批准/拒绝 permission
- wrapper 需要将 resolution 注入 provider

### `control.sync`

第一阶段可选：

- daemon 通知 wrapper 当前哪些 surface 在同一个 operator group

不是必要第一阶段消息。

## 8. 第一阶段执行流程

## 8.1 `rah codex`

1. wrapper 检查 daemon `readyz`
2. daemon 不在则自动拉起
3. wrapper 发送 `wrapper.hello`
4. daemon 创建：
   - `ManagedSession`
   - `launchSource: "terminal"`
   - `queuedInput: true`
5. daemon 返回：
   - `sessionId`
   - `surfaceId`
   - `operatorGroupId`
6. wrapper 启动原生 Codex CLI
7. 一旦得到 thread id，发送 `wrapper.provider_bound`
   如果之后 TUI 内又切到别的 session，也必须再次发送
8. wrapper 持续发 `wrapper.activity`
9. web 左侧立即看到该 live session

## 8.2 手机 web 发消息

1. 手机 web 在同一 `operatorGroupId` 下附着 session
2. 用户提交消息
3. daemon 看当前 `promptState`
4. 如果 `prompt_clean`
   - 立刻下发 `turn.inject`
5. 如果 `prompt_dirty` 或 `agent_busy`
   - 先发 `turn.enqueue`
   - 等下一次 `prompt_clean` 再转 `turn.inject`
6. provider 响应回流
7. terminal 与 web 同时看到 AI 回复

## 9. Phase 1 边界

### 9.1 必须保证

- `rah codex` 启动后立即出现在 web live sessions
- terminal 保留原生 Codex CLI TUI
- web 可以继续发送消息
- terminal 可以看到 AI 对 web 消息的回应
- 不需要 claim history
- 不需要 local / remote mode

### 9.1.1 active binding 不是 one-shot

`wrapper.provider_bound` 声明的是：

- 当前这个 terminal surface 此刻正在操作哪个 provider session

它不是历史宣告，而是 **active binding**。

因此：

- 一个 terminal surface 可以稳定存在
- 但它绑定的 `providerSessionId` 是可变的

这正是为了覆盖 provider CLI 在同一个 TUI 内：

- `/new`
- `/resume`
- 直接切 session

这些行为。

### 9.1.2 当前实现的安全边界

当前实现已经允许同一个 terminal surface 重复发送 `wrapper.provider_bound`，
并把这视为 active binding 的更新。

当前行为是：

- live session 仍然对应同一个 terminal surface
- 一旦 `providerSessionId` 从 A 变为 B
  - runtime 会更新 summary 上的 `providerSessionId/title/preview`
  - 清空该 live session 的 history snapshot
  - 重置 live projection 的 usage / active turn / runtimeState
  - 前端在收到新的 `session.started` 后，会把 feed / history 视为新的 active binding

这意味着：

- 不会把旧 provider session 和新 provider session 的 feed 混成一条连续对话
- web 仍然继续跟随同一个 terminal live session

当前**还没做**的是：

- 当 terminal surface rebind 到新的 provider session 时，
  旧 provider session 是否要在 RAH 中保留一条独立 live 记录

当前阶段的产品语义是：

- `live session` 表示 terminal surface 当前正在操作的那条会话
- `/new` / `/resume` 后，它会切换为新的 active binding
- 旧会话通过 provider history 路线保留，不在 live 列表里继续占一个独立槽位

### 9.2 有意不做

- draft 同步
- 光标同步
- terminal 补全菜单同步
- 多 operator group 并发写同一 terminal session
- `rah claude` 同时开工

## 10. 为什么这能避开 hapi 的问题

因为 hapi 的根问题是：

- 它把 CLI / TUI 当成 primary owner
- web 成了 remote owner
- 所以必须切 mode

这份草案改成：

- daemon 才是 owner
- terminal 和 web 只是两个 surface
- queue + prompt boundary 替代 mode switch

所以不会要求用户：

- 按 Esc
- 切 local / remote
- 抢输入控制权

## 11. 与现有 RAH 的兼容策略

第一阶段尽量少改 frozen protocol。

建议策略：

- `operatorGroupId`、`surfaceId`、`promptState`
  - 先放 daemon 内部和 wrapper channel
- canonical event taxonomy 不动
- `ManagedSession` 仅复用现有：
  - `launchSource: "terminal"`
  - `capabilities.queuedInput = true`

只有当 Phase 1 跑通后，再决定：

- 哪些字段值得升格进 `runtime-protocol`

## 12. 下一步实现顺序

1. 新增文档中定义的 wrapper control channel
2. 先做 `rah codex`
3. 让 daemon 能创建 terminal-launched live session
4. 让 web 能把它当普通 live session 打开
5. 跑通：
   - terminal 启动
   - web 看到 live
   - web 发一句话
   - terminal 看到 AI 回复
6. 再决定哪些字段要冻结进 protocol
