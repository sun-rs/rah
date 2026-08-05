# RAH Conversation 架构

状态：正式架构，canonical-only

复核日期：2026-07-29

## 1. 目标

RAH 使用一套 provider-neutral、turn-first 的 Conversation 协议承载 Codex、Claude 和
OpenCode。普通 Session、Canvas pane、历史浏览、live 恢复和 Inspector 都消费同一份
canonical projection。

这套架构不提供第二套前端 history/feed fallback。provider 原始证据可以不同，但越过 daemon
边界后只有 Conversation 一种语义。

## 2. 数据流

```text
Provider evidence
  -> provider adapter
  -> append-only RahEvent ledger
  -> Conversation projector
  -> resident/history overlay
  -> canonical HTTP page + WS delta
  -> shared ChatThread renderer
```

### Provider evidence

- Codex：app-server notification、turn/item page、持久化 rollout。
- Claude：JSONL transcript 与 TUI runtime lifecycle。
- OpenCode：server/session event 与 SQLite message/part。

这些是 adapter 输入，不是 UI read model。adapter 可以按 provider 能力选择最合适的证据来源，
但必须先归一化，再交给 projector。

### RahEvent ledger

`RahEvent` 保留 transport replay、诊断、权限、runtime lifecycle 和审计价值。它不是 Chat 的
历史分页协议，也不允许浏览器用它重建 turn/final/process。

### Conversation projector

projector 是以下事实的唯一 owner：

- turn 边界、顺序和状态
- process/final role
- final answer identity
- provider duration
- failed item count
- subagent 与主 turn 的归属
- outputs 和 sources

前端不允许再通过文字相等、相邻位置或全局 working 状态猜这些事实。

## 3. Canonical 模型

核心协议定义在 `packages/runtime-protocol/src/conversation.ts`：

- `ConversationTurnProjection`
- `ConversationItemProjection`
- `ConversationProjectionDelta`
- `ConversationOutputProjection`
- `ConversationSourceProjection`

turn 状态只有：

- `in_progress`
- `completed`
- `interrupted`
- `failed`

item role 只有：

- `user`
- `process`
- `final`
- `system`

provider-native id 必须保持 opaque。canonical id 可跨 live、history、resume 和 detail hydration
稳定定位同一 turn/item；内容 hash 不得冒充主身份。provider 只提供 turn/item key 而没有
canonical id 时，projector 可从 provider、session 和 opaque key 确定性派生 canonical id；这是
identity normalization，不是另一条读取协议或 renderer fallback。

## 4. 唯一公开读取协议

```text
GET /api/sessions/:id/conversation/turns
GET /api/sessions/:id/conversation/turns/:turnId/detail
GET /api/sessions/:id/conversation/items/:itemId/detail
GET /api/sessions/:id/conversation/directory
```

实时变化通过现有 `/api/events` WebSocket 中的 `conversationDeltas` 传输。

已删除的边界：

- 浏览器不再调用 `/api/sessions/:id/history`。
- 浏览器不再调用 `/history/detail` 或 `/history/turn`。
- 不存在 Conversation feature flag。
- canonical 请求失败时显示明确错误和 Retry，不切换另一套 renderer。

daemon 内部的 `ConversationEvidencePage` 仅承载 provider 证据事件。它不能直接通过 HTTP
暴露给 Chat。

### Session 配置协议

Session 创建、Resume 与模型切换只有两类规范配置输入：

- `optionValues`：key 必须来自所选模型的 `SessionConfigOption.id`，由 adapter 翻译为
  Codex reasoning effort、Claude effort 或 OpenCode variant。
- `modeId`：必须来自 provider mode catalog，由 adapter 翻译为 approval、sandbox 或原生 agent。

公开请求不再接受 `reasoningId`、`providerConfig`、`approvalPolicy` 或 `sandbox` 别名。旧字段会
明确返回 `400`，不能被静默忽略或降级成 provider 默认值。UI 可以把 `reasoningId` 作为选择控件
的本地 draft 名称，但越过 HTTP 边界时必须已经转换为 `optionValues`。

## 5. Live 同步

daemon 常驻 `ConversationProjectionStore`：

- 只接纳当前 live authority 允许的事件。
- settled turn 有界保留，未完成 turn 始终保留。
- 每次 canonical 变化递增 `liveRevision`。
- WS delta 携带 `baseRevision -> revision` 和 turn/item upsert/remove。

客户端只应用连续 revision：

1. 重复 revision 丢弃。
2. 短暂乱序先缓存。
3. 缺口补齐后连续应用。
4. 确认缺口无法补齐时，只刷新一次 canonical baseline。

structured live session 只消费 server push；Claude 一类 transcript runtime 由 daemon 监视
provider 文件并产生同一种 canonical delta。前端不轮询原始历史补 live。

## 6. History 与弱网

历史读取采用 tail-first：

- 首屏默认 8 turns，向上分页默认 20 turns，单次最大 100。
- `nextCursor` 只加载更早 turns。
- summary page 不携带大工具输出。
- 展开 Worked 时按 turn 请求 full detail。
- 展开单个工具时按 opaque turn/item id 请求 item detail。

历史 baseline 与 resident live projection 在响应前原子 overlay。这样 HTTP 内容与
`liveRevision` 一致，不会发生“新内容配旧 revision”。

客户端 `ConversationSyncState` 是唯一加载状态，记录：

- `phase`
- `loadedScope`
- `turns`
- `nextCursor`
- `daemonRevision`
- `pendingDeltas`
- `lastError`

旧 `HistorySyncState` 已删除。

浏览器内存仍是 Session A→B→A 的第一层热状态；整页 reload 后由仍在运行的 daemon 提供第二层
有界热页。daemon 只缓存已经完成 materialization 的 canonical page，单条最多 1 MiB、全局最多
128 条 / 32 MiB、30 分钟 LRU。复用必须同时满足同一 Runtime Session、cursor/limit、provider
`sourceRevision` 和 resident `liveRevision`；含 `in_progress` turn 或 pending/running item 的页面绝不
进入缓存。任一 revision 变化就删除旧项并重新读取 Provider，不能把旧页与新 baseline 猜测合并。
这层只存在于 daemon 内存：刷新浏览器可复用，重启 daemon 后自然冷读；浏览器不把 Conversation
正文写入 localStorage/IndexedDB，也不建立第二份持久化真相。当前 tab 只在 `sessionStorage` 保存
最后选中 Session 的 provider 身份和 workspace；reload 后用该身份解析当前 live 或 stored 对象，再从
daemon 请求上述 canonical page。显式导航到 New task/Workspace/Council 会清除选择身份；失效身份也会
被丢弃，绝不把旧 Runtime Session id 当作正文缓存键。

## 7. Turn Directory

目录与正文窗口分离：

- 目录只含 turn 边界、状态、时间和 bounded preview。
- 正文仍按 tail/cursor 加载。
- 点击未加载 turn 时只 hydrate 该 turn。
- PWA 不渲染横杠 navigator，也不请求大目录。

Codex 可使用增量 byte-range directory；其他 provider 通过 canonical page 构建同构目录。
目录构建必须检测重复 cursor，不能无限循环。

## 7.1 Inspector Resource Index

Outputs/Sources 是 Conversation projection 的派生索引，不依赖 Session 是否由 RAH 启动。
用户仅浏览由 Codex Desktop 或其他 surface 管理的历史 Session 时，daemon 仍从 provider
持久历史按需构建同一索引。

索引使用稳定快照协议：

- 构建中的页只携带 `indexing`，不能逐项发布到 UI。
- 一个 revision 完整构建后原子发布 `stable` snapshot，Outputs/Sources 计数和列表同时切换。
- 新 revision 构建时继续提供 last-good stable snapshot；失败只附加 warning，不清空旧内容。
- 相同 Session 的并发读取共享一次构建，增量 turn fingerprint 只重读发生变化的 turn。
- 磁盘缓存只是重启后的加速层，不是 HTTP 响应完成屏障。
- stable snapshot 先提交到内存并返回，再在后台落盘；同一 Session 等待落盘的多个 revision
  只保留最新版本，避免完整 JSON 写入形成无界队列。
- daemon 正常关闭时 flush 最新待写 snapshot；异常退出最多丢失缓存加速，不丢 provider 历史。

浏览器只观察稳定 snapshot。切换 tab 不触发索引，选中 Session 后的统一预加载管线会在 Chat
可读后启动它。

## 8. Renderer 边界

`WorkbenchSelectedPane -> ChatThread` 是普通 Session 与 Canvas 的共享路径。

`FeedEntry` 只保留为叶子卡片 view model，用于复用消息、工具、权限和 notice 组件：

- 它由 canonical turn/item 生成。
- 只有尚未被 server 接管的 optimistic user item 可以从本地 feed 注入。
- 它不能决定 turn、final、process、duration 或失败状态。

展示规则：

- active turn 的 process 展开。
- terminal turn 的 process 默认折叠。
- final answer 始终位于 process 外。
- output 紧跟所属 final answer。
- task summary 使用底部 dock，不随过程消息滚走；plan、turn 状态和 activity 摘要都来自 canonical
  Conversation projection。

## 9. Resume

历史 Resume 保留当前 canonical turns 和目录：

1. read-only projection 立即保持可见。
2. provider session 启动后只切换 runtime/session identity。
3. live delta 与已有 projection 按 canonical id 合并。
4. 不重新下载已经展示的历史。

同一 provider session 已运行时使用 attach/claim，不启动第二份 runtime。

用户可见操作统一称为 Resume；`claim` 只保留在低层 control lease 和 TUI surface ownership
语义中，不能再次作为历史恢复的 UI 名称。

## 10. Archive

Archive 是 provider-native 持久化状态，不是仅隐藏一行 UI：

- Codex 必须移动/标记 provider thread 的 archived state。
- daemon 目录缓存的 equality key 必须包含 `archived` 与 `archivedAt`。
- Recent 合并时，当前 provider discovery 的 archive 状态具有权威性；记忆的 recency 不能把
  已归档 session 重新显示，也不能把已取消归档 session 继续隐藏。
- Archive 成功后 Chats All/Recent 和左侧工作区必须从同一次目录 revision 收敛。

## 11. Provider 规则

### Codex

- app-server lifecycle/item id 是 live authority。
- subagent activity 是主 turn 的 process item，不能结束主 turn。
- native turn/item paging 可用时用于轻量 summary/detail。
- Resume 固定使用官方 `thread/resume` 的 `excludeTurns: true`，随后通过
  `thread/turns/list` 分页；不支持该协议的旧 app-server 会明确失败，不回退到全量 turns。
- app-server 当前 schema 同时包含 item approval 与 command/file approval 两种返回形状；adapter
  分别翻译为 provider-neutral permission decision，不把 provider-native decision 暴露给 Web API。
- rollout 只在 Codex adapter 内作为持久化证据读取；它不形成第二套客户端协议。

### Claude

- JSONL user/assistant/tool 边界映射 canonical turn。
- `end_turn + turn_duration` 收口完成状态。
- 缺少终态时，只能在后续 user 边界或 settled source 上推导 terminal。
- tmux 只承载 TUI，不是浏览器的结构化事实源。

### OpenCode

- server message/part id 映射 canonical identity。
- RAH 本地提交建立唯一 web-owned turn。
- 迟到 busy/idle 只能更新已有 turn，不能制造空 turn。
- 主动 abort 统一为 interrupted，不受 error/cancel 到达顺序影响。

## 12. 门禁

最低门禁：

```text
npm run typecheck
npm run test:protocol
npm run test:conversation
npm run test:web
npm run test:history-directory
npm run test:runtime
npm run build:web
npm run test:smoke-cleanup
```

真实 provider 门禁：

```text
npm run test:smoke:conversation-providers
```

验收不变量：连续相同输入不能合并；user/process/final 顺序稳定；中断锚定所属 turn；
subagent 不提前 ready；分页不重复；Resume 不清空已展示 projection；长历史首屏保持有界。
