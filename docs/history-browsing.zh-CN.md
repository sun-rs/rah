# Conversation 历史浏览与分页边界

复核日期：2026-07-28

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
GET /api/sessions/:sessionId/conversation/turns?limit=8
```

规则：

- 请求期间保留 shell，不白屏、不跳 New。
- 新建 live session 可使用 `liveOnly=true`，不触发 provider 历史扫描。
- summary page 不携带大工具输出。
- 首屏响应携带可与轻量 revision probe 直接比较的 provider `sourceRevision`；pager 内部 frozen
  boundary 不得冒充另一种 freshness token。客户端必须先把该 revision 作为 freshness
  baseline 写入 projection，不能在 `phase=loading` 时启动 revision probe。
- rollout 在首屏扫描期间继续增长时，响应 revision 只覆盖已经扫描完成的 byte boundary；下一次 probe
  只触发从该 boundary 开始的增量追赶，不能取消并重发仍在进行的首屏请求。
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
| OpenCode | live 使用 server event + 有界官方 message API；stored history 使用 session-scoped SQLite message/part | provider cursor 或 frozen timestamp + message id cursor |

这些证据只在 daemon 内转换为 `ConversationEvidencePage`，随后进入 projector。浏览器不可直接读取。

Codex Desktop 把多种产品表面写在同一个 `~/.codex/sessions` 树中。RAH 在读取首个
`session_meta.payload` 时识别用户根会话与内部执行记录：

- `originator=Codex Desktop` 与 `originator=codex_work_desktop` 都属于用户拥有的根会话，进入
  同一个 Codex catalog；
- `thread_source` 或 `source` 明确包含 `subagent` 的 rollout 是父任务内部执行记录，不作为独立
  用户 Session；
- 用户显式 Fork 等其他可见根会话继续保留；
- 过滤只排除明确的内部执行记录，不删除或改写 provider rollout。

目录名、文件名、标题、`session_index.jsonl` 与旧 RAH cache 都不能替代上述 provider metadata
成为产品表面判断依据。

## 9. 性能边界

- stored-session catalog 与 Conversation 正文是两条数据面。daemon 启动只读取
  `~/.rah/runtime-daemon/stored-session-cache/catalog.json` 的原子快照来构建有界 Recent，
  不在主事件循环扫描 Codex JSONL、Claude transcript 或 OpenCode SQLite。
- Provider catalog 是 Session 身份与可见性的唯一权威。Workbench snapshot、remembered recent、
  per-file metadata cache 和 replay-only runtime 都只是展示/启动缓存；当前 catalog 与真实 live
  runtime 都不再包含某个 `{provider, providerSessionId}` 时，这些缓存不得把它重新带回 Sidebar。
- catalog snapshot 与 provider metadata cache 都带可见性协议版本。过滤规则或身份语义升级时，
  daemon 必须拒绝旧版本缓存；一次完整 provider scan 会删除已忽略、已移除或已重新分类的 cache
  row。扫描不完整时则保留该 provider 的 last-good rows，不能把暂时读取失败误判成删除。
- 启动后的权威校准、5 分钟周期校准和 All catalog 请求都在隔离子进程中执行；单个 provider
  失败只保留该 provider 的 last-good 快照，不阻断另外两个 provider，也不阻塞 Chat/WS。
- Stop 成功是当前 runtime 已知事实：session 必须立即以 stopped/provider-history 记录进入 Recent，
  随后的子进程扫描只负责补齐 storage path、行数和 provider archive metadata。
- Stop API 返回权威 closed summary 后，前端立即收口可见状态并关闭确认层；后续 workbench/catalog
  refresh 在后台执行，不能把按钮或页面继续锁在 Closing。
- 删除、归档和按 workspace 批量删除在执行前等待权威 catalog；普通启动、Resume、Chat 浏览和
  Recent 请求不得隐式等待完整 catalog。
- resident settled turns 默认有界。
- daemon 对已经投影完成的 canonical page 维护独立内存 LRU，服务浏览器 reload：地址为
  `Runtime Session + cursor + limit`，命中还必须同时匹配 provider `sourceRevision` 与 resident
  `liveRevision`。单条最多 1 MiB、全局最多 128 条 / 32 MiB、最长 30 分钟；工作中 turn、pending/
  running item 不缓存。任何 revision 不一致都直接失效，不能 stale-while-merge，也不能让浏览器
  IndexedDB 成为 Conversation owner。
- raw auxiliary feed 默认 900 条触发压缩，目标约 650 条。
- directory preview 有长度上限。
- tool output 只按需读取。
- Codex 官方 `thread/turns/list` page 使用内存 LRU 和原子写入的持久化 cache；同一 rollout revision、cursor、limit 与 summary 模式必须复用同一 page，不重复扫描大 JSONL。
- Codex page cache identity 包含 rollout 的 `dev`、`ino`、`size`、`mtime`。文件替换或增长会自然进入新 revision，旧 revision 只服务已经冻结的浏览 snapshot，不能污染新页。
- Codex 首个 summary page 在同一个隔离 worker 中完成 directory 尾部增量扫描、所选 turn summary
  hydration 与本轮 file-change 聚合，返回同一 byte boundary 的 `sourceRevision`。请求路径不能串行
  启动 scan worker、summary worker、file-change worker，也不能等待 `lsof/ps` 活跃性探测。
- Codex turn directory 持久化 byte-range 索引；summary cache 额外保存最近有界 turns 的 user/final
  文本与已扫描 offsets。大 rollout 的重复打开、daemon 重启和仍在增长的最后一个 turn 都从已缓存
  boundary 继续，正文分页和指定 turn hydration 只读取对应范围，不能回退到主事件循环全文件扫描。
- OpenCode live catch-up 只串行请求官方 local-server message API 的最近 8 条 message，每秒最多一次；
  Resume 用最近 16 条只建立 identity/revision baseline，不回放已经展示的 history。请求可取消，revision
  ledger 上限为 64。live path 不允许每 750ms 同步扫描 SQLite 全历史。
- OpenCode stored history 的 SQL 必须先按目标 `session_id` 过滤，summary page 不读取大
  reasoning/tool payload；cursor 用 timestamp + message id 保证同毫秒记录稳定分页。
- summary page 必须移除 provider event 的大 `raw` payload，只保留 canonical message、lifecycle 和 compact process metadata；展开 turn/item detail 时才读取完整 raw evidence。
- HTTP 大 JSON 支持 gzip。
- `approximateBytes` 用于诊断弱网 payload，不参与 UI 语义。

## 10. 性能验证

真实浏览器基准命令：

```bash
python3 scripts/history-browser-benchmark.py <provider-session-id> --older-pages 3
python3 scripts/history-browser-benchmark.py <provider-session-id> --older-pages 3 --resume
```

脚本测量首个可读气泡、向上分页、HTTP transfer/decoded bytes，以及 Resume 是否复用当前页面。它只关闭
本次创建的 read-only replay/runtime，不扫描或删除 provider 历史。

2026-07-14 在当前 Mac 的实测证据如下；这是回归基线，不是跨机器 SLA：

| Provider | New 到可用 Chat | 普通 history 首个可读气泡 | Resume 到可用 Chat | Stop 到 UI 可操作 |
| --- | ---: | ---: | ---: | ---: |
| Codex | 4.15s | 0.45s | 0.41s | 0.17s |
| OpenCode | 1.25s | 0.27s | 1.73s | 0.16s |
| Claude | 0.16s | 0.34s | 0.42s | 0.18s |

- Codex 2.36GB / 139,048 行 rollout：首个可读气泡约 0.65s；4 个 history request 合计约
  112KB transfer / 314KB decoded。为避免恢复真实长期任务，本次只验证 history，没有 Resume 该线程。
- OpenCode 18.4MB / 691 messages：首个可读气泡约 0.32s，Resume 约 1.42s；4 个 history request
  合计约 92KB transfer / 293KB decoded。修复前同一 Resume 会被同步 SQLite mirror 阻塞约 45s。
- 当前机器没有等量级 Claude 历史样本；Claude 的 New/History/Resume/Stop 与连续追问已做真实浏览器
  验证，但不能据此声称超大 Claude JSONL 已达到同一数据量基线。

2026-07-28 对当前真实 Codex 工作集再次验证：

- `rah_develop` rollout 约 4.19GB；daemon 重启后的首次增量追赶约 2.7s，summary cache 建立后
  重复 API 打开约 0.38–0.61s，真实浏览器切回可见内容约 0.8s。
- `solars_new` rollout 约 223MB；真实浏览器首次可见历史约 1.2s，后续 API page 约
  0.10–0.54s。
- 连续 3 次页面 reload，Sidebar DOM 在约 142–264ms 内稳定为同一组 active 用户根会话；没有
  internal subagent rollout 或重复中文 Solars 行出现。

这些数字是同机回归证据，不是对任意磁盘、机器或持续增长速率的 SLA。

## 11. 回归检查

- 连续相同用户文本仍是两个 turns。
- user/process/final 顺序在 live、刷新和 history 中一致。
- interrupt 位于所属 user 之后。
- 向上分页不重复、不跳阅读位置、不产生大片空白。
- 点击早期目录项可加载并定位。
- Resume 不重复下载已展示历史。
- PWA 不请求完整目录。
- 新建首条用户消息立即由 optimistic item 显示，canonical user 到达后原位接管。
- Codex catalog 同时包含 `Codex Desktop` 与 `codex_work_desktop` 创建的用户根会话，但不包含
  internal subagent rollout；刷新、focus 与重复 catalog scan 后身份、数量和顺序保持稳定。
- 完整 catalog scan 会清理旧 visibility contract 的 snapshot/cache；不完整 scan 保留 last-good。
- 首屏处于 `loading` 时不发 source-revision probe；首屏完成后第一次 probe 不取消、重复或清空
  已显示 history。
