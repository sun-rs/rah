# Fork 与 Side 生命周期协议

本文记录 RAH 中 Codex Fork/Side 的当前事实边界。实现以 Codex 官方
`thread/fork`、`thread/inject_items`、`thread/archive` 和
`thread/unsubscribe` 协议为准，不通过复制聊天记录伪造分支。

## 1. 两种分支

| 类型 | Provider 线程 | RAH 持久性 | 父任务关闭时 | 用户用途 |
| --- | --- | --- | --- | --- |
| Fork | 非 ephemeral | persistent | 保留 | 继续为一个独立任务 |
| Side | ephemeral | ephemeral | 清理 | 在主任务内部进行短期协作 |

两者目前都使用 `workspaceMode: "shared"`，会与父任务读写同一工作区。
这不是隔离的 worktree。前端必须直接展示共享工作区语义；在 Codex
provider 真正支持 worktree 前，RAH 不伪装成隔离任务。

Side 是主任务的内部协作任务，但仍有独立的 session id、provider thread id、
状态、未读标记和关闭入口。Side 自身不能继续 Fork/Side，也不能 archive、delete
或 rename。

## 2. 创建事务

创建按以下阶段执行：

1. 调用 `thread/fork`，取得唯一 provider thread id。
2. Side 调用 `thread/inject_items` 写入 Side 边界；Fork 跳过此步。
3. provider 侧准备完成后，原子地建立 RAH managed session 与
   PTY/native-TUI 基础状态。半成品不会提前暴露给 session list 或 orphan janitor。
4. 发布 session bootstrap、激活 live bridge、连接请求客户端。
5. 只有以上阶段完成后，创建才算正常成功。

任一步失败后，RAH 会用 `thread/unsubscribe` 回滚 Side，或用
`thread/archive` 回滚 Fork。provider 明确确认回滚后，才删除本地 session。

如果 provider 回滚也失败，RAH 不得把该线程从本地事实中抹掉。系统会保留或
补建一个 `failed` recovery session，写入 creation/rollback 诊断，连接原请求
客户端，并把它作为本次操作的确定结果返回。用户随后可再次关闭它；关闭成功后
才移除本地状态。这样 provider 端仍存在的线程始终有可见、可重试的清理句柄。

## 3. 幂等与并发

每次创建请求必须携带 `operationId`。

- 前端以父 session 为单位 single-flight；同一操作共享 Promise，不同操作并发时
  直接拒绝。
- 网络结果不明确时，前端在五分钟内复用原 `operationId`，不会生成新分支。
- daemon 同样以父 session 为单位 single-flight，并校验参数指纹。
- 成功结果（包括保留下来的 failed recovery session）缓存五分钟；同一
  `operationId` 重试返回同一结果。
- 同一 `operationId` 携带不同参数会被拒绝。

因此双击、客户端重试和响应丢失不能创建多个 provider thread。

## 4. Side 状态机

Side 的生命周期独立于父任务的 `running/ready` 状态。父任务进入 Ready 不会关闭
Side，Side 完成一轮回复也不会自动消失。

| 状态 | 权威触发 | 是否可继续发问 | UI 语义 |
| --- | --- | --- | --- |
| `ready` | 创建完成，或当前 turn failed/canceled 后恢复空闲 | 是 | Ready |
| `active` | Side 自己的 `turn/started` | 否；后续输入按既有队列规则处理 | Working |
| `completed` | Side 自己的 `turn/completed` | 是 | Completed，可再次使用 |
| `expired` | 同一 thread 的 `notLoaded`、`thread/closed`、`thread/deleted`，或承载该 pathless Side 的专属 app-server 通道终止 | 否 | Expired，只能创建新的 Side |
| `cleanup_failed` | 显式 discard 或父任务级联清理未获 provider 确认 | 否 | Cleanup failed，保留并允许重试 |
| `discarded` | provider 清理成功后、删除本地对象前的终态事件 | 否 | 已丢弃；随后从 UI 移除 |

正常循环是 `ready/completed -> active -> completed`。`Completed` 表示一轮工作结束，
不是 Side 生命周期结束。父任务的 `turn/completed`、父任务进入 Ready、其他 subagent
完成，都不能修改 Side 状态。

Codex ephemeral Fork 没有 rollout path，也不会进入 thread listing。RAH 当前为每个
live Side 持有独立 app-server 进程，因此其 RPC 通道意外终止后没有可靠的持久化来源
可供恢复。无论失效来自该通道终止，还是相同 thread id 的 provider 权威通知，RAH
都会将其标为 `expired` 并立即回收专属 app-server 子进程。不能根据超时、页面切换
或父任务 Ready 状态推测失效。

`session.side.state.changed` 是这套状态机的唯一 canonical event。状态同时投影到
`session.relationship.sideState`，错误详情投影到 `sideStateDetail`；前端不得自己
根据气泡数量或通用 runtime phase 重建另一套 Side 状态。

## 5. 关闭与孤儿清理

- 显式关闭 Side 必须依次完成当前 turn interrupt、goal pause、
  `thread/unsubscribe`，然后关闭其专属 app-server client/process。
- 任一步失败时，Side 进入 `cleanup_failed` 并留在 RAH 中；不得发布
  `session.closed`，用户可再次 discard。
- 已由 provider 明确关闭或卸载的 `expired` Side 不再发送无意义的 unsubscribe；
  本地清除后仍以 `discarded` 作为 close disposition。
- 父任务关闭时，先递归清理其 ephemeral Side；任一 Side 清理失败，父任务也不能
  被假装成已完全关闭。
- Parent Stop、Delete 和 Archive 使用同一边界。前端先 close runtime，再调用 stored
  history mutation；daemon 的 history API 也拒绝对仍有 managed session 的 provider
  identity 直接 Archive/Delete，避免调用方绕过级联清理。
- Fork 是独立持久任务，父任务关闭不会删除 Fork。
- orphan janitor 只有在 provider adapter 明确实现 `destroySession` 且调用成功后，
  才能删除本地记录。缺少 destroy 能力不是清理成功。
- daemon shutdown 的目标是尽力释放进程资源；它不能把未获 provider 确认的显式
  删除伪装成成功。

关闭事件必须携带明确 disposition：普通 session 为 `stopped`，用户 discard Side
为 `discarded`，父任务级联清理 Side 为 `parent_closed`。`expired` 是“provider 对象
已经不可继续”的存活 UI 状态，不是 close disposition，二者不能混用。

Codex app-server 本身会在 thread 同时“无订阅且不 active”持续 30 分钟后卸载它。
这是 provider 资源回收机制，不是 RAH 的 Side 自动关闭计时器。RAH 不按 30 分钟
倒计时隐藏 Completed Side；显式 discard 和父任务级联清理仍立即执行上述清理协议。

## 6. UI 协议

- 创建期间入口立即进入 pending/disabled 状态，避免双击。
- `Continue in new task` 必须标注 `Shares this workspace`。
- `Open Side task` 必须标注 `Ephemeral, shared workspace`。
- 桌面默认主任务约占 60%，Side 约占 40%；Side 不应反客为主。
- 移动端使用 Main/Side 切换，但 Side 项必须显示真实标题、状态、未读和 discard。
- `Completed` Side 保持在 dock 内并可继续发问；`Expired` 显示 New Side；
  `Cleanup failed` 显示错误详情并保留 discard 重试入口。
- Side 布局与移动端当前页面按父 session 持久化；刷新不应任意改回默认视图。
- 普通页面、Canvas pane 和 Side 共用 Conversation surface；容器可以不同，停止、
  权限、历史、模型和输入行为不能另写一套。

## 7. 回归要求

至少覆盖以下路径：

1. Side/Fork 正常创建与关闭。
2. Side 边界注入失败且 provider 回滚成功。
3. 本地创建失败且 provider 回滚失败，能得到 failed recovery session。
4. 本地已创建后边界注入失败且 provider 回滚失败，原客户端仍连接 recovery session。
5. 关闭失败后本地状态保留，第二次关闭可成功。
6. 双击、并发分支和网络结果不明确时不产生重复 provider thread。
7. 父任务关闭清理 Side、保留 Fork。
8. provider 不具备 destroy 能力时 orphan janitor 不丢本地事实。
9. 桌面与移动端真实浏览器验证布局、状态、共享工作区提示和 discard 行为。
10. Side turn 完成后进入 Completed 但仍可再次发问；父任务 Ready 不影响它。
11. provider `notLoaded/closed/deleted` 只作用于相同 thread id，并显示 Expired/New Side。
12. Archive/Delete 不能绕过仍打开的 managed parent 与 Side 级联清理。
