# Codex App Server 协议地图

状态：Conversation 的稳定协议依据

复核日期：2026-07-10

## 1. 证据边界

本文只把 Codex 开源仓库里的 app-server v2 协议当作稳定事实。复核基线：

- Codex 源码提交：`1f0566d3f`
- 本机 CLI：`codex-cli 0.144.1`
- 本机 Codex Desktop 内置 CLI：`codex-cli 0.144.0-alpha.4`
- 主要源码：`codex-rs/app-server-protocol/src/protocol/v2/`
- 协议说明：`codex-rs/app-server/README.md`

另外使用本机 `codex app-server generate-json-schema --experimental` 生成了 `0.144.1` 的实际安装协议；其中已经包含 `excludeTurns`、`initialTurnsPage`、`thread/turns/list`、`thread/items/list`、Turn 时间字段和 item 生命周期时间戳。因此这些能力不是只存在于未发布源码中的设想。

Desktop 的编译后前端只能证明当前产品如何消费协议，不能替代公开协议，也不能成为 RAH 的运行时依赖。

## 2. 一级实体

### Thread

`Thread` 是持久会话，包含：

- `id`、`sessionId`、`forkedFromId`、`parentThreadId`
- `name`、`preview`、`cwd`、Git 信息
- `createdAt`、`updatedAt`、`recencyAt`
- `status`
- 可选的 `turns`

`ThreadStatus` 明确区分：

- `notLoaded`
- `idle`
- `systemError`
- `active`，并可携带 `waitingOnApproval`、`waitingOnUserInput`

因此 RAH 不应再仅凭最后一条消息或子 agent 完成事件推断主 thread 是否 ready。

### Turn

`Turn` 是一次用户输入到终态的完整处理边界：

- `id`
- `items`
- `itemsView`: `notLoaded | summary | full`
- `status`: `inProgress | completed | interrupted | failed`
- `error`
- `startedAt`、`completedAt`、`durationMs`

这三个时间字段足够直接实现 `Working for`、`Worked for` 和 `You stopped after`，不需要用第一条消息和最后一条气泡的时间做近似。

### ThreadItem

`ThreadItem` 是 turn 内的语义单元。当前公开类型包括：

- `userMessage`
- `agentMessage`
- `reasoning`
- `plan`
- `commandExecution`
- `fileChange`
- `mcpToolCall`
- `dynamicToolCall`
- `collabAgentToolCall`
- `subAgentActivity`
- `webSearch`
- `imageView`、`imageGeneration`
- `sleep`
- `enteredReviewMode`、`exitedReviewMode`
- `contextCompaction`

`agentMessage.phase` 是 `commentary | final_answer | null`。源码明确说明 provider 不保证始终提供 phase，因此 `null` 只能触发兼容策略，不能被硬解释为 final。

## 3. 生命周期与权威性

一次正常 live turn 的结构是：

1. `turn/start` 返回初始 Turn。
2. `turn/started` 标记真正开始运行。
3. 每个 item 走 `item/started`。
4. 中间通过 item 专用 delta 更新。
5. `item/completed` 给出该 item 的权威终态。
6. `turn/completed` 给出整个 turn 的权威终态。

重要规则：

- `item/started.startedAtMs` 和 `item/completed.completedAtMs` 是 item 生命周期时间。
- completed item 是工具执行、文件修改和消息内容的权威结果。
- `turn/completed` 决定主 turn 是否真正结束；subagent item 完成不能替代它。
- `thread/status/changed` 决定 thread 当前 runtime 状态。
- `thread/tokenUsage/updated` 独立提供 usage，不应从文本反推。

## 4. 控制协议

稳定主链路：

- 新建：`thread/start`
- 原生分支：`thread/fork`
- 恢复：`thread/resume`
- 只读查看：`thread/read`
- 发问：`turn/start`
- 向当前 turn 追加输入：`turn/steer`
- 中断：`turn/interrupt`
- 改后续设置：`thread/settings/update`
- 取消当前连接订阅：`thread/unsubscribe`

`turn/start`/`turn/steer` 请求中的稳定输入字段叫 `clientUserMessageId`，而 server 返回的
`UserMessageThreadItem` 使用 `clientId`。二者是同一输入身份的不同 wire 名称；RAH adapter
必须统一后 exactly-once 投影，不能把 native echo 当成第二条 user message。`turn/start`
canonical placement 为 `turn_start`；成功的 `turn/steer` 为 `turn_steer`。RAH Web 发起的
Guide 还保留点击时的 turn-local causal anchor；外部客户端历史只按 rollout 原生顺序恢复，
不伪造 anchor。

`thread/unsubscribe` 不会立即杀掉 thread。最后一个订阅者离开后，server 会保留 thread，直到它没有活动且无订阅者 30 分钟才卸载。这与 RAH 的 Web 视图切换、TUI warm 生命周期是两个不同层次，不能混为一谈。

### Fork 与 Side

RAH 的 Fork 和 Side 都必须调用 provider-native `thread/fork`，不能复制已经渲染的 Chat 文本来伪造上下文：

- Session 菜单中的 “Fork” 使用 `threadSource: "fork"`，创建持久化同工作区 Fork；它有独立 thread identity，出现在 Chats，父 session 关闭后仍保留。
- Session 菜单中的 “Side” 使用 `threadSource: "sideConversation"` 与 `ephemeral: true`，创建临时 Side thread；RAH 同时写入 Side developer instructions 和明确的 conversation boundary，继承历史只作为参考，不能自动延续父任务。
- 两者都可传 `lastTurnId` 固定分支点，并继承父 thread 的 cwd、model、reasoning、approval 与 sandbox 设置。
- 当前只开放 `workspaceMode: "shared"`。在 RAH 具备完整 Git worktree 创建、清理和冲突处理生命周期前，不暴露 worktree Fork。

Side thread 是父 session 的内部工作面，不属于顶级历史目录。RAH 将 Side 自己的
`turn/started` / `turn/completed` 映射为 `active` / `completed`；Completed 仍可继续
发问，父 thread 的 Ready/Completed 不结束 Side。只有相同 thread id 的
`thread/status/changed: notLoaded`、`thread/closed`、`thread/deleted`，或承载该
pathless Side 的专属 app-server 通道终止，才进入 `expired`。

RAH 关闭父 session 时递归关闭其 ephemeral Side children。每个 Side 依次执行
turn interrupt、goal pause、`thread/unsubscribe` 和专属 app-server process 回收；
任一步失败都保留 `cleanup_failed` Side 并阻止父任务假关闭。普通持久化 Fork 不参与
级联关闭。详细状态机与 close disposition 见
[Fork 与 Side 生命周期协议](./fork-side-lifecycle.zh-CN.md)。

## 5. 历史与分页

新版协议已经提供避免大 session 全量加载的正式路径：

- `thread/read(includeTurns: false)`：只读 metadata。
- `thread/turns/list`：按 turn 分页。
- `thread/items/list`：按 thread 或 turn 分页 item。
- `thread/resume(excludeTurns: true)`：恢复 live 控制但不返回完整 turns。
- `thread/resume(initialTurnsPage: ...)`：在一次往返内恢复并取得最近 turn 页。

`initialTurnsPage` 和 `thread/turns/list` 可指定：

- `limit`
- `sortDirection`
- `itemsView`

协议直接提供 `nextCursor` 与 `backwardsCursor`。RAH 应优先采用这些 provider-native cursor，而不是在可用时仍扫描完整 rollout 来构造另一套分页事实。

## 6. RAH 的采用规则

- Live Codex：app-server notification 是唯一权威 live source。
- Codex 历史：优先 app-server turn/item page；rollout 解析只用于兼容旧 CLI、补足缺失字段或离线恢复。
- 同一 item 的 started、delta、completed 必须按 `(threadId, turnId, itemId)` upsert。
- 同一 turn 的状态必须按 `turn/completed` 收口。
- RAH 不直接向前端透传 provider union；adapter 映射到 Conversation。
- 实验字段必须经过 capability probe，不能假设所有已安装 Codex 版本都支持。

## 7. 版本兼容

RAH 启动 app-server 后应记录 capability：

- 是否接受 `excludeTurns`
- 是否接受 `initialTurnsPage`
- 是否支持 `thread/turns/list`
- 是否支持 `thread/items/list`
- Turn 是否包含时间字段
- Item notification 是否包含毫秒时间戳

能力不存在时，回退到现有 rollout pager；不能因为新版协议不可用而破坏当前 session 浏览与 resume。
