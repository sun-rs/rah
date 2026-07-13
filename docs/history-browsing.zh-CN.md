# Conversation 历史浏览与分页边界

复核日期：2026-07-13

## 1. 唯一读取模型

历史与 live 使用同一个 `ConversationTurnProjection`。区别只在数据到达方式：

```text
live       -> resident projection + WS deltas
history    -> canonical tail page + older cursor pages
resume     -> displayed history + resident live overlay
```

不存在浏览器 flat-event history fallback。

## 2. 首屏

打开 running 或 stopped session 时先用 session metadata 构建 workbench shell，再读取最近
canonical turns：

```text
GET /api/sessions/:sessionId/conversation/turns?limit=20
```

规则：

- 请求期间保留 shell，不白屏、不跳 New。
- 新建 live session 可使用 `liveOnly=true`，不触发 provider 历史扫描。
- summary page 不携带大工具输出。
- 出错时显示 Retry，不切换原始 events renderer。

## 3. 向上分页

`nextCursor` 存在时，Chat 接近顶部自动请求更早 turns：

```text
GET /api/sessions/:sessionId/conversation/turns?cursor=...&limit=20
```

prepend 前记录可见 canonical row anchor；合并后通过 virtual layout 投影新的 `scrollTop`，再做
像素校准。加载过程不能要求用户先下滚再上滚来“重新触发”。

cursor 是 opaque：

- 客户端不解析。
- provider 文件增长不能改变已打开 snapshot 的旧页边界。
- provider 重复返回同一 cursor 时 daemon 停止目录扫描，避免死循环。

## 4. Detail hydration

summary turn 只保留 user、final、lifecycle 和 compact process metadata。用户展开 Worked 时：

```text
GET /api/sessions/:sessionId/conversation/turns/:turnId/detail
```

单个工具卡展开时：

```text
GET /api/sessions/:sessionId/conversation/items/:itemId/detail
```

请求携带 opaque `providerTurnId/providerItemId`。full detail 合并后不得被后续 summary page 或
live delta 降级。

## 5. Turn Directory

长历史目录独立于正文窗口：

```text
GET /api/sessions/:sessionId/conversation/directory
```

目录只返回：

- turn id 与 ordinal
- user/final bounded preview
- status 与时间
- source revision

desktop 浏览器显示完整 navigator；PWA 禁用该 navigator，避免下载大目录。点击未加载 turn 时
只 hydrate 该 turn，不顺序下载此前所有正文。

## 6. Live overlay

历史 page 请求可能等待 provider I/O。daemon 必须在返回前读取最新 resident snapshot，并一次性
完成 overlay：

- HTTP turns 与 `liveRevision` 来自同一状态。
- 同一 canonical id 以 live lifecycle 覆盖落后的 persisted snapshot。
- live 只能追加历史重叠点之后的 turn。
- resident store 不吸收 HTTP 历史 baseline。

## 7. Resume

Resume 不清空已展示的 history：

1. 当前 projection 保持可见。
2. 按钮原地进入 Resuming。
3. daemon 返回 live runtime id 后，按 provider session identity 迁移 projection。
4. canonical delta 接管后继续追加。

如果同一 provider session 已运行，使用已有 live projection，不重复 resume。

## 8. Provider evidence

| Provider | 主要证据 | 分页策略 |
| --- | --- | --- |
| Codex | app-server turn/item page；adapter 内的 bounded rollout evidence | native cursor 或 frozen persisted cursor |
| Claude | JSONL transcript | timestamp/frozen cursor |
| OpenCode | server/SQLite message-part | provider cursor 或 frozen timestamp cursor |

这些证据只在 daemon 内转换为 `ConversationEvidencePage`，随后进入 projector。浏览器不可直接读取。

## 9. 性能边界

- stored-session catalog 与 Conversation 正文是两条数据面。daemon 启动只读取
  `~/.rah/runtime-daemon/stored-session-cache/catalog.json` 的原子快照来构建有界 Recent，
  不在主事件循环扫描 Codex JSONL、Claude transcript 或 OpenCode SQLite。
- 启动后的权威校准、5 分钟周期校准和 All catalog 请求都在隔离子进程中执行；单个 provider
  失败只保留该 provider 的 last-good 快照，不阻断另外两个 provider，也不阻塞 Chat/WS。
- Stop 成功是当前 runtime 已知事实：session 必须立即以 stopped/provider-history 记录进入 Recent，
  随后的子进程扫描只负责补齐 storage path、行数和 provider archive metadata。
- 删除、归档和按 workspace 批量删除在执行前等待权威 catalog；普通启动、Resume、Chat 浏览和
  Recent 请求不得隐式等待完整 catalog。
- resident settled turns 默认有界。
- raw auxiliary feed 默认 900 条触发压缩，目标约 650 条。
- directory preview 有长度上限。
- tool output 只按需读取。
- Codex 官方 `thread/turns/list` page 使用内存 LRU 和原子写入的持久化 cache；同一 rollout revision、cursor、limit 与 summary 模式必须复用同一 page，不重复扫描大 JSONL。
- Codex page cache identity 包含 rollout 的 `dev`、`ino`、`size`、`mtime`。文件替换或增长会自然进入新 revision，旧 revision 只服务已经冻结的浏览 snapshot，不能污染新页。
- summary page 必须移除 provider event 的大 `raw` payload，只保留 canonical message、lifecycle 和 compact process metadata；展开 turn/item detail 时才读取完整 raw evidence。
- HTTP 大 JSON 支持 gzip。
- `approximateBytes` 用于诊断弱网 payload，不参与 UI 语义。

## 10. 回归检查

- 连续相同用户文本仍是两个 turns。
- user/process/final 顺序在 live、刷新和 history 中一致。
- interrupt 位于所属 user 之后。
- 向上分页不重复、不跳阅读位置、不产生大片空白。
- 点击早期目录项可加载并定位。
- Resume 不重复下载已展示历史。
- PWA 不请求完整目录。
- 新建首条用户消息立即由 optimistic item 显示，canonical user 到达后原位接管。
