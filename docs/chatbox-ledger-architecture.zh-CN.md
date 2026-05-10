# RAH Chatbox Ledger Architecture

Date: 2026-05-10

本文档定义 RAH Web Chat 的前后端边界。RAH 底层可以同时使用 Codex/OpenCode native local server、Claude zellij、provider history mirror 和本地历史文件分页，但 Web Chat 必须呈现为稳定的传统 chatbox：用户气泡、助手气泡、reasoning、tool、permission、Stop、interrupt/reconnect/status 提示不能重复、错位或漂移。

## 设计目标

- Web Chat 不直接渲染原始 provider/live/history 事件。
- 所有聊天内容先进入统一账本，再由 UI 渲染账本投影。
- 同一条真实消息无论来自 optimistic UI、live event、history mirror、history page 还是 reconnect catch-up，都只能出现一次。
- 两条真实不同消息即使文本相同，也不能被误合并。
- Runtime/chrome 状态不能混入 transcript，避免 reconnect、queued、control required 等提示在对话里漂移。
- Interrupt/abort/failure 这类提示必须绑定到 turn 或气泡 anchor，同一个 anchor 最多一条。

## 成熟项目吸收结论

### Hapi

Hapi 的关键规则是 `localId`。Web 发送前生成 local optimistic message，API 请求携带同一个 `localId`，server echo 仍带回 `localId`，前端按 `id/localId/seq` 合并。RAH 吸收该规则为 `clientMessageId/clientTurnId`，不能继续只靠文本和时间窗口猜测 optimistic echo。

### Paseo

Paseo 的关键规则是每个 session 的 canonical timeline cursor：`epoch + seq`。Live event 是 canonical row 的广播，history/catch-up 也是 canonical row 的查询结果。客户端只接受同 epoch 且连续的 seq；stale 丢弃，gap 触发 catch-up。RAH 当前已有 `canonicalItemId`，下一阶段应增加 per-session `epoch/seq`，让 identity 负责“同一条”，cursor 负责“顺序和缺口”。

### AionUi

AionUi 的关键规则是稳定消息身份与 upsert/edit。流式输出更新同一个 `msg_id`，首个真实内容编辑 thinking placeholder，不把每个 chunk append 成新气泡。RAH 吸收为：assistant/reasoning/tool 必须以 `canonicalItemId/messageId/partId` upsert；错误、中断、取消不应写进助手正文。

## RAH 分层

### Transcript Row

Transcript row 是可出现在 chatbox 里的内容：

- `user_message`
- `assistant_message`
- `reasoning`
- `tool_call`
- `message_part`
- `permission`
- `observation`
- `operation`
- provider 历史中真实存在的错误文本

每个 transcript row 应尽量具备稳定身份：

- 首选 `canonicalItemId`
- 次选 provider `messageId/partId/toolCallId`
- Web optimistic user message 使用 `clientMessageId`
- 无身份内容只能作为 legacy fallback，不能成为主路径

### Anchored Notice

Anchored notice 是属于某个 turn 或某个气泡的提示，不是自由流动的普通 event：

- `turn.canceled`
- `turn.failed` 的轻量提示
- provider abort/interrupted placeholder

规则：

- 优先绑定 `canonicalTurnId`
- 其次绑定 `turnId`
- 再其次绑定用户点击 Stop 时前端记录的 `anchorKey`
- 同一个 anchor 只能存在一条同类型 notice
- 后续 live/history/catch-up 重放只能 update/replace，不能 append 第二条

### Runtime Chrome

Runtime chrome 不进入 transcript：

- reconnect / retry count
- queued input
- control required
- prompt dirty
- runtime status: thinking/idle/failed
- chat mirror missing/failed
- transport disconnected

这些信息只能显示在标题栏、composer notice、toast、status bar 或 inspector 中。

## 当前已落地的 P0 子集

### clientMessageId/clientTurnId

`SessionInputRequest` 已支持：

```ts
{
  clientId: string;
  text: string;
  clientMessageId?: string;
  clientTurnId?: string;
}
```

Web 发送时生成这两个 id：

- `clientMessageId` 绑定用户问题气泡
- `clientTurnId` 绑定这一轮用户可见 turn

前端 optimistic row 使用 `optimistic:user:${clientMessageId}` 作为 key。后续 live/history echo 如果带回同一个 `clientMessageId`，必须替换 optimistic row，而不是新增 row。

Native TUI 路径会记录已注入的 Web 输入；provider mirror 看到同文本 user echo 时，会把 `clientMessageId/clientTurnId` 补进 `timeline.item.added` 的 `user_message` item。这是兼容 native TUI/history mirror 的过渡机制。

## 下一阶段：ChatLedger

当前 `SessionProjection.feed` 仍是数组投影。下一阶段要引入显式 `ChatLedger`：

```ts
type ChatLedger = {
  rowsByKey: Map<string, ChatRow>;
  keyOrder: string[];
  byCanonicalItemId: Map<string, string>;
  byClientMessageId: Map<string, string>;
  byProviderMessageId: Map<string, string>;
  byAnchorKey: Map<string, string>;
  runtimeChrome: RuntimeChromeState;
};
```

事件应用规则：

- `canonicalItemId` 命中：upsert 同一 row。
- `clientMessageId` 命中：替换 optimistic user row。
- `messageId/partId/toolCallId` 命中：upsert 同一 row。
- anchored notice 命中 `canonicalTurnId/turnId/anchorKey`：replace 同一 notice。
- runtime chrome event：只更新 `runtimeChrome`，不创建 row。
- 无身份 transcript event：只允许 append；不得用纯文本全局去重。

## 下一阶段：per-session canonical cursor

RAH 现有 EventBus seq 是全局 transport seq，不足以作为 transcript 顺序真相。后续需要新增每 session cursor：

```ts
type SessionTimelineCursor = {
  epoch: string;
  startSeq: number;
  endSeq: number;
};
```

规则：

- daemon 为每个 session 的 canonical transcript 分配单调 seq。
- live timeline event 带 `timelineSeq/timelineEpoch`。
- history/catch-up 返回同一套 `timelineSeq/timelineEpoch`。
- 前端同 epoch 且 `seq === endSeq + 1` 才直接接收。
- `seq <= endSeq` 丢弃。
- gap 触发 catch-up，不直接渲染。
- epoch reset 触发 authoritative replace。

## 测试要求

所有后续修改必须覆盖以下场景：

- 同一 Web 用户问题 optimistic/live/history echo 只显示一个用户气泡。
- 连续两次发送同文本问题必须显示两个用户气泡。
- assistant streaming 多个 chunk 最终只形成一个助手气泡。
- `turn.canceled` live + history 重放只显示一个 interrupt notice。
- interrupt notice 永远位于被中断 turn 的 anchor 下方。
- reconnect/queued/control/runtime status 不出现在 transcript feed。
- history latest merge 不把旧 assistant 文本合并进无共享身份的 live assistant。
- reconnect/catch-up/event replay 任意重复应用后 feed 收敛。

## 非目标

- 不把 RAH 改成 Hapi/Paseo/AionUi 的 provider runtime。
- 不用纯文本和时间窗口作为主去重逻辑。
- 不把 provider 崩溃、transport retry、control state 写成聊天气泡。
- 不为每个 provider 的偶发提示继续写一次性前端补丁。
