# client-web store ownership

复核日期：2026-07-13

## 原则

`useSessionStore.ts` 是 Zustand orchestration shell，不拥有具体状态迁移。Conversation、transport、
workspace、session lifecycle 和 catalog 各自只有一个 owner。

## 模块

### `useSessionStore.ts`

- 暴露 state/action surface。
- 组合 owner 模块。
- 不实现分页、projection merge 或 workspace reconciliation。

### `session-store-conversation.ts`

- canonical baseline。
- older cursor paging。
- WS delta revision 合并。
- turn/item detail hydration。
- gap recovery。

这是 Chat 正文加载状态的唯一 owner。

### `session-store-conversation-directory.ts`

- directory 请求与缓存。
- 指定 turn hydration。
- directory revision。

### `session-store-pending-events.ts`

- session summary 尚未创建时暂存先到达的 WS events。
- session 出现后按 seq 回放。
- session close 或 transport gap 时清理。

它不拥有 history 状态，也不决定是否延迟 live event。

### `session-store-projections.ts`

- raw auxiliary event projection。
- sessions response merge/replace。
- unread 事件归属。
- provider-session projection adopt。

不得从 auxiliary feed 重建 Conversation 历史。

### `session-store-sync.ts`

- WebSocket transport sync。
- replay gap recovery orchestration。
- foreground catch-up。

### `session-store-session-lifecycle.ts`

- start/resume/attach/claim/close 的 projection 模板。
- read-only placeholder 与 live projection 身份迁移。

### `session-store-session-startup.ts`

- start scenario/session。
- activate stored session。
- Resume/attach/claim 决策。

### `session-store-session-commands.ts`

- input、interrupt、control、permission、rename、mode/model command。

### `session-store-workspace.ts`

- workspace path 归一化。
- hidden/reveal 与选择 reconciliation。
- stored/live session 的 workspace 归属。

### `session-store-bootstrap.ts`

- client/connection id。
- initial load one-shot gate。
- 最近历史选择恢复。

## Council store 边界

Council 不在每个页面实例内维护一套 transport：

- `App.tsx` 持有唯一的 Council summary store、初始 refresh 和一条 `council.message.created` WebSocket。
- `useCouncilTransport.ts` 只负责 socket 生命周期、前台恢复和重连，不拥有 Council 数据。
- `council-message-window.ts` 负责 summary/snapshot/message page 的幂等合并；消息唯一性只看持久化 message id。
- `CouncilPage` 是受控视图。普通页面和 Canvas pane 都读取 `App` 的同一数组；选中 Council 时才按需 hydrate 最近消息窗口。
- 全局写入必须通过 `App` 的 updater 作用于最新 ref；页面不能回写从旧 render 捕获的整份 Council 数组。
- 最近窗口除数量外还要核对 `meta.lastMessage.id`，避免“已满 100 条但尾部已经陈旧”时跳过 hydrate。
- Council list refresh 不得覆盖已经加载的消息，也不得因 Canvas pane 数量增加而增加 HTTP polling 或 WebSocket 数量。

持续同步禁止发送 `CouncilSnapshot[]`。列表只能发送 `CouncilSummary[]`，消息事件只能发送 `CouncilSummary + CouncilMessage`。

## Chats catalog 边界

Chats catalog 与左侧 running workspace state 是两套不同投影，不能互相覆盖：

- 启动和普通刷新只请求有界 Recent，当前上限为 15 条 stored session。
- Recent 的启动 baseline 来自 daemon 的 last-good catalog snapshot；后台权威扫描完成后只通过
  revision delta 修正，不允许前端自行重建或轮询 provider 存储。
- All 只有用户首次打开 All tab 时才加载完整 catalog；未打开 All 不得提前传输数百 KB metadata。
- All 已加载后，新增、停止、重命名、删除等变化按 catalog revision delta 合并，不能每次点击 tab 都全量重拉。
- `session.discovery` WebSocket event 可以更新有界 Recent，使刚停止或新发现的 session 立即出现；它不能借机填充或改写尚未加载的 All。
- Recent delta 合并必须保持上限和确定排序；All 的 workspace 展开状态只由 Chats 用户操作拥有，过滤器不能自动展开 workspace。
- All catalog 只服务 Chats。它不得新增、删除或重排左侧 workspace；左侧只由 running/revealed workspace owner 更新。

## 禁止事项

- 不新增 `history` 与 `conversation` 两套 loading state。
- 不在 `useSessionStore.ts` 内写分页 reducer。
- 不允许 UI 在 canonical error 后读取 raw history。
- 不用文本相等推断 turn/final/process。
- 不为 Canvas 建独立 Session store 或 renderer。
- 不让 Chats All catalog 污染左侧 live workspace state。
- 不在启动、Resume 或普通 session 浏览时隐式加载 Chats All catalog。

## 判断方式

新增代码前先判断：它属于 canonical Conversation、transport、auxiliary projection、workspace、
lifecycle 还是 command。已有 owner 就修改 owner；没有 owner 才新增模块。
