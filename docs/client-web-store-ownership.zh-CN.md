# client-web store ownership

复核日期：2026-08-16

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

蓝点只表示“终态 turn 完成但本浏览器尚未读”：实时路径只接受
`turn.completed/failed/canceled`，前台重建只接受 canonical final answer。`session.updatedAt`、
running heartbeat、commentary、tool/process、permission 与 notification 都不是完成证据，不能把多个
仍在工作的 Session 批量染成蓝点。

这里的“本浏览器”是浏览器或 standalone PWA 的当前 `localStorage` 容器，不是 daemon/account
级已读状态，也不承诺等同于物理设备 identity。Mac 读过某个 final 不能清除 iOS PWA 的蓝点；同一
final 可以在两个客户端各自保持未读，并在各自点击蓝点时各获得一次回复顶部定位。清除蓝点、消费
导航资格和读者手势所有权均只作用于当前客户端，禁止通过 daemon event 或共享 cursor 跨设备传播。

蓝点的颜色状态与点击后的 viewport intent 是同一条因果链：`SessionSidebar` 只声明
`latest_unread_reply`，`App` 必须在 `setSelectedSessionId` 清除未读之前，从当前 projection 冻结最新
终态 turn/final identity，`useWorkbenchPageController` 再把它作为有 revision 的一次性导航事务交给
Chat。终态事件与 canonical final 可以分批到达；等待期间只能用 tail 占位，旧 final 不能充当新 turn
目标。Chat 精确对齐或读者开始真实滚动后确认消费该 revision，后续 TUI/Chat 重挂载不得重放。

不得从 auxiliary feed 重建 Conversation 历史。

### `session-store-sync.ts`

- WebSocket transport sync。
- replay gap recovery orchestration。
- foreground catch-up。

replay gap 只重建 daemon-owned topology/auxiliary feed。仍存在于权威 catalog 的 Session 必须保留
已渲染 Conversation 并标记 `needsRefresh`；只立即校准 selected/visible Session，禁止对所有历史投影
发起 `Promise.all` 请求风暴。

### `session-conversation-memory-cache.ts`

- 拥有当前页面生命周期内 A→B→A 的有界 Conversation LRU。
- 只按稳定 provider identity 保存/恢复可读投影；不拥有 Session 存在性、Workspace 或 Sidebar。
- 恢复结果是 `detachedBaseline`：同步可读、后台 canonical tail 校准、失败不清空。
- canonical tail 的 `itemsView=summary` omission 不拥有删除权；同一 provider turn 已显示的 thinking
  必须按 item identity 合并保留，只有显式 delta removal 或 full view 可以移除。
- 不写 localStorage/IndexedDB；浏览器 reload 或 iOS 进程回收后由 daemon hot page 接管。

### `session-store-session-lifecycle.ts`

- start/resume/attach/claim/close 的 projection 模板。
- read-only placeholder 与 live projection 身份迁移。

### `session-store-session-startup.ts`

- start scenario/session。
- activate stored session。
- Resume/attach/claim 决策。

### `session-activation-transaction.ts`

- 生成稳定的 `clientMessageId/clientTurnId` 并提交完整 `initialInput + config`。
- 只在 daemon 返回相同 identity 的 acceptance 后 commit draft。
- 失败时恢复文本、附件与原 projection。
- 迟到完成只更新目标 Session，不拥有全局页面导航。

### `components/workbench/panes/ComposerInputQueue.tsx`

- 只显示仍为 `queued` 的输入。
- `submitting` 已由 Conversation optimistic/canonical row 唯一呈现，不能在 Composer 再复制一行。
- Guide 被 daemon 接受后，同 identity 的 canonical `user_message` 归入当前 turn 的 process timeline；它在 Worked 折叠时仍可见，不能被移到 final 后方或复制为新的顶层 turn。

### `composer-draft-store.ts`

- 以稳定 `{provider, providerSessionId}` 为 key，仅在浏览器内存中拥有未发送文本；附件与注释使用同一
  scope key。普通 Session Chat 与 Canvas pane 消费同一份状态，不能各自在 hook 内创建私有 map。
- 不进入 localStorage、IndexedDB 或 daemon transcript；发送 acceptance 后由 composer 事务清除。

### Chat viewport 与 Canvas session drop

- `ChatThread` 只拥有当前挂载 viewport 的阅读位置。读者脱离 tail 后，anchor 必须优先使用可见正文后代
  的真实像素位置，并以 canonical row identity 兜底；同一大行内部的图片/Markdown 慢布局不得改变阅读位置。
- Sidebar 到 Canvas 的拖动使用稳定 session target：running 使用 runtime id，stopped/history 使用
  `{provider, providerSessionId}`。所有可见 session 都是可拖动源，Canvas 只消费该 target 并复用既有
  `setCanvasPaneSession` / `setCanvasPaneStoredRef` owner，不能要求 Session 先 running。
- Canvas 回复文件 viewer 是非持久化 pane 状态，由 `useCanvasController` 以 `CanvasPaneId` 保存；不同 pane
  可以同时打开，隐藏/最大化不清除，retarget/clear/remove 只清理所属 pane。`App` 不得再维护一个全局
  `linkedFilePreviewPath` 来承接 Canvas 点击。viewer 的 `auto/windowed/maximized` 偏好也属于同一 pane 状态；
  `auto` 由 viewer 自己观测 pane 内容框，而不是按 viewport 或设备类型建立另一条响应式状态路径。正文文件
  点击是同一 pane viewer 的 activation/retarget：无论原 viewer 已折叠还是正在窗口化，都必须更新 request
  identity、解除折叠并激活所属 pane；窗口化时用户调整的垂直几何继续留在 viewer 实例内，换文件不重置。
- Changed Files Review 由根级 `ReviewOverlayProvider` 唯一持有。`ChatThread`、Task summary 与 Inspector
  只能发送 scope/request，不得拥有 `ReviewDialog` state 或 Portal；Review 与单文件 viewer 共享
  `FileInspectionDiffSurface`，但不共享窗口生命周期。
- `useWorkbenchInspectionLifecycle` 是跨页面临时 inspection 的唯一失效 owner。普通 Session 单文件 viewer
  必须把点击来源的 `sessionId + workspaceRoot + path` 一起保存，不能在渲染时重新读取当前 selection；Session、
  Council、workspace、Canvas active pane 或顶层设置/终端/选择器上下文改变时，普通 viewer 与不属于目标 owner
  的根级 Review 必须在绘制前关闭。离开 Canvas 或顶层功能接管页面时清空全部 pane viewer；仅在 Canvas 内切换
  active pane 不清空其他 pane 的本地 viewer，从而继续允许 A/B 同时存在。
- drag payload 同时写入 RAH 专用 MIME 与带命名空间的纯文本回退，drop 语义为 copy；普通文本和非法
  provider payload 不得被当成 session。

### PWA Composer 焦点

- permission、Plan、model/effort trigger 及其 Portal menu 都属于 textarea 的同一编辑会话。
- iOS/standalone PWA 在这些控件的 `pointerdown` 阶段保留 textarea focus；打开、选择或关闭菜单不能隐藏输入法、压缩 composer 或造成 viewport 跳动。
- 单行 composer 的首次非控件触摸是一笔“展开 + 聚焦”事务；布局重排后落到同一手指下的 context、permission、Plan 或 model 控件不得消费该次合成 click，只有下一次独立触摸才能激活控件。
- 只有 pointer 真正落在 composer 与其 Portal 控件之外时，workbench 才 blur textarea 并恢复单行 composer。

### `session-store-session-commands.ts`

- input、interrupt、control、permission、rename、mode/model command。
- Stop API 成功后立即应用 stopped summary 并解除 Closing UI；workbench/catalog metadata refresh 只在后台校准。

### `session-store-workspace.ts`

- workspace path 归一化。
- hidden/reveal 与选择 reconciliation。
- stored/live session 的 workspace 归属。

### `session-store-bootstrap.ts`

- client/connection id。
- initial load one-shot gate。
- 最近历史选择恢复。

## Selected Session 与 Inspector 预加载

用户选中 Session 后，`session-view-preload.ts` 统一拥有浏览热路径的启动顺序：

1. 先 hydrate Chat 最近历史，让正文尽快可读。
2. Chat 可用后，先启动 Changes/Files，再启动 Outputs/Sources。
3. 后两项保持启动优先级，但不能互相形成完成屏障；大型 Git worktree 不能阻塞历史资源索引，
   反过来也一样。

Inspector tab 只是缓存消费者。打开 Changes、Files、Outputs 或 Sources 不得临时创建另一条扫描，
也不得让计数从零逐项增长。默认未提交 Changes 的手动刷新继续复用同一 primary cache；只有用户
明确选择其他 comparison branch 时才发起该分支专属请求。

缓存与 React view 的生命周期必须分离：

- cache entry 拥有底层 `AbortController` 和共享 Promise；
- view 的 `AbortSignal` 只表示该 view 不再等待，不能取消其他 view 正在复用的 cache fill；
- cache LRU 淘汰或测试 reset 才能取消底层请求；
- Session A → B → A 的快速切换必须能够加入 A 原有请求，不能继承第一次 A view 的 abort；
- refresh 失败保留 last-good Changes/Files/Outputs/Sources，只更新 error/warning；
- invalidate 标记下一次强制校验，不先清空已经可见的稳定内容。

这套规则由 `session-inspector-primary-cache.ts`、`conversation-resource-index.ts` 与
`shared-cache-request.ts` 共同实现。不得在具体 pane 内复制一套请求状态。

`session-view-performance.ts` 在同一入口记录有界的本地诊断：

- 每次选择只记录 Session ID、workspace root、三个阶段的开始/完成时间、结果和缓存可用性；
- 不记录 Conversation 正文、文件内容、命令、附件或 Provider 原始事件；
- 最多保留最近 40 次，不写 `localStorage`、不发网络、不进入 canonical event history；
- 每次状态变化发布 `rah:session-view-performance` 浏览器事件，供真实浏览器回归和开发者工具
  读取；它不是用户 UI 状态，也不能反向驱动预加载；
- `aborted` 只结束本次 view 等待。共享 cache fill 继续服从 cache owner，迟到完成不能改写另一
  次 Session 选择的 trace。

这条观测用于回答“慢在 Chat、Git/Files 还是 Outputs/Sources”，不能为了缩短数字而改变正确的
加载顺序或提前传输低概率内容。

## Model catalog 边界

- daemon 拥有启动后 1 秒与每 30 分钟一次的三 provider 后台刷新；浏览器不在 startup/focus 建立全局定时器。
- Web catalog key 必须是 `provider + cwd`，不同 workspace 的模型探测结果不能互相覆盖。
- picker 只对当前 key 使用 5 分钟 on-demand freshness；Settings 的 force refresh 是显式用户操作。
- 每次请求递增 generation，迟到的旧响应不得覆盖更新的 catalog。
- catalog 失败保留 last-good；失败时间不冒充 successful updated time。

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
