# 历史浏览与分页边界

本文锁定 RAH 历史浏览的加载模型，避免后续把“历史回放”“live session”“provider 原始存储”混在一起。

当前 core provider：

- Codex
- Claude
- Gemini
- OpenCode

Gemini CLI 已恢复为 `tui_mux` provider，历史浏览读取 `~/.gemini/tmp/**/chats/session-*.json`。Kimi CLI 一等支持仍移除；相关模型通过 OpenCode/API provider 承载。

## 1. 前端加载模型

RAH 把“live 同步”和“旧历史分页”拆成两条不同路径，不能混用：

```text
live/new/current -> provider event/client push -> silent latest-tail sync fallback
read-only history/up-scroll -> load older page -> prepend -> keep scroll anchor
```

前端页大小：

- `HISTORY_PAGE_LIMIT = 60`

### 1.1 新建 live session

新建 live session 的首要数据源是当前 provider runtime：

- Codex/OpenCode：native local-server event/client push。
- Claude/Gemini：tmux/TUI fallback + provider transcript mirror。

新建 live session 不应触发可见的 older-history 加载，也不应在顶部显示 `Loading older history`。创建时 feed 可以为空，然后由 optimistic user message、provider live event、provider transcript mirror 逐步填充。

如果兼容路径需要在拿到 `providerSessionId` 后做一次 backfill，只能走 `refreshLatestHistory`，并且必须是静默 latest-tail sync：不设置 `history.phase = "loading"`，不展示 loading 文案，不阻塞 live event。

### 1.2 选中已有 live session

用户从左侧 live list、Sessions 弹窗、Canvas pane 选中一个已经存在的 live session 时，应触发一次静默 latest-tail sync：

- 调用 `ensureSessionHistoryLoaded`。
- 对非 read-only replay，`ensureSessionHistoryLoaded` 必须路由到 `refreshLatestHistory`。
- `refreshLatestHistory` 读取 provider 当前最近 tail，并通过 `mergeLatestHistoryPage` 与现有 feed 合并。
- 这一步用于补齐用户离开页面、浏览器 reload、PWA 切后台期间错过的已提交消息。

这不是 older-history paging，因此不能改变滚动锚点语义，也不能显示 `Loading older history`。

### 1.3 正在观察当前 Chat

当用户停留在某个 Chat 页面时，最新消息应该由 live source 主动进入 UI：

- Codex/OpenCode 优先使用 native local-server 的结构化 event/client push。
- Claude fallback 优先使用 provider transcript mirror。
- `refreshLatestHistory` 只是恢复性兜底，用于 focus/reload/network gap 后把 provider 文件或 DB 中已经落盘的 tail 补回来。

硬约束：

- live/native-mirror event 不能被 history bootstrap 挡住。
- history 正在加载时可以推迟 older-page 合并，但不能隐藏已经到达的 live reply。
- latest-tail sync 只能 merge/upsert，不能把已有 live feed 整体替换成另一套顺序。

### 1.4 只读历史与向上翻页

只有以下场景才是 older-history paging：

- 打开一个 read-only replay 历史 session 的首次历史页。
- 用户在 Chat 中向上滚动接近顶部。
- 当前内容不足一屏时，自动继续加载更早历史直到填满或没有下一页。

older-history paging 使用 `loadOlderHistory`：

- 没有 cursor 时后端返回当前 frozen snapshot 的最近 tail。
- 有 `nextCursor` 或 `nextBeforeTs` 时加载更老一页。
- 页面 prepend 到当前 feed 前面。
- prepend 前记录 visible anchor，插入后修正 `scrollTop`，保持阅读位置。
- 这条路径可以设置 `history.phase = "loading"`，也只有这条路径可以显示 `Loading older history`。

### 1.5 合并规则

前端合并规则：

- latest-tail 使用 `mergeLatestHistoryPage`，语义是“补当前尾部缺失消息”。
- older page 使用 `prependHistoryPage`，语义是“向前扩展历史窗口”。
- 优先通过 `TimelineIdentity.canonicalItemId` upsert，避免 live/bootstrap event 与 history replay 重复显示。
- 没有 `canonicalItemId` 的旧事件才退回到 `messageId`、turnId、text/time window 等兼容性去重。
- `origin` 不参与 canonical key；连续两次相同文本的真实消息不能因为 text hash 被合并。

## 2. Timeline Identity

硬约束：

- 同一个 provider item 无论来自 live 还是 history，必须生成同一个 `canonicalItemId`。
- 两个真实不同的 item 即使文本完全一样，也必须有不同 `canonicalItemId`。
- `origin`、`sourceCursor`、`contentHash` 都是证据或 metadata，不参与主 key。
- adapter 必须把 provider 原生 message id、文件行/byte offset、SQLite row id、turn ordinal/part index 映射成 `turnKey + itemKey`。
- 无法证明稳定时宁可不生成 identity，也不能用全文 hash 冒充主身份。

当前 provider identity 策略：

| Provider | 主身份来源 | 说明 |
| --- | --- | --- |
| Codex | `providerSessionId + turnId + per-turn itemIndex` | app-server live 与 rollout history 都可从 turn 上下文派生同序 item index；origin 不进 key。 |
| Claude | `sessionId + record uuid` | Claude transcript / SDK assistant 消息有稳定 uuid；用户 live 输入无 provider uuid 时不强行猜。 |
| OpenCode | `sessionId + messageId + partId` | OpenCode SQLite / ACP 都有 message/part 结构，reasoning 与 assistant text 分 part 区分。 |

## 3. API 契约

前端通过：

```text
GET /api/sessions/:sessionId/history?limit=60
GET /api/sessions/:sessionId/history?cursor=...&limit=60
GET /api/sessions/:sessionId/history?beforeTs=...&limit=60
GET /api/sessions/:sessionId/history/detail?kind=tool_call&itemId=...
GET /api/sessions/:sessionId/history/detail?kind=observation&itemId=...
```

后端返回：

- `events`
- `nextCursor`
- `nextBeforeTs`
- `detailMode`
- `approximateBytes`

语义：

- 没有 `cursor/beforeTs`：返回当前 frozen snapshot 的最近 tail。
- 有 `nextCursor`：下一次优先用 cursor。
- 只有 `nextBeforeTs`：provider 使用 timestamp 边界加载更老内容。
- 没有 `nextCursor` 且没有 `nextBeforeTs`：已经到达最早历史。
- `history` 默认返回 `detailMode = summary`，用于 Chat 首屏和 older-page 浏览；summary 事件必须剥离 provider `raw`、大 `toolCall.detail`、大 `toolCall.input/result`、大 `observation.detail`。
- summary 中的 `ToolCall` / `WorkbenchObservation` 可以带 `detailAvailable` 和 `detailSizeBytes`。用户展开工具卡片时，前端再调用 `/history/detail` 拉取该 tool / observation 的完整 cached events，并合并回当前 projection。
- `/history?detail=full` 只保留给调试或内部验证；普通 Chat UI 不应使用 full history 首屏。

## 4. 后端 Snapshot 模型

`RuntimeEngine.getSessionHistoryPage` 不直接把 provider 原始历史暴露给前端，而是通过 `HistorySnapshotStore`：

- 首次请求创建 snapshot。
- 如果 provider 提供 frozen loader，则使用 provider-owned frozen paging。
- 如果 provider 没有 frozen loader，则 materialize 当前 events 后用 offset cursor 分页。
- 后续 cursor 在同一 snapshot 内解析，避免文件增长时分页漂移。
- Snapshot cache 保存 full events；HTTP history 响应在返回前投影成 summary。这样首屏 payload 足够小，但 `/history/detail` 仍能从 cache 中找回完整工具输出。

frozen snapshot 的目标：

- 打开时冻结。
- 上滚翻页不漂。
- claim/resume 后 live 新内容不污染当前历史浏览。

## 5. Provider 历史来源

| Provider | 历史存储 | 首屏 tail | older page |
| --- | --- | --- | --- |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` / `~/.codex/archived_sessions/**/rollout-*.jsonl` | 从 rollout 尾部窗口读取并翻译 | line cursor + safe boundary + semantic recent window |
| Claude | `~/.claude/projects/**/*.jsonl` | 从 transcript 尾部窗口读取并翻译 | line cursor + user boundary + semantic recent window |
| OpenCode | OpenCode SQLite message store | 按 message time 读取最近窗口并翻译 | `beforeTs` cursor |

RAH 不再创建或扫描 provider-specific 独立 home。Codex / Claude 历史发现只读取 provider 原生 home；旧隔离目录数据需要先迁移回原生目录，才会继续出现在 RAH 历史里。

## 6. Tail First 的原因

历史 session 通常很长。直接全量加载会造成：

- daemon 首次 materialize 成本高。
- Web store 和 React feed 过大。
- iOS / iPad 打开长历史明显卡顿。
- live projection 与 history replay 更容易重复或错序。

Tail first 更符合真实使用：

- 打开时先看最近上下文。
- 需要追溯时再向上翻。
- Provider 原始文件增长时也能通过 frozen snapshot 稳定翻页。

## 7. Read-only Replay 与 Claim

打开历史 session 默认是 read-only replay：

- 可浏览。
- 不可直接输入。
- 不算 live。
- 不算 provider 写手。
- 从 Chats / Recent / All 打开历史时，前端应在同一 UI 批次内关闭弹窗并选中 read-only projection；不应先让主 workbench 在弹窗背后切换、下一帧再关闭弹窗，否则会表现成整页闪烁。

点击 claim/resume 后：

- daemon 使用对应 provider launch/resume spec 拉起 live native TUI session。
- 当前 provider history 可以作为 live session 初始上下文或 replay 来源。
- 如果已有 frozen snapshot，runtime 可以 transfer，避免 claim 前后历史抖动。

## 8. 回归检查

每次修改 history loader / markdown filter / feed virtualization 后，至少检查：

- Codex 长历史能从 tail 上滚到第一条用户消息。
- Claude / OpenCode 历史首屏不是 assistant-only 截断。
- 上滚加载 older page 后当前阅读位置不跳。
- iOS Safari / PWA 上能继续触发 older page。
- 被中断的 tool 不永久显示 Running。
- `<turn_aborted>` 等内部上下文不会作为 assistant 正文显示。
- Markdown 列表、代码块、分段在 core provider 中都保持结构。
