# RAH Conversation V2 架构

状态：批准的目标架构；Phase 0-4 已落地，Conversation V2 已默认开启并保留显式回退

复核日期：2026-07-11

## 1. 目标

Conversation V2 的目标不是让 RAH 变成 Codex Desktop 克隆，而是建立 provider-neutral 的 turn-first conversation read model：

- Codex 使用官方 app-server 的结构事实。
- Claude、OpenCode 映射到同一模型。
- Council 继续作为多个 session 之上的协调能力。
- Canvas 与普通页面消费同一 projection。
- Web、PWA、局域网和 Tailscale 看到同一 daemon 状态。

## 2. 分层

```text
Provider evidence
  -> Adapter normalization
  -> Append-only RahEvent ledger
  -> Conversation projector
  -> ConversationTurn read model
  -> HTTP/WS page and delta protocol
  -> Shared chat renderer
```

每层只有一个职责：

### Provider evidence

- Codex app-server notifications/pages
- Claude JSONL
- OpenCode server/session API
- 兼容时的 rollout/db evidence

### Adapter normalization

只做 provider union 到 canonical item/lifecycle 的映射，不决定 UI 是否折叠。

### RahEvent ledger

保留 append-only 传输、诊断、replay 和调试价值。它不是最终 UI 模型。

### Conversation projector

按 canonical identity upsert event，构建权威 thread/turn/item 状态。

### Read model

前端读取 turn page，不再从 flat feed 重建核心语义。

## 3. Canonical 模型

建议新增以下协议实体：

```ts
type ConversationTurnStatus =
  | "in_progress"
  | "completed"
  | "interrupted"
  | "failed";

interface ConversationTurn {
  id: string;
  providerTurnId?: string;
  status: ConversationTurnStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  userItems: ConversationItem[];
  process: ConversationProcess;
  finalAnswer?: ConversationItem;
  usage?: ContextUsage;
  error?: ConversationError;
  revision: number;
}

interface ConversationProcess {
  state: "active" | "completed" | "interrupted" | "failed";
  entries: ConversationItem[];
  batches: ActivityBatch[];
  failedItemCount: number;
}
```

`ConversationItem` 应覆盖语义，而不是 provider 名称：

- user message
- assistant commentary
- final answer
- reasoning
- plan
- command
- file change
- tool call
- web activity
- subagent activity
- compaction
- approval
- notice/error

每个 item 至少包含：

- canonical id
- provider id
- turn id
- kind
- lifecycle state
- started/completed time
- compact summary
- detail availability
- source authority

## 4. 权威顺序

同一 Codex turn 的证据优先级：

1. app-server completed item / completed turn
2. app-server live started/delta
3. app-server history page
4. rollout persisted record
5. RAH heuristic fallback

优先级只解决冲突，不制造重复 item。`origin` 不能进入 canonical identity。

其他 provider 也遵守同一原则：provider-native 稳定 id 优先，文件位置和内容 hash 只作为兼容线索。

## 5. Final answer 规则

1. 显式 `final_answer` 最优先。
2. completed turn 内 provider 标记的 terminal assistant item 次之。
3. phase 缺失时，允许 adapter 在 turn completed 后选择最后一个合格 assistant message。
4. in-progress turn 不得仅凭“当前最后一个 assistant message”宣布 final。
5. subagent 的 final answer 仍是 subagent activity，不是主 turn 的 final answer。

## 6. Process fold 规则

- active turn：process 默认展开。
- completed/interrupted turn：process 默认折叠。
- final answer 永远在 process 外。
- process header 显示 provider turn duration。
- 同类连续 activity 可形成二级 batch。
- failure 只影响对应 item；只有 turn status failed 才把整个 turn 标为 failed。

## 7. 历史 API

建议新增 provider-neutral 接口：

- `GET /api/sessions/:id/conversation/turns`
- `GET /api/sessions/:id/conversation/turns/:turnId/detail`
- `GET /api/sessions/:id/conversation/items/:itemId/detail`

turn page 返回：

- 最近 turn 优先
- cursor
- items view: summary/full
- revision
- approximate bytes

Live delta 通过现有 WS 增加 turn/item projection delta，不再让浏览器接收全量 projection。

具体同步协议：

- daemon 常驻 `ConversationProjectionStore`，保存 canonical turn/item projection。
- `revision` 表示 projection 内容缓存版本；`liveRevision` 只随实时 canonical 变化递增，历史分页扩展不改变它。
- HTTP turn page 返回当前 `liveRevision`，作为客户端实时同步基线。
- WS delta 携带 `baseRevision -> revision`、变化的 turn metadata 和 item upsert/remove，不传整个历史。
- 客户端只应用与本地 `liveRevision` 严格连续的 delta；重复 revision 直接忽略。
- delta 乱序时先短暂保留，缺失 revision 到达后连续合并。
- revision 真正断档或 replay window 缺失时，保持当前画面并只做一次 HTTP baseline refresh；不使用定时轮询。
- 尚未打开 V2 的 session 不在浏览器积累 delta；首次打开时由 HTTP page 直接建立最新基线。
- daemon resident store 只保存实时 projection，不把 HTTP 历史页重新写入常驻 store；
  返回最近页时仅把 resident live delta 覆盖到一次性 history baseline 上。
- native summary turn 只包含用户问题、最终答复和 turn lifecycle；用户展开 `Worked ...`
  时才按 turn 加载过程项。已 hydrate 的 turn 在普通 Session 与 Canvas 间复用，不重复请求。

## 8. Codex 接入策略

### 新建

- `thread/start`
- `turn/start`
- notification 进入 projector

### 历史浏览

- metadata 先展示页面骨架
- 优先 `thread/turns/list(itemsView: summary)`
- 打开 turn 时优先 `thread/items/list` 加载 full items；协议不可用时只读取 rollout 中该
  turn directory 对应的 byte range，并先做 summary compaction 再返回
- 打开单个 tool detail 时继续使用 opaque provider turn/item id 寻址

### Resume

- capability 支持时使用 `excludeTurns: true` 或 `initialTurnsPage`
- 已在浏览器展示的 turn projection 不清空
- live subscription 建立后按 revision 合并，不重新全量拉取
- 不支持新能力时回退当前 rollout pager

## 9. Provider 映射

### Claude

- JSONL 中 user/assistant/tool 边界映射为 turn。
- `assistant.message.stop_reason === "end_turn"` 映射 final answer；`system/turn_duration`
  映射 derived `turn.completed` 与 provider duration。
- 缺少上述终态记录时，只有在后续 user 边界或已停止的 settled history 中才推导 final，不能把
  live 尾部 assistant 文本提前视为完成。
- tmux 只承载 TUI，不作为结构化 conversation source。

### OpenCode

- server/session API 是 live truth。
- provider session/message/part id 映射 canonical identity。
- variant/model 属于 turn runtime metadata，不进入消息文本。

### Council

- Council 自身继续维护协调消息。
- agent session 的 ConversationTurn 不复制进 Council chat。
- Council agent TUI 和普通 session TUI 共享 surface/lifecycle，但不改变 conversation projection。

## 10. 落地顺序

当前实现进度（2026-07-11）：

- 已定义 provider-neutral `ConversationTurnProjection` / `ConversationItemProjection`。
- 已实现纯 `RahEvent -> ConversationProjection` projector。
- 已修正 Claude 同轮 user/assistant canonical turn identity。
- 已保存 Codex turn/item lifecycle timing。
- 已让 Codex resume 与 external mirror 使用 `excludeTurns: true`。
- 已接入 `thread/turns/list(itemsView: summary)`，旧版本自动回退 rollout pager。
- 已提供只读 `GET /api/sessions/:id/conversation/turns`，并在实验路径中驱动共享 renderer。
- 已接入实验性 `thread/items/list`，并以 canonical item id + opaque provider turn/item id 校验详情响应；不支持该协议时保留 legacy detail 回退。
- 已增加 turn-level lazy detail：native item paging 可用时使用官方 items；当前实测 Codex
  0.144.1 返回 `thread/items/list is not supported yet`，因此自动使用目标 turn 的 bounded
  rollout byte range，而不是扫描或传输整个 session。
- daemon resident projection 已和历史 baseline 分离：structured server 的 persisted replay
  不进入 live store；Claude 一类非 structured JSONL runtime 仍允许新增 persisted records
  进入 live store。
- resident store 只保留最近 64 个 settled/live turn，并始终保留未完成 turn；HTTP baseline
  与 resident 有重叠时，只追加最后一个重叠 turn 之后的 live turn，避免 daemon 长时间运行后
  把更老 resident turn 追加到历史首页末尾或放大弱网响应。
- Web store 已支持 V2 最近页、向上分页、revisioned WS delta、断档基线恢复与 item detail 缓存。
- 同一 session 的 resident/history page 请求在 Web store 中串行；状态明确记录 `live` 或
  `history` scope，因此并发首屏不会误判 V2 失败并触发 legacy 双读。已加载的 full turn 或单项
  tool detail 在 summary refresh 与 live delta 后继续保留，生命周期字段仍以新 delta 为准。
- 默认首屏按 V2-first 顺序加载：先请求 canonical 最近页，成功后不再并行读取 legacy
  history；只有 V2 不可用或首屏失败时才进入 legacy 回退。向上分页和最新页刷新同样只走
  当前已经选定的路径，避免同一 transcript 的双重网络传输与竞态覆盖。
- 新建 live session 在发送首条输入前使用 `liveOnly` 初始化 resident V2 projection；该请求不触发
  provider history paging，且首条输入会等待该轻量基线完成。普通 session event 更新必须保留已建立的 V2 projection 与 turn directory，
  因此 interrupt、status 和 metadata 事件不会让页面临时退回 legacy renderer。
- history Resume/claim 在 runtime id 切换时保留已经展示的 V2 turns 与 turn directory；新建 live
  projection 只补运行状态，不会把用户正在看的历史画面替换为空 projection。
- canonical item detail 优先使用 provider-native API；不可用时从 daemon 的完整 EventBus/history
  detail cache 回读并投影到同一 canonical item，Claude/OpenCode 不会只更新已隐藏的 legacy feed。
- 普通 Session 与 Canvas 通过同一个 `WorkbenchSelectedPane -> ChatThread` 消费 V2 feed adapter，没有新建 Canvas 专用渲染器。
- `ChatThread` 在 V2 路径中直接使用 canonical turn 的 role、status、duration、failed item count 和 final answer identity 构建 process/final 行；`FeedEntry` 只作为现有叶子卡片的迁移期渲染契约，不再决定 V2 的核心分组语义。
- Conversation V2 默认开启。`?conversationV2=0` 或
  `localStorage["rah.experimental.conversationV2"] = "0"` 可显式回退 legacy 路径；`1` 可覆盖本地回退。
- 已增加 Codex、Claude、OpenCode 同构 projection tests。
- 已分别真实启动 Codex 0.144.1、OpenCode 1.15.13、Claude 2.1.207，经 RAH 提交独立
  smoke turn，再从 Conversation V2 HTTP 与共享 Web renderer 验证 user/final/status/duration，
  最后通过 RAH close 清理 live runtime。
- Codex 与 OpenCode 的完成状态来自 native server；Claude 的完成状态来自 JSONL
  `end_turn + turn_duration`，因此在公共协议里仍标记 `statusAuthority: derived`。
- 已增加 `npm run test:smoke:conversation-v2-providers` 真实 provider 门禁。Codex、OpenCode、
  Claude 依次执行新建、精确回复、shell tool、close、无历史 resume、主动 interrupt、恢复回复、
  stored-history replay，并只清理本次测试创建的 session。
- 三 provider 连续门禁结果一致：每家 4 个 completed turn、1 个 interrupted turn；Codex/
  OpenCode 为 native lifecycle，Claude 为 derived lifecycle。工具事实也在 live/detail 路径完成验证。
- live/history 重叠时，resident live stream 对当前 turn lifecycle 具有优先权。独立 Codex
  分页 app-server 短暂返回的旧 `interrupted` 快照不会再覆盖正在输出的 in-progress turn；
  resident store 内部仍维持终态单调。
- HTTP history 解析可能等待 provider I/O；返回前由 resident store 一次性生成 overlay 与
  `liveRevision`，保证响应内容和 revision 来自同一个 event-loop 状态，避免 WS 误报缺口或重复回放。
- Claude 的 `[Request interrupted by user ...]` user/assistant JSONL 占位记录只映射为
  canonical `turn.canceled`，不会成为新的用户消息或可见占位气泡。
- OpenCode abort 请求与 prompt/SSE error 的竞态统一收口为 `turn.canceled`；用户主动中断不再
  随事件先后随机显示为 failed。
- OpenCode web-owned turn 不再允许迟到的 provider `busy` 另建空 turn；RAH 本地提交建立的
  turn 是该输入唯一的 live turn owner。
- OpenCode 只读 replay 与 Codex/Claude 一样使用 `stored_history` runtime descriptor，不再因
  provider 默认 backend 被误标为 `native_local_server`；因此 live/history 接纳策略不依赖
  UI capability 的间接推断。
- 已覆盖 Codex 官方 `subAgentActivity` 与 `sleep` item；它们投影为主 turn 内部 process activity，不会生成 unknown 卡片或提前结束主 turn。
- daemon resident store 已订阅 append-only EventBus，并通过现有 `/api/events` WebSocket 同帧发送 canonical projection delta；旧的前端 250ms HTTP 刷新已移除。
- 旧 renderer 暂时只作为显式回退路径保留；删除旧 final/process 推断需经过默认路径稳定观察，
  不再阻塞 Conversation V2 默认启用。

本轮真实数据基线：

- 2.5 MB Codex audit rollout：summary 首屏 39.3 KB / 58 ms；单个 21m46s turn 展开
  211 KB / 96 ms，190 个 compact item；大工具输出未回传。
- 约 803 MB Codex session：最近 20 turns 为约 73.5 KB；向上分页保持滚动锚点。
- 1.2 KB OpenCode 历史：canonical turn page 2.8 KB / 9 ms。

### Phase 0：协议夹具

- 固定 Codex live/history/subagent/compaction fixtures。
- 为 Claude/OpenCode 增加最小同构 fixtures。
- 定义 projection conformance tests。

### Phase 1：Codex 官方分页

- capability probe。
- resume 使用 `excludeTurns/initialTurnsPage`。
- history 优先 `thread/turns/list`。
- 保留 rollout fallback。

### Phase 2：daemon projector

- 新增 ConversationTurn store/reducer。
- flat RahEvent 与 canonical projection delta 同帧传输，前者继续承担诊断、兼容和 unread 事件语义。
- 比较旧 FeedEntry 与 V2 turn projection。

### Phase 3：V2 renderer

- 在 feature flag 下让普通 session 与 Canvas pane 复用同一会话外壳；V2 turn 直接决定 process/final 分组，既有 `FeedEntry` 仅复用消息、工具、权限等叶子渲染，避免复制滚动、虚拟化和权限交互。
- 最近页 HTTP baseline 与 WS delta 使用单调 `liveRevision` 合并；只在 revision gap 时刷新一次基线。
- 折叠状态只留在前端。
- 验证 mobile、iPad、desktop、长 session 和 reconnect。

### Phase 4：多 provider

- Claude/OpenCode 接入 projector。
- Council agent session 使用同一 read model。

### Phase 5：删除旧推断

- 删除前端 final/process 核心启发式。
- 精简 live/history merge 补丁。
- 保留 flat event inspector 作为诊断工具。

## 11. 非目标

- 不把 Desktop 私有 bundle 复制进 RAH。
- 不在第一阶段重写所有 ToolCard/Markdown/UI。
- 不移除 TUI surface。
- 不让 Codex-only 字段污染公共协议。
- 不为了“统一”而丢失 provider-native 权威 id 和状态。

## 12. 完成定义

Conversation V2 完成时应满足：

- live/history/resume 共享同一个 projector。
- 大 Codex session resume 不全量返回历史。
- process fold 与 final answer 由 turn 模型决定。
- subagent 不会提前结束主 turn。
- Canvas 和普通 session 没有独立 conversation 逻辑。
- 页面重连只补 revision/delta，不重新下载已拥有内容。
- Claude/OpenCode 不需要复制一套前端分组规则。
