# RAH 全面架构审查与收敛记录（2026-08）

复核日期：2026-08-13

本文记录本轮针对组织架构、代码体量、文档一致性、长历史性能、New/Resume 可靠性、UI 可用性及 Herdr 参考价值的审查结论。它既是问题清单，也是已经落地的边界；后续不得用局部 UI 补丁重新绕过这些边界。

## 1. 结论摘要

RAH 的三层骨架正确：`runtime-protocol` 定义 canonical contract，`runtime-daemon` 持有真实 runtime，`client-web` 只负责 projection 与交互。项目的核心风险不是“需要重写”，而是少数巨型 owner、跨层启动状态、Provider 输入确认语义和历史渲染成本曾经过度耦合。

本轮按风险顺序完成：

1. 把 New / Resume / Attach 收敛成同一 activation transaction，并增加精确输入接收回执。
2. 用慢启动、大历史、PWA、跨页面切换覆盖入口 P0 门禁。
3. 用内容成本而不是单纯 row 数决定 Conversation 虚拟化。
4. 把 Claude 历史改成冻结文件边界上的 byte-offset 分页。
5. 从巨型文件中提取 Conversation page、Session model draft、activation、composer styles 与 input contract owner，并增加不可回吸的架构检查。
6. 用真实隔离浏览器复核 Session、Council、Canvas 与 390x844 PWA。

## 2. 组织与代码体量

审查时生产源码约 433 个文件。默认单文件上限为 1,600 行，仍有 12 个历史债务 owner 被明确 ratchet：它们允许继续缩小，不允许增长。最大的剩余热点包括：

| Owner | 当前约行数 | 判断 | 下一拆分边界 |
| --- | ---: | --- | --- |
| `runtime-protocol/src/contract.ts` | 3,687 | 验证入口仍大；输入契约已拆出 | 按 API family 继续提取纯 validator |
| `runtime-daemon/src/codex-app-server-activity.ts` | 3,641 | Provider translator 责任密集 | 按 turn/item/config event family 分离 |
| `client-web/src/App.tsx` | 3,561 | composition root 仍偏大 | 把剩余页面级 command coordinator 提取，不再下放业务 truth |
| `runtime-daemon/src/runtime-engine.ts` | 3,376 | API facade/编排仍大 | 继续委托 lifecycle/history/control owner |
| `runtime-daemon/src/runtime-terminal-coordinator.ts` | 2,692 | PTY、queue、mirror 边界密集 | 分开 transport injection 与 mirror acknowledgement |
| `client-web/src/council/CouncilPage.tsx` | 2,489 | Council view/action 混合 | 抽受控表单与 pane sections，不复制 store |
| `client-web/src/components/chat/ChatThread.tsx` | 2,169 | feed/scroll/navigation 耦合 | 抽 virtual viewport controller 与 turn navigator shell |

这不是立即大拆重写的理由。每次拆分必须先有 characterization test，并保持 owner 唯一；否则只会把一个 God object 变成多个互相写状态的小 God object。

已经新增 `scripts/source-architecture.mjs` 约束：

- 普通生产源码不得超过 1,600 行；
- 历史大文件使用精确 ceiling ratchet；
- `App.tsx`、`runtime-engine.ts`、`styles.css`、`contract.ts` 不得重新吸收已拆 owner；
- source reachability 与 repo hygiene 同时拦截孤儿源码、失效链接和废弃脚本。

## 3. P0：Session 激活与输入交付

此前最危险的错误是把“进程已启动”“PTY 已写入”“RPC 已返回”或“队列项消失”当作用户问题已经送达。慢启动和大历史 Resume 会放大这个竞争：UI 可能出现 Stop，TUI 已启动，但首问丢失或草稿不清；迟到的成功还可能把用户从别的页面拉回。

现在唯一合法事务为：

```text
client stable identity + optimistic row
  -> await current event transport initial replay
  -> POST start/resume/attach(initialInput + full config)
  -> daemon canonical queue: queued -> submitting
  -> provider exact echo / turn-start acceptance
  -> session.input.accepted(clientMessageId, clientTurnId)
  -> activation response confirms same identity
  -> client commits draft ownership
```

硬边界：

- PTY 写成功、HTTP/RPC 返回、runtime 创建和 queue disappearance 都不是 acceptance；
- mutation 之前必须等待当前 WebSocket 的 initial replay 完成；这是因果屏障，不是强制重连，避免新 runtime 的 lifecycle/delta 先于浏览器 baseline 到达后被重放覆盖；
- provider 明确拒绝或结果不确定时，输入仍可见、可恢复，不能静默消费；
- `submitting` 只在 Chat projection 显示一次，composer queue 只显示仍为 `queued` 的项目；
- Resume A 的迟到完成只能更新 A，不能抢走用户此时正在看的 B；
- model、effort、permission、Plan 的配置与首问同一个请求进入 daemon；
- 草稿只在相同 identity 得到确认后清空。

HTTP 与事件流交接不能使用同一个模糊的对象 spread：New Task 的临时 projection 只拥有乐观草稿与启动配置，canonical conversation 必须以真实 Session 的 live projection 为准；历史 Resume 则以已经分页展示的 stopped transcript 为 baseline，再叠加新的 lifecycle/delta。这个差异由两个具名 handoff owner 固化并有回归测试，避免临时 Session 的空历史请求抹掉已经到达的 Provider 回复。

协议 owner 是 `session-input-contract.ts`，运行时等待 owner 是 `runtime-input-acceptance.ts`，前端事务 owner 是 `session-activation-transaction.ts`。任何 Provider 新路径必须发布同一 `session.input.accepted`，不能发明私有成功语义。

## 4. 历史与浏览性能

### 4.1 不该加载什么

- daemon 启动不扫描所有 Provider 历史；Recent 先读 last-good catalog，完整校准在隔离 worker。
- 打开 Chat 不提前加载 Chats All、完整 turn directory、完整工具输出或 Inspector 全量内容。
- PWA 不下载 desktop turn navigator directory。
- Resume 复用已显示 projection，不重新下载完整历史。

### 4.2 应该如何加载

- 首屏只读最近 8 turns；接近顶部再用 opaque cursor 取 20 个更早 turns。
- Codex 依靠 byte-range index/cache；OpenCode stored history 先按 session SQL 过滤；Claude 现在冻结 `snapshotEndOffset`，从文件尾反向按 byte range 分页，不再为每一页全文件解析后切片。
- daemon canonical page hot cache 只保存 terminal page，严格匹配 source/live revision，并受单项 1 MiB、128 项、32 MiB、30 分钟 LRU 限制。
- 浏览器 A -> B -> A 使用与 catalog/sidebar 分离的 bounded Conversation LRU；目录重建或 replay gap
  不再清空已读正文，返回时先画旧 tail、再只校准可见 Session。整页刷新重新向 daemon 请求 canonical
  page，不把正文写入 localStorage/IndexedDB。

### 4.3 渲染预算

仅按“80 行”决定虚拟化会漏掉单条超长 Markdown、工具输出和图片。本轮改为同时检查：

- 最多 80 个 eager rows；
- 最多约 12,000px 估算内容；
- 最多约 8 个 viewport；
- 真实 measured height 回写布局，prepend 维持可见 anchor。

隔离真实浏览器对 180-turn 历史连续上滚时，DOM 始终只保留约 8 个当前窗口 turn；更早页持续进入、滚动锚点保持且无横向溢出。

## 5. UI 与功能可用性审查

UI 测试必须验证交互结果，不只比较 className：

- 390x844 下 composer 多行增长有上限，模型菜单点击后不回缩、不丢文字；
- permission、Plan、model/effort 与 Send/Stop 在 stopped/starting/running 间保持挂载；
- New Task 的 workspace 附属条、provider selector 与 composer 不溢出；
- Session/Council/Canvas 共用统一标题行与 divider 协议；
- Changed Files 文件浏览关闭后不自动打开全屏 Inspector；
- Sidebar hover/tooltip、pin/archive 遮罩与行高由共享契约测试锁定；
- Council 新建配置、Canvas pane 结构和 Session 历史均在真实浏览器打开检查。

本轮浏览器门禁全部运行于临时目录、临时端口与 fake provider；没有重启在线 RAH，也没有调用 GPT-5.6 Ultra。

## 6. 文档与废弃代码

过去的问题主要是文档日期、基线提交、输入队列语义和历史分页实现晚于代码。现在：

- `AGENTS.md` 提供新 Agent 的入口、owner、不变量和安全测试命令；
- `HANDOVER.md` 只记录稳定边界，不再承诺未发生的 push/restart/clean 状态；
- 当前设计、历史分页、store ownership 与 provider maintenance 同步写入显式 acceptance；
- source reachability 拦截未被生产或测试入口引用的源码；repo hygiene 拦截失效文档链接和脚本；
- 删除必须以 reachability、引用和行为测试为证据，不能仅凭文件年代猜测“看起来废弃”。

## 7. Herdr 对 RAH 的价值

Herdr 是 agent terminal multiplexer，最值得 RAH 吸收的是工程纪律，不是把它当 Conversation backend：

- state 与 runtime 分开；render 保持纯；拒绝 God object；平台代码隔离；
- shared runtime fact 属于 server/API，sidebar、颜色和 viewport 属于 client；
- detach 后 server 继续持有 pane，和 RAH daemon-owned runtime 方向一致；
- 用显式 socket/API 支持外部客户端和 agent orchestration；
- 高风险身份/恢复改动先写 adversarial invariants 与 characterization tests。

不应照搬的部分：Herdr 的 agent working/blocked 状态主要可由进程与终端屏幕 detection 得出，而 RAH 的 Chat、turn、input acceptance 和 Changed Files 需要 Provider 原生结构化证据。终端检测可作为 TUI 状态诊断或退化信号，不能成为 canonical Conversation truth。

因此 Herdr 对 RAH 有重要参考价值，但价值等级是“架构与运行时工程原则”，不是“替换现有 Provider adapter / history / conversation protocol”。

## 8. 后续优先级

1. 按 ratchet 渐进拆 `contract.ts`、Codex activity translator、`App.tsx` 与 `ChatThread.tsx`。
2. 为 Claude/OpenCode 的接收回执继续增加 Provider drift corpus。
3. 给长历史加入持续内存/帧耗时基线，而不只统计 request 与 DOM 数。
4. 所有 lifecycle 变更必须先扩展 slow-start + large-history P0 gate。

任何后续优化都不能用牺牲入口交付确定性、历史 identity 或 UI 实时性换取更短代码或更漂亮的局部指标。
