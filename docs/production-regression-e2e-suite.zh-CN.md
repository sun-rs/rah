# RAH 生产回归专项测试设计

本文件定义 RAH 进入生产级自用前必须固定下来的回归测试集。目标不是证明模型回答质量，而是证明 RAH 的核心工作台能力没有回退：无缝接续、Chat 投影顺序、唯一性、中断控制、History 分页、TUI surface 管理、移动端可用性。

机器可读的 case 总账在 `scripts/regression_e2e_manifest.ts`。新增历史 bug 时，必须先补一个 case id，再修代码。

## 核心原则

1. 前端只消费统一 RAH timeline。

   无论后端来源是 `Codex app-server`、`OpenCode server`、`Claude tmux`、provider history file、WebSocket live stream，进入 UI 前都必须归一成 `RahEvent`。前端排序和唯一性只看统一投影账本，不按 provider 或 backend 分叉。

2. daemon 是 transcript ledger 的权威边界。

   adapter/provider parser 负责把 raw event 映射为 canonical identity。daemon reconciler 负责 dedupe、lifecycle identity、history/live 合并。前端只做 projection 和必要的本地 optimistic intent anchor。

3. Stop 和 interrupt 必须可验证。

   Web 输入被接受或进入 native TUI 队列后，Stop 必须立刻可见。Stop 结果可以由后端确认，但提示位置和重复数量必须由前端 projection 锁定，防止 notice 漂移。

4. Fake provider 是主回归，真实 provider 是 smoke。

   真实 CLI 会受账号、网络、quota、provider 版本影响，不能作为唯一 CI gate。确定性回归用 fake provider/app-server/history/tmux fixture；真实 provider 只做小集合 smoke。

5. 测试自清理必须可恢复。

   自动 smoke/probe 不允许对用户 provider 历史或 session 文件做硬删除。测试创建的临时 workspace/provider home/RAH home 必须移入系统废纸篓/回收站；清理范围必须来自测试自己创建的 root metadata，不能通过扫描 provider history 内容并按字符串匹配删除 session 文件。

## 测试分层

| 层级 | 目的 | 是否必跑 |
|---|---|---|
| Unit/contract | 锁定 projection、timeline identity、provider parser、runtime state machine | 每次改动必跑 |
| Fake daemon/browser | 用 fake provider 驱动真实 daemon + Web UI，断言 DOM 顺序/按钮状态 | 每次 UI/runtime 改动必跑 |
| Fake tmux/native TUI | 验证 surface lease、queued input、archive、exit、late frame | 每次 TUI/mux 改动必跑 |
| Real provider smoke | 验证真实 Codex/Claude/OpenCode 当前版本没有协议漂移 | 发布前/手动跑 |
| Manual mobile QA | iOS/PWA 输入法、滚动、触控、视觉布局 | 发布前/大 UI 改动后 |

## P0 场景

这些场景一旦失败，不能认为当前版本可交付。

| ID | 场景 | 最小验收 |
|---|---|---|
| `TRANSCRIPT-ORDER-001` | 气泡顺序 | 两轮对话固定为 `user1 -> assistant1 -> user2 -> assistant2`，刷新/重选 session 后不变 |
| `TRANSCRIPT-UNIQUE-001` | 唯一性 | live/history echo 不重复；streaming update 不追加新气泡 |
| `TRANSCRIPT-REPEAT-001` | 重复文本 | 连续发送两次“继续”必须显示两轮 |
| `INTERRUPT-ANCHOR-001` | 中断提示锚定 | 每个被中断 turn 最多一条 notice，后续中断不能移动旧 notice |
| `INTERRUPT-STATE-001` | Stop 可见性 | Web 输入被接受/排队后 Stop 立刻出现，完成/失败/中断后消失 |
| `INTERRUPT-MULTI-001` | 多次 Stop | 多次点击 Stop 不退出 TUI，不产生多条 notice |
| `QUEUE-INPUT-001` | queued input | TUI prompt dirty 时 Web 输入排队、可中断、prompt clean 后只发送一次 |
| `NEW-SESSION-001` | 新会话 | 首屏不显示 older-history loading，第一问只出现一次 |
| `REFRESH-LIVE-001` | 刷新恢复 | 刷新后 transcript 不重复、Stop 不残留 |
| `HISTORY-PAGING-001` | 历史分页 | 向上加载 older page 不跳滚动锚，不重复 live tail |
| `HISTORY-CATALOG-001` | Chats 目录增量 | 启动只取有界 Recent；首次打开 All 取一次权威目录；干净重开不再全量下载 |
| `HISTORY-BOUNDED-001` | 超大历史首屏 | 首屏只下载有界 turn 页，不下载完整 provider transcript；PWA 不加载桌面 turn 导航目录 |
| `HISTORY-RESUME-001` | history resume | replay 转 live 不重排、不重复 |
| `HISTORY-RESUME-SEND-001` | stopped 首次发送 | 大历史慢恢复时首问与 `/sessions/resume` 原子提交；daemon queue 先接管并显示 `submitting`，Provider 接受对应 identity 后 HTTP 才成功；迟到 idle/finished 不清除 Working，刷新仍可追踪且 Provider 恰好收到一次；无输入激活已在途或已有首问在途时，后续每条输入也都有独立交付路径且只创建一个 runtime |
| `STOP-STAYS-IN-CHAT-001` | Session stop 导航 | 显式 Stop 与 `session.closed` 竞态下都保留当前 transcript 并原地变为 stopped replay；catalog refresh 后仍停留在该 Chat，可直接继续输入恢复 |
| `BACKGROUND-RESUME-NAVIGATION-001` | 后台 resume 导航 | 对 stopped A 提交后切到 B，A 继续启动和发送，但成功、回滚及迟到控制刷新均不得抢回当前页面 |
| `CODEX-EVENT-001` | Codex 非 chat event | `thread/goal/cleared` 等不变成吓人的红色 chat Event |
| `CLAUDE-ABORT-CONTEXT-001` | Claude aborted context | `<turn_aborted>` 不进入可见消息正文 |
| `CLAUDE-TMUX-001` | Claude tmux | Chat/TUI/local terminal surface 切换互斥且可恢复 |
| `OPENCODE-STOP-001` | OpenCode Stop | Stop 中断 turn，不退出 TUI，后续可继续问 |
| `OPENCODE-MIRROR-001` | OpenCode mirror | server live 与 DB mirror 合并后不重复 |
| `TUI-SURFACE-001` | TUI surface | 同一时刻只有一个 active display/input surface |
| `TUI-EXIT-001` | TUI exit | provider/TUI client `/exit` 后 RAH 不保持 running，不被迟到帧复活；native-local-server provider session 可继续保留 |
| `ARCHIVE-001` | Archive | 关闭 live clients/tmux/pty，不删除 provider history |
| `CODEX-CATALOG-ROOT-001` | Codex 根会话完整性 | `Codex Desktop` 与 `codex_work_desktop` 创建的用户根会话都进入 catalog；只排除明确 internal subagent |
| `WORKSPACE-LIFECYCLE-001` | 工作区生命周期 | 从空列表添加、刷新、移除、再次添加均可用；数量、顺序和唯一性不漂移 |
| `WORKSPACE-PROJECTION-001` | Session 可见性投影 | Session 只归属最具体的已注册工作区；移除工作区后同一渲染周期内消失，不依赖刷新 |
| `WORKSPACE-EMPTY-RECOVERY-001` | 空列表恢复 | Workspaces 为 0 时添加入口仍可用，添加后恰好出现一行且刷新后保留 |
| `WORKSPACE-NEW-TASK-001` | 工作区新建联动 | 点击工作区行的新建按钮后，New task composer 精确选择该工作区 |
| `NEW-TASK-DRAFT-OWNERSHIP-001` | New task 首轮可靠交付 | 提交期间禁止重复创建；纯文本首问携稳定 message/turn identity 原子进入 `/sessions/start`，不再依赖页面跳转后的第二次 `/input`；Provider 接受对应首问前启动接口不得成功，真实 fake Codex 必须恰好收到一次问题并返回可见回复，启动/投递拒绝则恢复原草稿与附件，不能因 Session id 已创建或 daemon queue 已接管而静默丢失 |
| `PWA-COMPOSER-WORKSPACE-PILL-001` | PWA workspace accessory | workspace selector 为 40px 附属条，顶部 8px 被 composer 覆盖、实际露出 32px，内部按钮 28px；超过 18 字符才跑马，不与 agent 配置或发送按钮重叠，不产生横向溢出；provider 为 36px 无边框单层条，PWA 以 600 字重和蓝色 `24×2px` 图标标记唯一当前项，Desktop 使用文字等宽蓝线，整组 hover 移开即隐藏 |
| `PWA-CONVERSATION-DENSITY-001` | PWA 对话阅读密度 | Session/Council 正文读取 12–20px Appearance token；隐藏动作不占行，commentary 使用无卡片白底正文 |
| `PWA-GLOBAL-NOTICE-001` | 全局恢复提示 | PWA 锚定在顶部安全区控制行下方，390×844 下不超过 72px且不覆盖 composer；与 Wide Desktop 共享低对比橙色混色、无投影 surface，四角不被宿主裁切；Session Chat/Council/Canvas 共用 40px 单行标题栏且提示始终位于分割线以下；Wide Desktop 为最大 24rem 的紧凑横向 toast，右/下边距各 16px且不受底部浮动锚点影响 |
| `PWA-TURN-CHANGE-PREVIEW-001` | PWA 本轮文件查看 | 回复卡片的单文件入口使用独立临时查看器，关闭后直接回到 Chat；回复审查与 Task 明细的 `Changed files` 共用不修改 Inspector 状态的 Review 路径，任何关闭动作都不能暴露全屏 Inspector；Wide Desktop 仍保留 Inspector 工作流 |
| `COMPOSER-UNIFIED-SURFACE-001` | 统一 composer surface | New task 与 Chat 共用白底、细边框、24px 圆角、轻阴影和同一 ghost toolbar；能力 catalog 无需点击即可加载，权限/Plan/完整模型与默认 effort 立即可见；Plan 激活态清晰；Session 的 model/effort 按 provider session 身份跨刷新、Stop、Resume 保存；stopped -> starting -> live 全程三个控制都保持挂载；`+` 固定最左，模型紧贴 Send/Stop；provider 当前项无灰块；Chat PWA 使用显式展开状态，iOS IME 长文本原位测量并增高到上限后才内部滚动，权限/Plan/模型均可实际操作，Portal 菜单必须位于键盘上方的 visual viewport 内；New task 窄屏复用同一响应式单行 rail、按宽度压缩标签且 workspace 位于 surface 外；Stop/Send 共用一个黑白主动作槽 |
| `RESPONSE-ANNOTATION-001` | 回复选区注释 | 单条 assistant response 选区显示操作浮层；注释 pill 可预览，更多详情补可编辑 draft，协议/queue/provider/history 全链路不泄漏 transport envelope |
| `DESKTOP-CONVERSATION-DENSITY-001` | Desktop 对话阅读密度 | 默认正文使用 14/22、约 430 字重、代码 12px；Appearance 只调 Session/Council 正文且范围为 12–20px，代码自动按 11–16px 联动；用户 Copy 悬浮显示但不占永久空白行，commentary 使用无卡片白底正文 |
| `CHAT-MARKDOWN-IMAGES-001` | 回复图片缩略图组 | 连续纯图片段落以 12px gap 并排并自动换行；本地缩略图最高 160px、远程最高 200px，点击预览保持可用 |
| `TURN-CHANGES-AUTHORITY-001` | 本轮文件变更权威性 | 列表与点击详情必须来自同一冻结 turn artifact；`patch_apply_end`、当前 workspace 与无 artifact 的历史摘要均不能生成卡片 |

P1 视觉/交互契约 `TASK-SUMMARY-DENSITY-001` 另外锁定 active task dock：32px 胶囊仅保留图标、进度与当前步骤；详情统计删除重复 plan activity，并把 command/read/change 维持在单行。Desktop 使用 hover/focus 且点击不锁定，standalone PWA 使用点击切换与点外部关闭。

完整 case 列表可执行：

```bash
npm run test:regression:e2e-plan
tsx scripts/regression_e2e_manifest.ts --markdown
```

确定性 P0 浏览器 gate：

```bash
npm run test:p0:browser
```

该 gate 使用隔离的 RAH/Codex home、fake provider、真实生产 Web 构建、真实 daemon 和 Playwright 浏览器执行
`scripts/workspace_lifecycle_browser_smoke.py`。它不依赖用户历史、账号、网络或 provider quota，因此属于
`test:ci` 的强制门禁。当前固定验证：

1. 初始 0 个工作区时可以从真实 picker 添加目录。
2. `Codex Desktop` 与 `codex_work_desktop` 创建的用户根会话都可见；显式 internal subagent 仍被排除。
3. 父工作区拥有嵌套 session；显式添加子工作区后，嵌套 session 原子地迁移到最具体工作区。
4. 工作区行 `New task` 精确选择该工作区。
5. 在 `390 x 844`、`navigator.standalone=true` 的 PWA 上下文中，New task workspace control 位于 composer 外部，短名称不重复滚动、超过 18 字符才跑马；permission/Plan/model/effort 无需点击即可访问，Plan 激活时使用蓝色文字与加粗 `P`、保持透明无阴影；窄屏继续复用单行响应式 rail，标签按空间压缩、模型紧贴主动作且没有页面横向溢出，聚焦前后 surface 几何与强调不变。该上下文同时制造 generation mismatch，断言顶部提示为低对比橙色混色、无投影且不遮挡 New task；Council、Canvas、Session Chat 共用 40px 单行标题栏。
6. 同一 PWA 上下文打开带冻结 turn artifact 的真实历史 Session 后，点击回复卡片的单个 Changed file 只出现一份临时文件查看器，关闭后 Chat 仍可见且页面中不存在 Inspector；打开并关闭共用的本轮 Review 后结果相同。随后断言 Session/Council 正文读取所选 12–20px token、隐藏 Copy action 不占行、commentary 透明且无 padding。Chat composer 失焦为单行 pill；聚焦或 permission/model 菜单打开后保持展开并显示完整配置与有界多行文本，model 不得越过主动作；菜单关闭并失焦后恢复原始 inset。
7. 刷新前后工作区数量、顺序、唯一性和 session 归属不变。
8. 移除父工作区时，其 session 立即消失，但显式注册的子工作区及其 session 保留。
9. 移除最后一个工作区后列表立即清空，且仍能再次添加并在刷新后保留。
10. 全流程不得产生浏览器 page error，并保存 workspace context、sidebar density 与 conversation 截图。
11. 分别打开 Home New task 与一个可输入 Session，断言两者都只有一个白色 composer surface 和一个共享 toolbar，placeholder 为 `Work with Rah`；权限、Plan、完整 model/effort 默认加载，顺序为 `+ / permission / Plan … model / Send|Stop`，workspace 只在 New task surface 外的上下文行中出现。Plan 开启后必须出现蓝色文字与更高字重，背景继续透明且无阴影；给 stopped Session 选择非默认 effort 后刷新页面，再 Stop/Resume，模型、effort 与 optionValues 均保持。ghost 控件静止态透明，provider 当前项没有灰色块。working Session 的 Stop/Send 共用一个无动画黑白槽。standalone 390px 下 New task 继续复用单行响应式 rail，permission/Plan 以图标压缩、模型紧贴主动作且 focus 几何不变；Chat 按“单行折叠—focus 或菜单打开保持展开—失焦折叠”转换，页面不得横向溢出。
12. 在一条 assistant response 内选择多行文本，浮层必须锚在第一行左上方且不越出 viewport；蓝色本地文件链接的文件名也必须能拖选复制，拖选结束不能误打开 Inspector；点击 `添加到任务` 后 textarea 保持可编辑、pill hover 展示完整选文、单独注释不能发送；点击 `更多详情` 后当前 draft 只补一条解释请求。
13. Wide Desktop 打开包含两张 640×360 本地 Markdown 图片的历史回复，断言只有一个 `flex-wrap` 图组、gap 为 12px、两张图同排且图像高度不超过 160px；回复正文默认计算样式为 14/22/约430。随后进入 Appearance，确认只有 12–20px Conversation text size，改为 18 后 Session/Council 正文即时成为 18/26、代码成为 16px，同时 Sidebar/菜单字号保持不变，再恢复 14。

本轮 sidebar 密度另由 `SIDEBAR-DENSITY-001` 锁定：Desktop 与 PWA Sheet 必须声明并消费同一个 `codex-compact-v1`，RAH header 下都没有分割线，40px header 到首个 New task 行均为 4px；新设备默认 272px、双击 divider 恢复 272px，标题/导航/分组/workspace/session 使用 `16/15/13/14/14px` 与 `600/500/550/500/450`，行高 30px、pill 圆角 10px、同组/工作区组/大分区间距 2/6/12px、动作槽 28px。Codex session 不显示左侧 provider 图标，Claude/OpenCode 各显示 16px bare logo，且不能改变行高或标题垂直中心。浏览器门禁逐项比较两种 surface 的字体、图标、左右 8px 内容 inset 与标题中心偏差 0；PWA 滚动区不得预留 gutter。New task、Council、Canvas 的 hover/选中态必须精确复用 Session hover surface，不得出现独立白底、阴影或鼠标点击残留的 focus 轮廓。Desktop Session hover 另断言 pin/archive 两项同时可见、action rail 计算底色完全透明、`box-shadow: none` 且整行 hover surface 仍存在；状态点在操作期间隐藏，不能形成图标叠层。Session 信息 tooltip 必须由 sidebar 唯一的 `idle / pending / open` 状态机与单一 Portal layer 管理，Session 行不得持有自己的 timer 或 open state；侧栏根节点通过 `pointerover/out` 委托处理跨行 hover，document/window 只发送统一 cancel。纯状态测试锁定 pending cancel、旧 epoch、跨行替换、无效/脱离 anchor 与 keyboard focus；真实浏览器回归依次验证移到 Chat 立即消失、等待期 pointerdown 后不得迟到弹出、跨两行切换始终只有一张卡片。显示前仍须复核原行连接且处于 `:hover`，MutationObserver 必须在列表刷新移除 anchor 时关闭浮层。

正式浏览器 release gate：

```bash
npm run test:release
```

`test:release` 先执行完整 `test:ci`（包括上述确定性 P0 浏览器 gate），再运行真实 Codex、Claude、
OpenCode provider smoke。真实 provider smoke 不允许用 fake provider 当作交付依据：

- `scripts/codex-browser-smoke.sh`
- `scripts/claude-browser-smoke.sh`
- `scripts/opencode-browser-smoke.sh`

它会校验每家 provider 都报告 `ok=true`。Codex / OpenCode 必须覆盖真实浏览器核心 case：

- `REAL-PROVIDER-001`
- `REAL-CHAT-ORDER-001`
- `REAL-CHAT-UNIQUE-001`
- `REAL-STOP-NORMAL-IDLE-001`
- `REAL-INTERRUPT-ONCE-001`
- `REAL-INTERRUPT-RECOVERY-001`
- `REAL-INTERRUPT-MULTI-TURN-001`
- `REAL-HISTORY-REPLAY-001`
- `REAL-HISTORY-RESUME-001`
- `REAL-SECOND-TURN-001`

Claude 使用 tmux/TUI passthrough 专用 case，而不是 Codex/OpenCode 的 provider-server Stop/interrupt case：

- `REAL-CLAUDE-TMUX-MIRROR-001`
- `REAL-CLAUDE-PASSTHROUGH-001`
- `REAL-CLAUDE-ESC-BEST-EFFORT-001`
- `REAL-CLAUDE-NO-SYNTHETIC-INTERRUPT-001`
- `REAL-CLAUDE-HISTORY-REPLAY-001`
- `REAL-CLAUDE-HISTORY-RESUME-001`
- `REAL-CLAUDE-SECOND-TURN-001`

其他 deterministic fake browser smoke 仍然是开发期保护和快速定位工具；其中工作区生命周期 gate 已提升为
CI P0 门禁。任何单独 fake smoke 都不能替代 `npm run test:release` 的真实 provider 验收。

当前 release browser gate 覆盖：

| Case | 状态 |
|---|---|
| `REAL-PROVIDER-001` | real-provider covered |
| `REAL-CHAT-ORDER-001` | real-provider covered |
| `REAL-CHAT-UNIQUE-001` | real-provider covered |
| `REAL-STOP-NORMAL-IDLE-001` | real-provider covered |
| `REAL-INTERRUPT-ONCE-001` | real-provider covered |
| `REAL-INTERRUPT-RECOVERY-001` | real-provider covered |
| `REAL-INTERRUPT-MULTI-TURN-001` | real-provider covered |
| `REAL-HISTORY-REPLAY-001` | real-provider covered |
| `REAL-HISTORY-RESUME-001` | real-provider covered |
| `REAL-SECOND-TURN-001` | real-provider covered |
| `REAL-CLAUDE-*` | Claude tmux passthrough covered |

当前 release browser gate 聚焦真实 provider 的核心痛点：Chat 气泡顺序、重复气泡、Stop 消失、重复 Stop、中断提示唯一且锚定、history replay、claim 后继续发送。P1 移动端输入法、TUI surface 视觉细节、Council UI 仍需要额外 fake/browser/manual QA。后续新增历史 bug 时，先在 manifest 增加 case，再补对应 browser 或 runtime gate。

## 推荐命令矩阵

快速开发 gate：

```bash
npm run typecheck
npm run test:web
npm run test:provider-contracts
npm run test:regression:e2e-plan
npm run test:p0:browser
```

runtime/TUI gate：

```bash
npm run test:runtime
npm run test:tui-mux-auto
npm run test:smoke:stored-catalog-browser
npm run test:regression:e2e-browser
npm run test:smoke:native-browser
```

跨浏览器 browser smoke：

```bash
npm run test:smoke:native-browser
npm run test:smoke:native-browser-webkit
npm run test:smoke:native-browser-firefox
```

真实 provider smoke：

```bash
npm run test:regression:e2e-browser
npm run test:smoke:codex-browser
npm run test:smoke:claude-browser
npm run test:smoke:opencode-browser
```

真实 provider smoke 是交付人类测试前的正式门槛。失败时必须先区分：RAH 回归、provider 版本漂移、账号/quota/网络问题。

## Browser E2E 断言标准

浏览器测试不能只看 HTTP 成功，必须断言 UI：

1. 气泡 DOM 顺序。
2. 每类气泡数量。
3. Stop 按钮出现/消失。
4. interrupt notice 位置。
5. 刷新后 transcript 不重复。
6. 打开/关闭 TUI 后 Chat 仍可发送。
7. Archive 后 live session 从侧栏消失。
8. 截图保存到 `test-results/browser-e2e/...`，失败时必须能复盘。
9. 测试结束后的 workspace/provider-state 清理只移入废纸篓/回收站，不直接永久删除。
10. `npm run test:smoke:stored-catalog-browser` 必须走真实设备配对页，并记录 Recent、All、turn page 与删除 delta 的响应大小；不得通过测试专用认证旁路。
11. 工作区生命周期用例必须从真实 UI 点击添加、新建、移除和刷新；只调用 store/API 或只做源码正则匹配不算浏览器覆盖。
12. 工作区与 session 行必须使用稳定 identity 选择器断言，禁止用易重复的可见标题代替实体身份。
13. PWA 布局用例必须同时断言计算样式和几何边界；只看截图、只断言 className 或只确认元素可见都不足以锁定阅读密度。
14. PWA 自动化必须显式模拟 standalone display mode 并使用 390px 级竖屏视口；普通窄浏览器不能替代 PWA 分支。

## P0 发布事故判定与门禁

下列任一现象属于生产 P0，而不是普通视觉回归：

- Workspaces 列表错误清空，或空列表无法添加工作区。
- 添加工作区后 UI 不出现、出现重复行，或必须刷新才正确。
- 移除工作区后其 session 继续残留，或误删显式注册子工作区的 session。
- 工作区行新建按钮没有把目标目录带入 New task composer。
- 刷新、切换焦点或重选 session 导致工作区/session 数量、顺序或归属变化。

这类修复必须同时具备四层证据：

1. selector/store unit test：锁定 canonical path、父子归属和 optimistic intent。
2. daemon state test：锁定持久化顺序、删除和重新添加。
3. 生产构建真浏览器 test：从用户点击入口跑完整生命周期，并断言 DOM 与 API 同步。
4. release-gate contract test：证明上述 browser test 确实被 `test:ci` 调用，避免“用例存在但 CI 没跑”。

只有单元测试、源码字符串断言、手工截图或刷新后的正确结果，都不能单独关闭此类 P0。

## 新 bug 进入流程

1. 先在 `scripts/regression_e2e_manifest.ts` 增加或更新 case。
2. 如果能 fake，优先写 unit/fake browser 自动化。
3. 如果只能真实 CLI 复现，先写 manual/real smoke case，并说明阻塞原因。
4. 修复代码。
5. 跑 case 对应命令。
6. 再跑快速 gate，确认没有破坏既有场景。

## 当前自动化缺口

1. 部分 P0 已有 unit 覆盖，但缺 DOM 级 fake browser 断言。
2. Chromium standalone PWA 已覆盖 workspace context、Chat disclosure 与对话密度；真实 iOS 输入法、WebKit 字体栅格化和 safe-area 仍需要真机补充。
3. Codex/OpenCode native server 多客户端同步需要继续扩大真实 provider smoke。
4. Council UI 目前是 P2，暂不进入核心 release gate，但要复用同一套 provider/model/mode 控件测试。
