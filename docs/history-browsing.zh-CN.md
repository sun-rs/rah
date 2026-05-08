# 历史浏览与分页边界

本文锁定 RAH 历史浏览的加载模型，避免后续把“历史回放”“live session”“provider 原始存储”混在一起。

当前 core provider：

- Codex
- Claude
- OpenCode

Gemini/Kimi CLI 一等支持已移除；相关模型通过 OpenCode/API provider 承载。

## 1. 前端加载模型

历史浏览采用：

```text
打开 session -> 加载 tail -> 上滚接近顶部 -> 加载更老一页 -> prepend -> 保持滚动锚点
```

前端页大小：

- `HISTORY_PAGE_LIMIT = 250`

触发条件：

- 打开或选中需要历史的 session 时，调用 `ensureSessionHistoryLoaded`。
- 第一次加载走 `loadOlderHistory`，没有 cursor 时后端返回最近 tail。
- 聊天区向上滚动接近顶部时，如果还有 `nextCursor` 或 `nextBeforeTs`，继续加载 older page。
- 如果当前内容不足一屏，会继续自动加载更早历史，直到填满或没有下一页。

前端合并规则：

- older page prepend 到当前 feed 前面。
- 优先通过 `TimelineIdentity.canonicalItemId` upsert，避免 live/bootstrap 事件与 history replay 重复显示。
- 没有 `canonicalItemId` 的旧事件才退回到 `messageId`、turnId、text/time window 等兼容性去重。
- prepend 前记录 visible anchor，插入后修正 `scrollTop`，保持阅读位置。

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
GET /api/sessions/:sessionId/history?limit=250
GET /api/sessions/:sessionId/history?cursor=...&limit=250
GET /api/sessions/:sessionId/history?beforeTs=...&limit=250
```

后端返回：

- `events`
- `nextCursor`
- `nextBeforeTs`

语义：

- 没有 `cursor/beforeTs`：返回当前 frozen snapshot 的最近 tail。
- 有 `nextCursor`：下一次优先用 cursor。
- 只有 `nextBeforeTs`：provider 使用 timestamp 边界加载更老内容。
- 没有 `nextCursor` 且没有 `nextBeforeTs`：已经到达最早历史。

## 4. 后端 Snapshot 模型

`RuntimeEngine.getSessionHistoryPage` 不直接把 provider 原始历史暴露给前端，而是通过 `HistorySnapshotStore`：

- 首次请求创建 snapshot。
- 如果 provider 提供 frozen loader，则使用 provider-owned frozen paging。
- 如果 provider 没有 frozen loader，则 materialize 当前 events 后用 offset cursor 分页。
- 后续 cursor 在同一 snapshot 内解析，避免文件增长时分页漂移。

frozen snapshot 的目标：

- 打开时冻结。
- 上滚翻页不漂。
- claim/resume 后 live 新内容不污染当前历史浏览。

## 5. Provider 历史来源

| Provider | 历史存储 | 首屏 tail | older page |
| --- | --- | --- | --- |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` 或 wrapper isolated `CODEX_HOME` | 从 rollout 尾部窗口读取并翻译 | line cursor + safe boundary + semantic recent window |
| Claude | `~/.claude/projects/**/*.jsonl` | 从 transcript 尾部窗口读取并翻译 | line cursor + user boundary + semantic recent window |
| OpenCode | OpenCode SQLite message store | 按 message time 读取最近窗口并翻译 | `beforeTs` cursor |

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
