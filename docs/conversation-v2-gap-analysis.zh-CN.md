# Conversation V2 差距分析

状态：当前 `main` 与目标架构的审计结果

复核日期：2026-07-11

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

### Legacy process group 仍在前端临时派生

旧 feed 路径的 `assistant-process-groups.ts` 仍通过以下条件分段：

- 可见 user message
- assistant `phase`
- “最后 assistant”兼容集合
- 全局 `generationActive`

Conversation V2 默认路径已改为直接使用 canonical turn role/status/duration/final identity；以下风险只剩在显式回退的 legacy 路径：

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
summary)`，保留 native cursor；能力不存在或调用失败时回退 rollout pager。native summary
只作为一次性 HTTP baseline，不进入 resident live store。

尚未切换的旧 `/history` API 仍走 rollout pager。Conversation V2 已开放基于 canonical item id
与 opaque provider turn/item id 的详情寻址。过程折叠展开优先使用 `thread/items/list`；当前
Codex 0.144.1 实测不支持该方法，所以降级到 turn directory 的精确 byte range，再压缩大
tool detail 后返回。该降级不会重新扫描或下载整个 rollout。

### 新协议事实覆盖仍需持续维护

当前 mapper 已保存 item/turn lifecycle 时间，并覆盖 `subAgentActivity`、`sleep`；两者都作为主 turn 的内部 process activity，不会影响主 turn 终态。剩余工作是让未来新增 item 先进入受控诊断，再按 capability/version 明确归类，而不是成为用户可见的 unknown 卡片。

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

已从 frontend 下沉到 daemon projection：

- turn 建立与终态收口
- process/final 分离
- duration
- failed item count
- final answer 选择
- subagent 属于哪个主 turn
- compaction 属于哪个 turn

当前仍由共享 UI 层处理、后续可继续协议化的是纯展示级 activity batch（例如连续命令、连续 reasoning 的二级折叠）。它不再决定 turn 或 final answer 事实。

前端只保留：

- expanded/collapsed
- virtualization
- viewport anchoring
- selection/copy
- responsive layout

## 5. 迁移风险

- 老 Codex 版本可能没有 turn/item 分页。
- Claude JSONL 在当前 2.1.207 样本中提供 `stop_reason: end_turn` 与 `turn_duration`，但旧版或
  异常中断日志仍可能缺失；缺失时只能在后续 user 边界或 settled history 中选择最后一个合格答复。
- OpenCode web-owned live turn 必须由 RAH 本地提交生命周期建立，provider 的迟到
  `busy/idle` 只更新已有 turn，不能另造空 turn。
- OpenCode 主动 abort 期间可能先收到 prompt/SSE error；该竞态必须按用户中断归一为
  `turn.canceled`，不能让到达顺序决定 failed/interrupted。
- Codex 独立分页 client 的 persisted snapshot 可能暂时落后于主 live server。对同一
  provider turn，resident live lifecycle 覆盖 HTTP baseline；这个优先级只用于 overlay，
  resident store 内部仍禁止终态被晚到 open event 回退。
- Claude 中断标记可能写在 assistant record，也可能写在 user tool-result 后的 user record；
  两种形态都只产生 derived canceled lifecycle，不生成新的可见用户 turn。
- rollout 里可能缺少 app-server live 时见过的临时 item。
- 不能在迁移时破坏当前大 session 的轻量 chat page。
- 不能让 V2 与旧 feed 双写产生第二套重复消息。
- 默认首屏不能并行双读 V2 与 legacy history。V2 成功即结束加载；仅在 V2 首屏失败时
  才进入 legacy，避免大 session 在弱网下重复传输并消除两套结果的到达竞态。
- resident store 不能吸收 HTTP history baseline；否则一次 rollout fallback 会永久污染后来
  可用的 provider-native summary page。
- resident/history baseline 的内容与 `liveRevision` 必须原子配对；provider paging 等待期间到达的
  live event 不能形成“新内容、旧 revision”的响应。
- resident overlay 必须有界，并只追加历史重叠点之后的 live turn；否则长时间运行的 daemon 会让
  首屏响应随 uptime 增长，甚至把旧 turn 放到最新页末尾。
- Web 已 hydrate 的 turn/item detail 不能被后续 summary delta 清空；summary 只更新生命周期和
  compact 字段，full detail 继续按需驻留在当前浏览器 projection。

因此 V2 先经过 daemon read model 旁路验证，再切为默认 UI。当前默认切换已经完成，legacy
路径保留为显式回退，待稳定观察后再删除。

## 6. 验收标准

- 相同 provider transcript 无论来自 live、resume snapshot 或 history page，都投影为相同 turn/item identity。
- 一个 subagent 完成不会让主 turn 变 ready。
- process duration 使用 provider 时间；缺失时才回退推断。
- final answer 不会进入 process fold。
- resume 大 session 不要求返回完整 turns。
- 前端不再按文字相等、相邻位置或全局 active 状态决定核心 turn 语义。
- `npm run test:smoke:conversation-v2-providers` 在真实 Codex/OpenCode/Claude 上连续通过
  new/tool/resume/interrupt/recovery/replay，且测试 session 可定向清理。
