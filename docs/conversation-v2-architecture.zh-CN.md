# RAH Conversation V2 架构

状态：批准的目标架构；Phase 0-2 后端基础已落地，旧 UI 尚未切换

复核日期：2026-07-10

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
- `GET /api/sessions/:id/conversation/turns/:turnId`
- `GET /api/sessions/:id/conversation/items/:itemId/detail`

turn page 返回：

- 最近 turn 优先
- cursor
- items view: summary/full
- revision
- approximate bytes

Live delta 通过现有 WS 增加 turn/item projection delta，不再让浏览器接收全量 projection。

## 8. Codex 接入策略

### 新建

- `thread/start`
- `turn/start`
- notification 进入 projector

### 历史浏览

- metadata 先展示页面骨架
- 优先 `thread/turns/list(itemsView: summary)`
- 打开 turn 或 tool detail 时再加载 full item/detail

### Resume

- capability 支持时使用 `excludeTurns: true` 或 `initialTurnsPage`
- 已在浏览器展示的 turn projection 不清空
- live subscription 建立后按 revision 合并，不重新全量拉取
- 不支持新能力时回退当前 rollout pager

## 9. Provider 映射

### Claude

- JSONL 中 user/assistant/tool 边界映射为 turn。
- 缺少显式 phase 时只在 turn 终态选择 final。
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

当前实现进度（2026-07-10）：

- 已定义 provider-neutral `ConversationTurnProjection` / `ConversationItemProjection`。
- 已实现纯 `RahEvent -> ConversationProjection` projector。
- 已修正 Claude 同轮 user/assistant canonical turn identity。
- 已保存 Codex turn/item lifecycle timing。
- 已让 Codex resume 与 external mirror 使用 `excludeTurns: true`。
- 已接入 `thread/turns/list(itemsView: summary)`，旧版本自动回退 rollout pager。
- 已提供只读 `GET /api/sessions/:id/conversation/turns`，尚未替换旧 renderer。
- 已增加 Codex、Claude、OpenCode 同构 projection tests。
- `thread/items/list`、WS projection delta 和 V2 renderer 仍待后续阶段。

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
- flat RahEvent 继续双写，但 UI 尚不切换。
- 比较旧 FeedEntry 与 V2 turn projection。

### Phase 3：V2 renderer

- 在 feature flag 下让普通 session 与 Canvas pane 复用同一 turn renderer。
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
