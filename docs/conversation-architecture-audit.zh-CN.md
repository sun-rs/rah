# Conversation 架构收口审计

复核日期：2026-07-12

## 结论

Conversation 已从“默认 V2 + legacy fallback”收口为 canonical-only。当前 Chat 的顺序、
process/final、分页、目录、detail、outputs 和 sources 均由同一协议驱动；普通 Session 与 Canvas
没有独立实现。

## 已删除

- `conversation-v2-feature.ts` 与本地 feature flag。
- `session-store-history.ts`、旧 prepend/merge/replay 推断。
- `session-store-history-paging.ts`。
- `HistorySyncState` 与 history bootstrap/deferred 双状态。
- 前端 final/process 文本和位置推断。
- Inspector 从 flat feed 猜输出文件的路径。
- `/api/sessions/:id/history`、`/history/detail`、`/history/turn` 公开读取接口。
- `SessionTurnHistoryResponse` 与旧 turn-history adapter capability。
- `SessionCapabilities.renameSession` 重复字段；rename 只由 `actions.rename` 表达。
- Start/Resume/SetModel 的 `reasoningId`、`providerConfig`、`approvalPolicy`、`sandbox` 网络别名；
  统一为 catalog 驱动的 `optionValues` 与 `modeId`。

## 当前 ownership

### daemon

- provider adapter：读取 provider evidence。
- `RahEvent`：append-only transport/diagnostic ledger。
- `conversation-projector.ts`：canonical turn/item 语义。
- `conversation-projection-store.ts`：resident live projection 与 revision delta。
- `conversation-turn-directory.ts`：provider-neutral directory。
- `conversation-resource-projector.ts`：outputs/sources。

### client

- `session-store-conversation.ts`：baseline、cursor、delta、detail hydration。
- `session-store-conversation-directory.ts`：目录和指定 turn hydration。
- `conversation-feed.ts`：canonical item 到叶子卡片 view model。
- `ChatThread.tsx`：虚拟化、折叠、滚动、复制和响应式展示。
- `session-store-pending-events.ts`：仅缓存 session summary 尚未出现时先到的 WS events。

## 不属于 fallback 的内部结构

`SessionProjection.feed` 仍存在，但职责已缩小：

- optimistic user item
- runtime/permission 辅助 projection
- unread 与诊断兼容

历史正文不会从该 feed 读取；Chat 只接纳 canonical turns 加尚未被 canonical user item 接管的
optimistic user item。

`ConversationEvidencePage` 也仍存在，但它只在 daemon 内部连接 provider evidence 与 projector，
没有 HTTP UI 路由。

projector 的 canonical id 派生也不是 fallback：它只把 provider opaque key 确定性映射到稳定的
turn/item identity，不读取第二份历史，不改变协议，也不按内容猜测身份。

## 已验证风险

- 连续发问与相同文本使用 provider/client identity，不按文本去重。
- process/final 顺序由 item role 固定。
- interrupted lifecycle 属于 turn，不依赖是否存在过程气泡。
- full detail 不会被 summary refresh 降级。
- live delta 在 baseline 加载期间可缓存并连续应用。
- revision gap 只触发一次 baseline refresh。
- directory 重复 cursor 会安全终止。
- Inspector outputs/sources 只取 canonical resource projection。
- raw live feed 可独立有界压缩，不再修改 history loading 状态。
- provider archive 状态参与 stored-session revision；Recent 不得以旧缓存覆盖当前 archive 状态。
- 历史恢复的用户术语统一为 Resume；底层 claim 只表示 control/surface lease。
- `runtimeState` 只用于 daemon 协调与诊断；协议拒绝它与用户可见 `status` 相互矛盾，前端不再
  使用它兜底决定 running/stopped。
- 浏览器不再为 Claude/TUI session 运行 1.5 秒 history-tail 轮询；daemon transcript mirror 与
  provider server 是 live 事实源，浏览器只消费 canonical delta，replay gap 才重取 baseline。
- Codex Resume 不再捕获 `excludeTurns` 参数错误后重试全量 `thread/resume`；当前官方分页协议是
  最低要求，协议不匹配会明确报错。
- Web permission response 只接受 provider-neutral decision；Codex 的两种官方 approval response
  shape 只存在于 adapter 内。

## 剩余工程债务

以下不是双事实源，但仍值得后续拆分：

- `ChatThread.tsx` 同时拥有叶子渲染、虚拟化、bottom-follow、prepend anchor 和目录导航，文件偏大。
  下一次重构应按纯 view、scroll controller、turn navigation 三层拆分，行为测试先行。
- `types.ts` 仍包含 raw `RahEvent -> auxiliary feed` reducer。它服务诊断、权限、optimistic 和 unread，
  不能再承担 conversation 历史。后续可重命名为 auxiliary projection reducer。
- Codex live 与 persisted translator 代码体积仍大，但二者都位于 provider evidence 层，不能为了
  减行数牺牲官方事件覆盖。

这些债务不构成 legacy Conversation fallback，也不应通过新增 UI 兼容分支解决。

## 本次验证

以下检查在 2026-07-12 的同一工作树上通过：

- `npm run typecheck`
- `npm run test:protocol`：16/16
- `npm run test:conversation`：69/69
- `npm run test:history-directory`：19/19
- `npm run test:web`：448/448
- `npm run test:provider-contracts`：264/264
- `npm run build:web`
- `git diff --check`
- Codex 真实浏览器 smoke：连续输入、相同文本、interrupt、分页、Resume、TUI、Archive 和移动端断言通过。
- Claude/OpenCode 真实浏览器 smoke：顺序、重复输入、interrupt 锚定、queue、Resume、TUI 和前台 catch-up 通过。

canonical Conversation 文件的精确扫描中不存在 `legacy` 或协议级 `fallback`。Markdown 的纯文本
渲染样式、provider adapter 的静态 catalog 默认值和 Claude 的正式 TUI 承载不构成第二套
Conversation 协议；它们不能被用来绕过 projector、canonical HTTP/WS 或共享 `ChatThread`。
