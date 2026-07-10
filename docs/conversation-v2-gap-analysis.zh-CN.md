# Conversation V2 差距分析

状态：当前 `main` 与目标架构的审计结果

复核日期：2026-07-10

## 1. 当前链路

当前结构大致是：

```text
provider live/history
  -> provider-specific translator
  -> flat ProviderActivity
  -> flat RahEvent ledger
  -> client FeedEntry merge
  -> React-side process/final grouping
```

这条链路已经解决了大量实际问题，包括：

- live/history canonical identity
- 同 item upsert
- 轻量 chat history 和按需 tool detail
- rollout 分页
- reasoning/commentary/final phase
- tool/observation 结构化卡片
- assistant process 折叠

这些能力应保留，而不是推倒重来。

## 2. 核心缺口

### Turn 不是协议实体

`runtime-protocol` 里有 `turn.started/completed/failed/canceled` 事件，但没有可读取、可更新、可分页的 canonical `ConversationTurn`。

后果：

- turn 状态散落在多个事件中。
- started/completed 时间没有统一保存。
- 前端无法直接读取权威 duration。
- process group 只能从消息顺序重新推断。

### Process group 在前端临时派生

`assistant-process-groups.ts` 当前通过以下条件分段：

- 可见 user message
- assistant `phase`
- “最后 assistant”兼容集合
- 全局 `generationActive`

这使视图承担了领域逻辑：

- phase 缺失时容易把 commentary 提升为 final。
- subagent 或并发 turn 容易污染 active 判定。
- 时长按用户消息到 final bubble 估算，不等于 provider turn duration。
- history/live 不同到达顺序可能生成不同分组。

### Codex live 与 history 仍是两套重建路线

- Live：`codex-app-server-activity.ts` 约 2,800 行，逐 notification 翻译。
- History：`codex-rollout-activity.ts` 约 2,400 行，逐 JSONL 记录翻译。
- Turn directory：单独 worker 再扫描 rollout。
- Client：`session-store-history.ts` 再负责 live/history 合并与去重。

这些代码不是无价值，但同一语义被重复实现，导致修复往往要同时触碰多层。

### Codex 官方分页（已补齐后端基础）

当前 `thread/resume` 和 external mirror resume 均发送 `excludeTurns: true`，避免 claim/resume
先重建完整 transcript。只读 Conversation V2 接口优先调用 `thread/turns/list(itemsView:
summary)`，保留 native cursor；能力不存在或调用失败时回退 rollout pager。

尚未切换的旧 `/history` API 仍走 rollout pager；`thread/items/list` 的 canonical item detail
寻址也尚未开放。这两项属于后续 renderer/detail 迁移，而不是 resume 阻塞项。

### 新协议事实没有完整进入 RAH

当前 mapper 已保存 item/turn lifecycle 时间。剩余缺口：

- `subAgentActivity`、`sleep` 等新版 item 会落到 unknown。
- 一部分通知进入静态 ignored 列表，没有 capability/version 层解释。

### Flat event 是传输格式，也是视图模型

`RahEvent` 很适合 append-only、WS replay 和诊断，但不适合作为最终 UI read model。现在同一个结构同时承担：

- 原始事实记录
- 去重依据
- 当前状态
- 历史分页单位
- UI 行模型

这迫使前端不断补 merge、dedupe、group 和 fallback。

## 3. 哪些代码保留

- `TimelineIdentity` 与 provider-native identity 映射。
- `RahEvent` append-only ledger 与 WS replay。
- provider command/result classifier。
- tool/observation detail 轻量化与按需加载。
- rollout bounded reader，作为兼容和离线恢复路线。
- Canvas、普通 session、Council 复用的 workbench shell。
- 当前 FeedEntry renderer，可作为 V2 迁移期的 item renderer。

## 4. 哪些逻辑应下沉

从 frontend 下沉到 daemon projection：

- turn 建立与终态收口
- process/final 分离
- duration
- activity batch 分类
- failed item count
- final answer 选择
- subagent 属于哪个主 turn
- compaction 属于哪个 turn

前端只保留：

- expanded/collapsed
- virtualization
- viewport anchoring
- selection/copy
- responsive layout

## 5. 迁移风险

- 老 Codex 版本可能没有 turn/item 分页。
- Claude JSONL 和 OpenCode API 未必有显式 phase。
- rollout 里可能缺少 app-server live 时见过的临时 item。
- 不能在迁移时破坏当前大 session 的轻量 chat page。
- 不能让 V2 与旧 feed 双写产生第二套重复消息。

因此 V2 必须先作为 daemon read model 旁路验证，不能直接替换全部 UI。

## 6. 验收标准

- 相同 provider transcript 无论来自 live、resume snapshot 或 history page，都投影为相同 turn/item identity。
- 一个 subagent 完成不会让主 turn 变 ready。
- process duration 使用 provider 时间；缺失时才回退推断。
- final answer 不会进入 process fold。
- resume 大 session 不要求返回完整 turns。
- 前端不再按文字相等、相邻位置或全局 active 状态决定核心 turn 语义。
