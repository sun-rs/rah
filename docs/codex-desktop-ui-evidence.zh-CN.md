# Codex Desktop 会话 UI 证据

状态：版本绑定的产品行为研究，不是公共 API

复核日期：2026-07-12

## 1. 样本

本次检查的本机应用：

- App：`/Applications/Codex.app`
- `CFBundleShortVersionString`: `26.707.31428`
- Build：`5059`
- Electron：`42.1.0`
- 内置 Codex：`0.144.0-alpha.4`

应用的 `app.asar` 可以正常解包，前端是压缩后的 Electron/Vite bundle，并非加密二进制。但它没有源码映射，符号会变化，也没有证据表明这些 UI 代码是对外开放、可复制依赖的源代码。

因此证据分级如下：

- app-server Rust 协议：可依赖。
- Desktop bundle 中观察到的交互：可借鉴。
- bundle 内部函数、类名、DOM 和 CSS：不可依赖。

## 2. Turn 级“已处理”

当前 Desktop 将一次 turn 的过程收在一个可折叠区域中：

- 运行中：`Working` / `Working for {time}`
- 完成：`Worked for {time}`，中文为 `已处理 {time}`
- 用户中断：`You stopped after {time}`

计时以 turn 的开始、完成时间为依据，运行时每秒更新。完成后默认可以折叠；最终 answer 保持在折叠区域之外。

这解释了用户截图中的行为：commentary、reasoning、工具活动属于一次 turn 的处理过程，final answer 是该 turn 面向用户的终态输出。

## 3. 过程内容分组

Desktop 不是把每个原始事件都渲染成独立气泡，而是先分类，再组合连续 activity：

- reasoning/commentary
- commands
- file changes
- read/list/search files
- web searches
- MCP/tools
- subagent activity
- context compaction

多个连续命令可压缩为 `Ran multiple commands`，中文为 `运行了多个命令`。该命令组可以再次展开，形成两级折叠：

1. turn 处理过程整体折叠。
2. 过程内部的同类 activity 批次折叠。

Desktop 还会把 compaction 表达为紧凑的系统活动，而不是普通 assistant 消息。

## 4. 最终回答

最终回答的关键语义不是“最后一个 assistant 文本”，而是：

- `agentMessage.phase === final_answer`，或
- 在 phase 缺失时，由 turn 完成和 provider 兼容规则确定的终态 answer。

final answer：

- 不进入“已处理”折叠体。
- 保留主要 Markdown 阅读样式。
- 提供整段复制等 answer 级操作。

commentary：

- 属于 process。
- 视觉弱化。
- 默认随 turn process 一起折叠。

## 5. Activity 摘要

完成后的 process header 不是原始事件列表的简单计数。Desktop 会按 activity 语义生成摘要，例如：

- 运行了多个命令
- 编辑了文件
- 读取了文件
- 搜索了网页
- 调用了工具
- 启动或更新了 subagent

这说明摘要应由有语义的 item 投影生成，而不是由 React 遍历任意 FeedEntry 临时猜测。

## 6. 对 RAH 可直接吸收的设计

- Turn 是折叠、计时、终态和错误的边界。
- Final answer 与 process 是结构关系，不只是颜色差异。
- Activity batch 是 process 内部的第二级组合。
- active process 默认展开；completed process 默认折叠。
- failed item 应在折叠摘要中留痕，但不能把整个 turn 错判为 failed。
- subagent activity 是主 turn 的内部 activity；只有主 `turn/completed` 才能结束主 turn。

## 7. 不应照搬的部分

- RAH 不能绑定 Codex 的 React 组件或私有 bundle。
- RAH 不能把 Codex item union 直接定义成跨 provider 公共协议。
- RAH 不能牺牲 Claude、OpenCode、Council、Canvas 和跨设备 Web/PWA 边界。
- RAH 不能复制官方账号、云端同步或 remote-control 假设。

RAH 要学习的是“turn-first conversation projection”，不是把产品变成 Codex Desktop 克隆。

## 8. User message navigation rail

Desktop 的实际实现位于版本化 bundle `thread-user-message-navigation-rail-*`。它不是 Canvas
minimap，也不会把全部 turn 等比例压缩到聊天视口高度：

- 少于 4 个 user turn 时不显示 rail。
- 每个 turn 是一个真实 button row，固定高度 10px、可访问、可聚焦。
- rail 最大高度为 `min(70vh, 40rem)`；超长会话在 rail 内部滚动。
- 当前聊天视口内的 turn 由 `IntersectionObserver` 标记，rail 自动保证当前项可见。
- hover、focus 或 pointer scrub 会横向放大当前 marker，并按 0.7 / 0.4 / 0.2 的比例放大
  前后三个相邻 marker。
- pointer drag 可以连续选择 turn；点击或键盘操作可以跳转。
- tooltip 读取 turn preview，而不是重新扫描 DOM。内容包括用户消息、assistant 摘要以及最多两个
  output，剩余 output 显示 `+N`。

RAH 原先的 Canvas 近似实现存在两个结构问题：异步历史到达前 Canvas host 尚未挂载时，
`ResizeObserver` 不会重新绑定；即便完成绘制，把 1586 个 turn 压入 558px 也只剩约
0.35px/turn，无法逐条画出。当前实现已改为与上述行为证据一致的完整可滚动目录：每个 logical
turn 都拥有一个固定 10px 高的真实 button row，轨道在 `min(70vh, 40rem)` 内部滚动，不再进行
SVG/Canvas 采样。pointer scrub、键盘和点击都直接映射唯一 turn；当前项只调整轨道自身的
`scrollTop`，不会借助 `scrollIntoView` 牵动聊天阅读位置。未加载 turn 点击后只请求该 turn
detail；加载完成后使用 turn 级锚点定位，优先用户消息，没有可见用户项时回退到
Working/Worked、final answer 或 Outputs。PWA 不显示 rail，也不会为 rail 预取 turn directory；
触摸设备继续使用聊天滚动和按需向上分页。Desktop 的 bundle 仅作为行为证据，RAH 不依赖其
文件名或私有符号。

## 9. Outputs

Desktop 的 turn preview 和右侧 `Outputs` 使用同一份结构化 output 投影。当前观察到的 output
种类包括：

- `file`
- `generated-image`
- `website`
- `external-resource`
- `google-drive`
- `appgen-app`
- 导航摘要中还可表达 `commit`、`pull-request`、`review` 和 `app`

文件和图片不是靠 Markdown 正则临时识别。output 记录持有稳定的 path、URL、label 和类型，UI
据此完成：

- 按扩展名显示文件类型图标。
- 图片显示缩略图并进入图片预览器。
- 文件进入统一 file preview / side panel。
- 网站进入 browser preview。
- output 在 turn tooltip、最终回答附近和右侧汇总面板复用。
- 同一生成图片可以拥有稳定序号和独立预览 tab 标题。

## 10. Sources

Desktop 将 `Sources` 与 `Outputs` 分开：source 表示任务输入和执行过程中使用的材料，output
表示任务产生或交付的结果。Sources 聚合自：

- 用户消息和 composer attachments 中的文件、文件夹和本地图片。
- agent 读取的本地文件。
- 外部资源和连接的 app。
- MCP tool/server。
- web search query 和打开过的网页。

每个 source 还可以带有语义活动：

- `provided`
- `read`
- `searched`
- `fetched`

聊天侧摘要只显示前 3 项并提供 `View all`；完整列表在 side panel 中展示文件路径、URL、工具
调用和搜索/打开次数。文件、图片、网页都通过统一 open router 打开，不让普通 `<a href>`
落到 RAH HTTP origin。

## 11. RAH 的吸收边界

RAH 应在 Conversation 中增加 provider-neutral 的资源层，而不是把上述 Codex 私有 union
直接暴露给前端：

1. `ConversationOutputProjection`：描述 file、image、website、commit、review 等交付物。
2. `ConversationSourceProjection`：描述 file、URL、tool、app 及 provided/read/searched/fetched
   活动。
3. provider adapter：Codex 使用原生 item 和 tool artifact；Claude/OpenCode 使用各自事件投影到
   同一公共结构。
4. session aggregator：生成 turn preview、session Outputs 和 Sources；负责去重和稳定 identity。
5. open router：本地文件和图片进入 Inspector preview，网页进入 browser surface，外部资源才走
   受控外链。
6. UI consumers：navigation rail、final answer、Inspector/side panel 只消费公共投影，不再各自解析
   Markdown、tool output 或 JSONL。

迁移顺序应是：先建立投影和 identity，再接 navigation preview，随后接最终回答中的语义链接和
右侧 Outputs/Sources。不能先画完整卡片再反向猜协议。

## 12. 已落地的 RAH UI 边界

- Conversation 首屏只取最近 20 个 turn；向上分页在虚拟列表计算前投影 prepend anchor，
  新页到达时保留阅读位置，不先渲染一个错误窗口再由 DOM 事后纠偏。
- 本地刚发送的 user message 以 `clientMessageId` 进入同一 canonical feed；服务端回传同一 id 后
  替换 optimistic item，不等待 assistant 完成，也不产生双份用户气泡。
- 最新 `plan` 不再作为普通 process item 随聊天向上滚走，而是在聊天区域底部显示为可展开的
  Task Summary；原始 step/status/explanation、turn 状态和 activity 摘要仍来自 provider-neutral
  projection。
- `ConversationTurnProjection.activities` 是 process 摘要的唯一语义来源。普通非零命令退出属于
  `issueCount`（Review result），只有 provider/tool transport failure 才属于 `failureCount`；React
  不再用字符串或卡片颜色推断整个 turn 是否失败。
- Codex stopped session 的 Archive 使用官方 `thread/archive`；Archived ref 从 Chats Recent/All
  中隐藏。其他 provider 只有存在等价、可逆的原生语义时才暴露 Archive。
- RAH 已建立 provider-neutral `ConversationOutputProjection` / `ConversationSourceProjection`。
  资源 identity 和归类由 daemon conversation projector 负责，projection store 在 history/live
  合并后重新从 canonical items 计算；React 不再分别扫描 Markdown、tool card 和 JSONL。
- Inspector 已提供 Changes / Outputs / Sources / Files 四个视图；最终回答下方的资源卡与 turn
  navigation preview 复用同一 turn outputs。图片卡按可见性请求 bounded thumbnail，本地文件继续
  进入统一 Inspector preview，URL 使用受控外链。
- Outputs 接纳成功的 file write/edit/patch/notebook/media 证据；失败操作、普通 inline code、裸
  文件名、final-answer Markdown 链接和只读 source 不会被猜成 output。历史 summary 若没有
  provider 资源证据则保持空；展开 turn detail 后再由结构化 tool/observation 补齐。
- Sources 独立聚合用户 provided attachment、agent read/search 的文件和 web search/fetch URL，
  并保留 provided/read/searched/fetched 活动；与 Outputs 不混用。
- 最终回答 Markdown 采用 Desktop 证据对应的系统字体、14px 字号、1.5 行高、20px 块间距和
  24px 列表缩进；过程消息继续使用较弱的视觉层级，不与 final answer 混淆。
