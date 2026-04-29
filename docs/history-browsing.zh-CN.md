# 历史浏览与分页边界

本文锁定 RAH 历史浏览的加载模型，避免后续把“历史回放”“live session”“provider 原始存储”混在一起。

## 1. 前端加载模型

当前五家 CLI 历史浏览都采用：

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
- 通过 entry key 和语义去重，避免 live/bootstrap 事件与 history replay 重复显示。
- prepend 前记录 visible anchor，插入后修正 `scrollTop`，保持阅读位置。

## 2. API 契约

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

## 3. 后端 snapshot 模型

`RuntimeEngine.getSessionHistoryPage` 不直接把 provider 原始历史暴露给前端，而是通过 `HistorySnapshotStore`：

- 首次请求创建 snapshot。
- 如果 provider 提供 frozen loader，则使用 provider-owned frozen paging。
- 如果 provider 没有 frozen loader，则 materialize 当前 events 后用 offset cursor 分页。
- 后续 cursor 在同一 snapshot 内解析，避免文件增长时分页漂移。

frozen snapshot 的目标：

- 打开时冻结。
- 上滚翻页不漂。
- claim/resume 后 live 新内容不污染当前历史浏览。

## 4. 五家 provider 的历史来源

| Provider | 历史存储 | 首屏 tail | older page | 备注 |
| --- | --- | --- | --- | --- |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` 或 wrapper isolated `CODEX_HOME` | 从 rollout 尾部窗口读取并翻译 | line cursor + safe boundary + semantic recent window | 可根据 liveness 收口 EOF pending tool |
| Claude | `~/.claude/projects/**/*.jsonl` | 从 transcript 尾部窗口读取并翻译 | line cursor + user boundary + semantic recent window | `rah claude` 复用原生 `~/.claude` |
| Gemini | Gemini conversation 文件 + RAH sidecar cache | 按 cached canonical event offset 取最近窗口 | offset cursor | cache revision 由 file size / mtime 约束 |
| Kimi | Kimi wire jsonl | 从 wire 文件尾部窗口读取并翻译 | line cursor + TurnBegin/SteerInput boundary | `default/yolo` 影响 live client，不影响历史读取 |
| OpenCode | OpenCode SQLite message store | 按 message time 读取最近窗口并翻译 | `beforeTs` cursor | 每页会重新翻译 message window 成 canonical events |

## 5. Tail first 的原因

历史 session 通常很长。直接全量加载会造成：

- daemon 首次 materialize 成本高。
- Web store 和 React feed 过大。
- iOS / iPad 打开长历史明显卡顿。
- live projection 与 history replay 更容易重复或错序。

Tail first 更符合真实使用：

- 打开时先看最近上下文。
- 需要追溯时再向上翻。
- Provider 原始文件增长时也能通过 frozen snapshot 稳定翻页。

## 6. Read-only replay 与 claim

打开历史 session 默认是 read-only replay：

- 可浏览。
- 不可直接输入。
- 不算 live。
- 不算 provider 写手。

点击 claim/resume 后：

- daemon 使用对应 provider adapter 拉起 live session。
- 当前 provider history 可以作为 live session 初始上下文或 replay 来源。
- 如果已有 frozen snapshot，runtime 可以 transfer，避免 claim 前后历史抖动。

## 7. History Recent 列表

History 弹窗的 `Recent` 不是“RAH 曾经 claim 过”的列表，而是全局最近使用列表：

- 候选来自当前可见的 provider history、RAH 记住的 previous live、以及当前 live session。
- 按 `lastUsedAt ?? updatedAt ?? createdAt` 全局倒序排序，取前 15 个。
- 同一个 provider session 去重；如果同时有 provider history 和 previous live，优先使用 provider history 的标题、预览、工作区等元数据，同时保留更近的使用时间。
- hidden session / hidden workspace 仍然不显示。
- 纯 read-only replay 不会被当作写手或 live，但它对应的 provider history 仍可因为真实最近使用时间进入 `Recent`。

这个边界保证：野生 TUI、原生 CLI 或其他非 RAH 拉起的 session，只要 provider 历史里显示最近被使用，也会进入 `Recent`。

## 8. Live / external live / closed history

历史读取必须避免两类误判：

- 已经结束的旧历史，pending tool 永久显示 Running。
- 仍有野生 TUI 或 RAH wrapper 在写，Web 把它误判为 closed。

边界：

- RAH 管理绑定：live。
- RAH terminal wrapper：live。
- provider 文件有外部活跃写手：external live。
- Web 只读打开历史：不算 live。
- 无 RAH 写手、无活跃外部写手、文件稳定：closed history。

Codex 的详细规则见 [Codex 历史 liveness 与 pending tool 收口边界](./codex-history-liveness.zh-CN.md)。

## 9. UI 失败模式与排查

如果打开长历史只看到最近一段，无法继续到第一条消息，优先检查：

- `selectedProjection.history.nextCursor` / `nextBeforeTs` 是否还存在。
- `selectedProjection.history.phase` 是否卡在 `loading`。
- `ChatThread` 的 `loadingOlderRef` 是否释放。
- 滚动区域是否触发 `onLoadOlderHistory`。
- 后端 `/history?cursor=...` 是否能连续返回直到没有 cursor。

如果后端连续分页能到第一条用户消息，而 UI 到不了，问题在前端滚动触发/锁释放/虚拟化锚点。

如果后端也到不了，问题在 provider frozen loader、cursor 或原始历史 catalog。

## 10. Markdown 与结构化输出

历史翻译时必须保留 provider 原始 assistant text 的结构：

- 换行
- 列表
- 缩进
- fenced code block
- markdown paragraph

过滤 provider control fragment 时，只能删除明确的标签块或内部事件，不能压平空白。尤其不能对最终 assistant text 做全局：

```ts
text.replace(/\s+/g, " ")
```

否则会导致列表和代码块全部挤成一行。

## 11. 回归检查

每次修改 history loader / markdown filter / feed virtualization 后，至少手动检查：

- Codex 长历史能从 tail 上滚到第一条用户消息。
- Claude / Gemini / Kimi / OpenCode 历史首屏不是 assistant-only 截断。
- 上滚加载 older page 后当前阅读位置不跳。
- iOS Safari / PWA 上能继续触发 older page。
- 被中断的 tool 不永久显示 Running。
- `<turn_aborted>` 等内部上下文不会作为 assistant 正文显示。
- Markdown 列表、代码块、分段在五家 provider 中都保持结构。
