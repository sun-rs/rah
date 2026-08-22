# RAH 当前系统设计总览

复核日期：2026-08-13

本文记录当前已经锁定的 RAH 系统设计，作为后续维护和接入新 provider 的主参考。细节文档见 [docs 索引](./README.md)。

## 1. 项目定位

RAH 是一个本地优先的 AI 工作台。它让 running session 由本机 daemon 持有，并让 Web、PWA、iPad/iPhone 与 Canvas pane 接入同一个 provider session；原生 TUI 作为工作台内的可选视图提供。

当前 `main` 把 running 主线拆成 provider runtime：

- Codex / OpenCode 默认走 `native_local_server`，RAH 通过 provider 官方本地 server 获取结构化 live event、发送 turn、执行 interrupt/stop。
- Codex / OpenCode 的本地 TUI 是 provider 官方 client/view，例如 Codex `codex --remote ... resume <threadId>`、OpenCode `opencode attach ... --session <id>`。
- Claude 默认走 `tui_mux_fallback`，tmux/TUI mux 负责原生 TUI 工作现场，结构化 Chat 来自 provider 原厂历史文件 mirror。
- Web/PWA 只有显式打开 `TUI` 视图才 claim TUI display surface；普通 Chat 浏览不应触发 TUI attach。

当前 running 主线收敛为三家 provider：

- Codex
- Claude
- OpenCode

其它低频 API-key 模型优先通过 OpenCode + API provider / 中转站承载，不维护独立 CLI adapter。

当前核心目标：

- 本机 daemon 统一持有 provider runtime、事件、控制权和 provider launch/mirror adapter。
- Codex/OpenCode 的实时 truth 是 provider native local server event；Claude fallback 的现场连续性由 tmux/TUI mux 维持。
- 结构化 Chat/Timeline 来自 provider server event 与原厂 jsonl/db/session history mirror，不从 ANSI/TUI 输出反推。
- Web UI 只消费 RAH canonical protocol，不直接依赖 provider-native 事件。
- Web/PWA New、Canvas New 和 Resume 对 Codex/OpenCode 默认进入 native local server runtime；Claude 默认进入 tmux/TUI mux fallback。
- 历史浏览先加载最近 tail，再按上滚分页加载更早内容，不一次性把完整历史塞进前端。

## 2. 包结构

```text
packages/
  runtime-protocol/   协议、事件类型、API 类型、contract validation
  runtime-daemon/     HTTP/WS server、RuntimeEngine、SessionStore、EventBus、MuxRuntime、identity-only ProviderAdapter + capability maps
  client-web/         React workbench、Zustand store、session/history/control UI
```

关键运行入口：

- 本机统一入口：`http://127.0.0.1:43111/`
- 开发前端：`http://127.0.0.1:43112/`
- daemon 默认端口：`43111`
- daemon 当前有意监听 `0.0.0.0`，用于支持手机/平板在同一局域网访问；是否能访问还取决于宿主机防火墙和网络环境。
- daemon 的 HTTP API、事件 WebSocket 与 PTY WebSocket 共用设备认证边界；本机直连 `127.0.0.1` / `localhost` 无需配对，局域网、Tailscale 和代理入口仍必须通过 `rah pair` 配对。端口可达不代表可以远程操作 RAH，详见 [设备认证与配对边界](./device-authentication.zh-CN.md)。
- 离开局域网后的推荐访问方式是 Tailscale Serve / MagicDNS；方案边界和 Surge 共存经验见 [远程访问：Tailscale、Cloudflare 与 Surge 共存](./remote-access-tailscale-cloudflare.zh-CN.md)。

## 3. Runtime 分层

### 3.1 runtime-protocol

`runtime-protocol` 是最低层契约，负责：

- `SessionSummary`
- `RahEvent`
- session capability
- API request/response 类型
- contract validator

原则：

- 前端和 daemon 都只能通过这层共享结构。
- provider-native 字段不应泄漏到主 UI。
- 新增事件前必须先判断是否能映射到已有 canonical event family。
- `timeline.item.*` 可以携带可选 `TimelineIdentity`，用于把 live stream 与 history replay 的同一条真实消息映射到同一个 `canonicalItemId`。

Timeline identity 的硬约束：

- `canonicalItemId` 只由 `provider + providerSessionId + turnKey + itemKind + itemKey` 这类身份字段生成。
- `origin` 只能表示来源是 `live` 还是 `history`，不能进入 canonical key。
- `contentHash` 只能用于校验或弱 fallback，不能作为主身份。
- `sourceCursor` 只记录原始证据，例如文件行、byte offset、provider message id、DB row id；它不参与 canonical key。
- `confidence` 标记身份强度：`native`、`derived`、`provisional`、`heuristic`。
- daemon 会对高价值 timeline item 缺失 identity、identity 与 item/provider 不一致、同一 `canonicalItemId` 结构冲突做诊断 warning；这些 warning 不进入 UI，只用于发现 adapter 漏洞。

### 3.2 runtime-daemon

`runtime-daemon` 是本机唯一 runtime owner，负责：

- HTTP API
- WebSocket event stream
- static web serving
- session lifecycle
- provider launch/mirror adapter registry
- native TUI PTY runtime
- stored history catalog
- history snapshot paging
- daemon-owned provider model catalog refresh（启动后 1 秒，随后每 30 分钟）

HTTP 数据面有明确边界：static serving 只能读取构建产物目录；任意 host path 只能通过受设备认证保护的 file preview route 读取，并在磁盘读取、转换输出和响应大小三层限流。不能把 daemon 变成通用静态文件服务器。

关键对象：

- `RuntimeEngine`
- `SessionStore`
- `EventBus`
- `PtyHub`
- `PtySessionRuntime`
- `MuxRuntime`
- `TmuxMuxBackend`
- `RuntimeTerminalCoordinator`
- `RuntimeWorkspaceOperations`（workspace/git/file inspection 的唯一 daemon owner；`RuntimeEngine` 只转发公共 API）
- `NativeTuiMirrorRuntime`
- `NativeTuiMirrorProvider`
- identity-only `ProviderAdapter` + explicit capability maps（provider-server control / enhancement / stored-history seams）
- `HistorySnapshotStore`
- `RuntimeConversationPages`（canonical page、revision-keyed hot cache 与 resident overlay 的唯一编排 owner）
- `RuntimeInputAcceptance`（等待精确 `session.input.accepted`，禁止把 transport write 当交付）

### 3.3 client-web

`client-web` 是 workbench UI，负责：

- 工作区、左侧 session 列表、右侧 inspector
- session feed 渲染
- composer 与 control action
- history replay / claim / running attach
- provider mode/model UI（只消费 adapter 暴露的 catalog/session state，不解释 provider-native 参数）
- mobile / desktop responsive shell

前端主原则：

- 使用 canonical feed 渲染，不理解 provider 原生日志格式。
- `App.tsx` 只负责 workbench 组合；动态页面 registry、New Session draft persistence、foreground Session recovery 和 file preview error boundary 各自拥有独立模块，不能回流为第二套内联实现。
- 如果 timeline event 有 `canonicalItemId`，projection 必须按该 id upsert；`messageId` 和 text/time 去重只作为旧事件 fallback。
- Provider 的 event/历史 arrival order 不是 turn 展示顺序。共享协议函数
  `orderConversationTurnItems` 固定输出“初始 user → process/后续 Guide → final”，并同时用于
  daemon projector、resident/history overlay、Web baseline/delta merge 与 Chat renderer。Resume
  启动时先出现 compaction、后出现初始 user 是合法证据顺序，但绝不能把 Worked 显示在问题上方。
- 通过 `useSessionStore` 管 session projection、selected session、history paging、event sync。
- 对长历史使用虚拟窗口和 measured row height，不把所有 DOM 一次性渲染。
- 非 PWA 的 ChatThread 提供按用户轮次派生的 `Turn Navigator`。每个刻度代表一条用户消息及其后续 assistant 处理过程/最终回答；Codex 后台 `Turn Directory` 可以提供尚未载入正文的完整 turn 列表，点击未加载刻度只请求对应 byte range。可见状态和已加载 turn 的定位只使用当前虚拟布局，不扫描整页 DOM。休眠状态只显示 1px 高、短而浅的刻度，当前可见 turn 不再默认变成黑色长条；只有鼠标、键盘焦点或拖动进入某个刻度时，目标及相邻刻度才逐级变长并显示缩略预览。PWA 不展示该控件。
- mode/model/config 的 provider 差异必须由 adapter 通过 `ProviderModelCatalog`、`SessionModeState`、`ManagedSession.model/config/modelProfile` 暴露，前端不能把 mode 翻译成 provider-native 启动参数。
- 前端模型目录按 `provider + cwd` 缓存，并以 request generation 拒绝迟到响应；浏览器只做当前 picker 的 5 分钟按需 freshness，不拥有全局 30 分钟刷新循环。
- Home New task 与 Session Chat 必须复用 `UnifiedComposerSurface` 和 `UnifiedComposerToolbar`：白色内容面、单层细边框、24px 圆角和克制阴影，文本区与所有 action、附件和注释都在同一 surface 内。统一占位文案为 `Work with Rah`。工具栏遵循 Codex Desktop 的 ghost 层级：静止态不显示独立 pill 边框或底板；`+` 是最左侧 20px/1.75 细描边动作，随后是 permission 与 Plan，model 直接位于主动作左侧。Plan 激活只使用资源蓝文字和更高字重，继续保持透明背景、无阴影；PWA 空间不足时复用同一控件但把内容压缩为加粗的 `P`。Provider 的 mode/model catalog 在页面或 Session 可见时后台加载，与点击 composer、running/stopped 解耦；完整模型 ID 与灰色 effort 默认显示。运行态尚未回传显式 effort 时使用 catalog 对该模型解析出的默认/最强可见 effort，只有模型描述明确把 `defaultReasoningId` 声明为 `null`（Provider 自管默认）时才隐藏。用户对具体 Session 选择的 model / effort / optionValues 以 `provider + providerSessionId` 为稳定身份写入最多 256 项的有界浏览器配置；刷新、Stop 和 Resume 都读取同一项，不能回退到 catalog 最后一档。stopped -> starting -> live 只允许切换控件的数据源和 disabled 状态，不允许卸载 permission、Plan 或 model 节点；需要显式 Resume/claim control 的过渡面也必须直接展示同一组独立控件，不能重新折叠进设置弹层。权限菜单只保留有间距的选项名、必要图标和选中标记，不显示说明。provider selector 固定为 36px 的单层选择条：静止态无常驻灰底、外框、滑动高亮或单项底板；Desktop 当前项只用前景色、600 字重和与文字实际等宽的蓝色 2px 横线表达，PWA 隐藏文字时回退为蓝色 `24×2px` 图标标记。指针 hover 时只能给整组增加一层临时轻背景，移开即隐藏；键盘 `focus-visible` 期间保留同一组背景，各 Provider 项始终透明，不能再形成嵌套 pill。Chat 只有一个黑白 Send/Stop 动作槽；PWA 失焦时单行折叠，聚焦或任一 composer 菜单保持展开时显示全部配置，菜单打开不能导致回缩。permission、Plan、model/effort、附件、context usage 及其 Portal 菜单都由共享 `composer-focus-ownership.ts` 归属于同一编辑会话：内部 pointer 默认保留 textarea focus，只有 true outside 或显式 release 遮罩才允许 blur，禁止各控件分别实现会使 iOS 输入法反复开合的 outside-click/focus 分支。New task 聚焦前后几何不变；所有宽度都复用一条右对齐 toolbar rail，空间不足时先收紧间距、把 permission/Plan 文本压缩为图标并限制 model 宽度，不能另建移动端布局。Workspace selector 不属于 composer action：它位于 composer 下方内收 12px 的低对比附属条，条高 40px、顶部 8px 被 composer 覆盖、实际只露出 32px，内部选择按钮固定 28px；超过 18 字符才跑马，不能挤占 agent 配置或发送动作。
- 本地附件是共享 composer 能力，覆盖 Home New、Canvas New 和可输入的 running Session composer。桌面环境点击 `+` 仍直接打开工作区文件引用选择器；compact touch/PWA 环境点击 `+` 打开一个平台中性的菜单：`Reference workspace file`、`Take photo`、`Choose from device`。第一项保留 daemon 主机工作区的 `@` 引用能力，后两项上传当前设备的照片或文件，不能用 `Mac` 等宿主平台名称描述该能力。
- 当前设备选择或粘贴的文件先通过受设备认证保护的 `POST /api/attachments` 上传到 daemon。浏览器只保存附件 metadata 和 opaque id；daemon 在 `RAH_HOME` 下以私有权限保存原始字节，并在真正发送 turn 时解析成宿主机绝对路径。单文件上限 25 MiB、单条输入最多 10 个附件；输入可以只有附件而没有文本。前端不能把 data URL/base64 拼入 prompt、WebSocket event 或历史正文。
- provider adapter 负责原生映射：Codex 图片使用 `localImage`，OpenCode 使用原生 file part，Claude/TUI fallback 使用 daemon 主机路径文本。Chat feed 只展示 `Image xN` 等轻量事实，不展开二进制内容。历史解析仍识别旧版本已经持久化的 data image URL，但这只是只读兼容，不是新的发送 fallback。
- running turn 中继续发送的文本输入必须进入显式 FIFO 队列。Web 在提交前生成稳定的 `clientMessageId/clientTurnId`，daemon 通过 `session.input_queue.changed` 发布完整队列快照；同一条排队消息在 Chat 中只保留一条 user row，并显示位置、编辑与撤回动作。队列开始执行后该 row 由相同 identity 的 canonical user item 接管，不能靠文本或时间窗口追加第二份。编辑/撤回使用 `clientMessageId` 定位；目标已开始执行或已经消失时返回 `409`，客户端保留最新流式投影并提示冲突，不能恢复整份旧 projection 覆盖请求期间到达的事件。带图片的排队输入暂不允许编辑，但可以撤回。
- 队列从 waiting 跨入 provider turn 时必须保留单一的提交状态。所有 provider 路径先把输入放入 canonical queue，再尝试 PTY injection 或 structured request；只有 provider echo / `turn/started` / provider request completion 能针对相同 `clientMessageId` 发布 `session.input.accepted`。启动/恢复 HTTP 等待该精确回执后才成功。PTY write、普通 HTTP/RPC 返回、runtime 创建或 queue disappearance 都不是 acceptance；明确拒绝或传输结果不确定时输入仍须可见、可恢复。其他客户端或 TUI 发起的 turn 不能误清队列。
- turn 文件改动只接受 provider turn 的权威结构化事实。Codex `turn/diff/updated` notification 携带该 turn 当前完整聚合 diff；daemon 必须先按稳定的 `{provider, providerSessionId, turnId}` 将其原子替换到 `~/.rah/runtime-daemon/turn-artifacts/`，只有 provider 没有稳定 session id 时才回退 Runtime ID。成功后才发布轻量 `turn.file_changes.updated` 摘要，projector 对同一 turn 执行 replace，不累计重复 patch。完整 diff 和 provider raw notification 都不能进入 event history，避免大 patch 反复进入 WebSocket、projection 和历史分页；artifact 写入失败时不发布摘要，也不能中断其余 provider 事件流。
- turn artifact 是不可变阅读快照，而不是 Git 操作界面。单文件默认最多保存 512 KiB、单 turn 默认最多 4 MiB，UTF-8 截断必须保持字符边界并向 UI 标记 `truncated`。同一 turn 收到新的 `turn/diff/updated` 时原子替换整份 artifact；不能 append patch，也不能在读取时访问当前工作区文件补齐内容。Codex rollout 中的 `patch_apply_end` 只证明发生过一次 patch 操作：重复编辑、回退和跨工具修改使它不具备最终净差异语义，因此只能进入 Worked 过程证据，绝不能合成 Changed files 摘要或点击详情。
- artifact writer 在 provider notification 热路径之外异步执行，但同一 live bridge 的 notification 和同一稳定 owner/turn 写入必须保持到达顺序。摘要事件仍须等待原子 manifest 提交成功后发布；daemon 正常退出会等待在途写入。启动时和每 15 分钟执行保留维护：默认删除 30 天前的 artifact，每个 provider thread 最多保留 200 个、全局最多 2,000 个且总量最多 512 MiB；维护不能删除正在写入的 turn。Resume 虽然创建新的 Runtime ID，但只要仍指向同一 provider thread，就必须继续读取已经捕获的 turn artifact；Fork 使用新的 provider thread，artifact 与父线程隔离。
- 最终回答出现时可先展示 turn outputs，但“Changed N files”卡片只有在 turn completed/failed/interrupted 后才出现，避免工作中数字反复跳变。卡片默认只展开 3 个文件，之后每次最多追加 50 个；Inspector 的 `This turn` 默认显示 40 个，之后每次最多追加 40 个。会话页输出前必须以同一稳定 owner/turn 的 artifact 覆盖任何 history projection 中的摘要；artifact 不存在就删除摘要且不显示卡片，直接请求该轮详情时返回 unavailable。点击文件后通过 `/api/sessions/:sessionId/turns/:turnId/file-diff` 懒加载同一 artifact 的该轮冻结 diff，不能回退到 provider rollout patch 或当前 workspace，也不能预取整轮大 patch。
- provider/model/effort 元信息统一收敛为 `Working / Worked / Interrupted` 状态行最左侧的
  provider 图标，与状态文字共享一行；不能进入 final footer，也不能在 Worked 与 final 正文之间
  插入独立标题行。Desktop 悬停、PWA 点按图标显示完整 provider/model/effort 与来源；模型事实
  尚未到达时仍保留 provider 图标，final footer 只承载 Copy 等回复动作。
- 本轮文件入口不再维护 Inspector 分流：Changed Files 的 `审查` 与任一文件行都打开同一个
  turn-scoped `ReviewDialog`，文件行只把该 path 设为初始选中项；Desktop、PWA 与 Canvas 都不得
  打开右侧 Inspector 或临时文件查看器。compact/PWA 的 Review 文件列表收进顶部可折叠选择条。
  Workspace/Files/Outputs/Sources 仍按现有响应式协议使用 Inspector。
- turn Outputs 与 Changed files 必须保持独立语义，但不是互斥集合。Changed files 只表达 provider 权威本轮 diff；Outputs 表达 agent 明确交付给用户的资源。同一文件可以既是本轮修改，又是最终交付，因此允许同时出现。provider 原生 output resource（包括 assistant attachment/artifact）始终优先且不受扩展名限制；当 provider 没有暴露完整 output union 时，RAH 的兼容推断必须更保守：只接受“成功写入或编辑 + final answer 明确呈现同一条权威 path、URL 或文件名”的文档、媒体、数据或归档类交付物。普通 `.rs`、`.ts`、`.py` 等源码即使在 final answer 中被链接，也仍只属于 Changed files，除非 provider 原生将它暴露为 output。Changed files 是否已经到达、资源是否属于本轮 diff 都不能改变该判断。失败操作、只读 source、普通 inline code，以及没有成功产出证据的 final-answer Markdown 链接不能制造 output；final answer 明确嵌入的本地 Markdown 图片是窄补充路径，用于 shell 生成图片但 provider 未发 artifact 的情况，远程图片和 data URL 不适用。Outputs 直接显示交付物行，首屏最多展示 3 项并提供 `Show more / Show less`。
- resource projector 必须优先消费 provider-neutral `ConversationActivityDescriptor` 的 kind/action/file targets/URLs，`tool.family` 和 provider-native observation kind 只作为兼容后备。因此 Codex code-mode wrapper、Claude 和 OpenCode 即使工具名不同，也能产生相同的 Sources/Outputs。历史列表页仍只传输有界 turn summary；选中 session 后必须先完成 Chat hydration，再按启动优先级并行预载 Changes/Files 与 daemon-owned Outputs/Sources 索引，不能等用户点击 Inspector 或具体 tab 才开始。资源索引是带版本的持久化派生数据：daemon 原子保存最后一个稳定的 Outputs/Sources 快照以及逐 turn fingerprint、detail hydration 状态和资源投影；同一 `sourceRevision` 在 daemon 重启后直接恢复，不重新扫描 provider 历史，append-only revision 只补齐新增 turn 并重验活动尾部，rewrite/truncation 则在完整分页结束后删除已消失 turn。最多 3 路 detail hydration 只作用于内部工作副本；磁盘通过同目录临时文件 + rename 提交，HTTP 在重建期间只能返回旧稳定快照或未知的 indexing 状态，前端绝不能看到逐条增长、重排的半成品列表。wire response 必须携带显式资源索引协议版本，客户端拒绝缺失/不匹配版本以及既非 `stable` 也非 `indexing` 的响应，不能再把旧 daemon 的字段缺失误判为稳定快照。session Inspector 不得把 Chat 当前已经加载的部分 turn 资源合并成临时列表；daemon 的已提交快照是唯一资源权威。持久化协议版本不兼容或缓存损坏时必须冷重建，不能发布旧协议内容。
- Outputs 与 Changed files 共享边框、圆角、颜色、文件文字规格和交互反馈，但保留不同的信息结构。Outputs 不显示冗余总标题，每行展示缩略图或类型图标、文件名、类型和打开动作；Changed files 使用独立摘要显示本轮文件数和总增删行数，再列出路径及逐文件增删统计。不能把工作区累计 diff 混入任一 turn 卡片。
- Inspector 的 `This turn` 与 `Workspace` 是两个明确 scope：前者只读本轮 artifact，不提供 stage/revert/commit；后者才读取当前工作区累计 Git 状态。禁止用工作区全局 `git diff` 反推本轮改动，因为它会混入其它 session、用户和未提交历史改动。旧历史如果没有当时保存的权威 artifact，必须显示 unavailable，不能用当前 Git 状态伪造。
- Chat 只在同一条 assistant response 内完成的原生文本选区上显示 `添加到任务 / 更多详情` 浮层；浮层以第一行选区矩形为锚、优先置于左上方，并必须夹在 viewport 内。跨消息、折叠选区、空选区和滚动后的旧选区都不能留下浮层。蓝色本地文件链接虽然可以点击进入 Inspector，其文件名仍属于可拖选、可复制的正文；拖选必须进入同一套选区保护，结束时不能误触发文件打开。`添加到任务` 把文本写入独立于 textarea 的 `SessionInputAnnotation[]`，composer 只显示可悬停预览的注释 pill；注释本身不允许产生空白用户消息。Codex Desktop 的 `更多详情` 会复用/打开 Quick Chat，连同选文、固定的 `Tell me more about this` 请求和 targeted-reply source metadata 一起提交；RAH 没有 Quick Chat，因此采用显式适配：复用同一注释，并把一条可编辑的解释请求写入当前 draft，不能暗中创建新 task。
- 注释通过 `SessionInputRequest.annotations` 穿过 resume、FIFO queue 和 provider adapter；daemon 在 HTTP 边界校验数量、唯一 ID、长度和 source，再只把有意义的 `{text, annotation}` 按顺序序列化进 `# Response annotations` transport envelope。Codex、Claude/TUI 和 OpenCode 必须消费同一语义。历史解析必须识别有效 envelope 并从可见 user text 中剥离它；Codex parser 可以保留其中的结构化 metadata，但已发送的注释不会被重建进 composer。用户自行输入的畸形或无效相似文本必须原样保留。
- Home New 与 Canvas New 的统一 Session Control 入口必须始终可见，不能因为容器过窄、provider catalog 尚未返回或宽屏快捷 selector 暂不可用而消失。宽屏 mode/model 快捷 selector 只是附加入口，不能替代统一 control。
- Session `Info` 区分 `Runtime provider` 与 `Model provider`，并同时显示 model id；Codex 从原生
  `session_meta.model_provider`、OpenCode 从原生 `providerID`/`provider/model` 读取，历史与 Resume
  继续携带该事实。未知时明确显示 unavailable，不能把 Codex/OpenCode adapter 名称当成 API 供应方。
- 回复中的本地文件链接不作为普通 HTTP 链接跳转，而是进入 Inspector file preview。Host file preview 不受当前 workspace scope 限制；workspace/session Inspector 文件树仍保持 workspace boundary。普通文本在磁盘读取阶段即执行有界 prefix read。图片 preview 按访问面分级：`localhost` / LAN private IP / `.local` 在 16 MiB inline 安全上限内可以返回原图；更大的本地图以及 Tailscale/公网访问只返回 bounded preview data，后端优先用系统图像能力生成缩略图，且远程请求不能通过 query 参数升级为原图。大 Notebook 通过有 timeout、cell/source/output 上限的隔离提取器生成预览，并丢弃图片输出；不能把“大图/大 Notebook”作为正常不可预览状态暴露给用户。
- Inspector 对 `.html` / `.htm` 提供 `Preview / Source` 双视图。任意本地 HTML 不继承 provider-native interactive visual 的执行权限：客户端把源文档作为惰性数据解析，只导入静态 DOM、内联 CSS、内联 SVG 与 data media；script、事件属性、外链、frame/object、表单提交和跨页导航全部移除或由 `default-src 'none'` 的 CSP 阻断。iframe 只启用带随机 nonce 的 RAH 装载脚本且不启用 `allow-same-origin`，因此预览不能读取主页面。读取结果被截断时只显示 source prefix，禁止渲染不完整 HTML。
- Chat Markdown 图片在展示层遵循 Codex Desktop 的缩略图协议：本地图片最高 10rem（160px），远程图片最高 12.5rem（200px）；连续的纯图片段落合并为 `flex-wrap` 图组，间距 12px。缩略图只负责辨认，点击仍进入既有 Inspector/浏览器预览；不能因原图尺寸恢复为全宽纵向堆叠。
- Conversation 字体使用独立于导航控件的 Appearance token。设置只作用于 Session/Council 对话正文，范围为 12–20px、即时应用并持久化；行高为字号 + 8px。代码字号不单独暴露，而是随正文按 11–16px 有界联动。Sidebar、标题与菜单不读取该 token。Desktop 与 PWA 使用同一所选正文大小，不再自动给 PWA 增加 2px。
- `ProviderLogo` 和 `CouncilLogo` 是标题栏、sidebar、Chats row、Canvas toolbar 的唯一图标入口。Session provider 标题图标默认是 card/pill；Council 标题图标也必须使用同样的 card/pill 外壳，小型 badge/button 再显式使用 `bare` 变体。左侧 sidebar 的 Council 图标使用黑色 glyph；其他 Council 图标默认使用橙色 glyph，并保持与同位置 provider 图标同规格。

#### 前端控制器所有权

`App` 只负责组合顶层 workbench，不再直接维护每个页面对象的传输、持久化和跳转细节：

- `useCouncilController` 是 Council 摘要目录和 Council event transport 的唯一 owner，负责合并 refresh、实时 upsert、删除和改名；`CouncilPage` 只消费受控状态并提交 updater。
- `useCanvasController` 是 8 个固定 pane、布局树、最大化、pane target、pane 右侧栏和本地持久化的唯一 owner。普通页面不能直接写 Canvas localStorage 或维护另一份 pane 状态。
- `useWorkbenchPageController` 原子处理 Home、Session、Council、Canvas 之间的页面跳转和 chrome 收敛；页面组件不能通过多次独立 `setState` 拼出一次导航。
- 普通 Session、Canvas pane 和 Side 的 conversation 内容仍由同一 Session store 与 conversation surface 驱动；控制器只改变容器和页面所有权，不复制消息状态机。

#### 唯一响应式协议

Sidebar 不允许按 viewport 各自维护视觉数值。Desktop 固定 rail 与 compact/PWA Sheet 必须共同消费 `sidebar-layout-contract.ts` 的 `codex-compact-v1` 协议；响应式层只允许改变容器形态和 action 的显示时机，不能覆盖 header、字体、行高、圆角、inset、图标槽或分区间距。

前端只使用三档响应式语义，事实源在 `responsive-layout.ts`：

- `compact`：`< 700px`，单表面、sheet/overlay、精简标题动作；Canvas 只提供纵向双 pane。
- `medium`：`700–899px`，保留完整主工作区，Inspector / Agents 使用覆盖层，不以内联右栏压缩对话。
- `wide`：`>= 900px`，完整桌面工具栏、多列 Canvas/Side 和宽布局。

Tailwind 的 `sm/md` 都映射到 700px，`lg` 映射到 900px。组件如果需要语义判断必须消费 `ResponsiveTier` 或共享常量，不能再新增 520/768/1024 等私有 `matchMedia` 阈值。设置页和启动状态页使用连续、无悬浮大卡片的工作台布局；卡片只留给真正的重复数据项、弹窗和独立工具。

桌面左侧栏使用固定 header、纵向全局导航、独立 workspace/session 滚动区和底部 Settings 动作。`codex-compact-v1` 是 Desktop 与 compact/PWA 的唯一视觉事实源：RAH header 均为 40px、无下分割线，标题距左侧控制 8px，首个 New task 距 header 4px；新设备默认宽度为 272px，用户已经调整过的持久化宽度继续优先，双击 resize divider 恢复并持久化 272px。RAH 标题固定 `16/20/600`，一级导航 `15/20/500`，分组标题 `13/18/550` 且前景混合 42%，workspace `14/20/500`，session `14/20/450`；一级导航图标为 18px、1.75 描边并与文字相隔 10px，workspace 图标为 20px 槽内的 16px、1.75 描边。两种 surface 的 workspace/session 行都固定 30px 高、10px 圆角；同组行距 2px、workspace 组距 6px、大分区间距 12px。所有 hover/选中 surface 相对内容边界左右各 8px，workspace/session 标题的中心偏差必须为 0；PWA 的侧栏滚动条不能预留 gutter 挤窄右侧。New task、Council、Canvas 等一级导航的 hover 与选中态必须复用 Session 行的同一浅灰 surface，不能再以页面白底混色制造独立白色卡片。普通 session 不显示左侧 provider 图标，嵌套 session 文字与 workspace 标题对齐，phase/unread 等状态留在右侧。动作单元在 Desktop/PWA 都是 28px；fine-pointer Desktop 仅在 hover/focus 时显示 pin/archive，coarse-pointer/PWA 常显，但 media query 绝不能改写 30px 行高或字体。Session 的 pin/archive action rail 与按钮透明、无投影，直接复用整行 hover surface；fine-pointer action 出现时状态点临时隐藏，离开后恢复，不能在 pill 内再叠灰底。Session 信息 tooltip 使用 160ms hover delay，并由整个 sidebar 的单一 controller 持有，任意时刻最多一个；从一行移到另一行时先撤下旧 tooltip，移出 sidebar、指针点击、滚动、窗口失焦、页面隐藏或 Escape 均必须同时清除已显示 tooltip 与尚未到期的待显示任务。每个延迟回调在显示前还必须复核原 Session 行仍连接 DOM 且仍处于 `:hover`，不能在用户已经点击 Chat 后迟到弹出。鼠标点击带来的 focus 不能锁住 tooltip，只有真正满足 `:focus-visible` 的键盘 focus 可以立即显示。每个已添加 workspace 显示其全部未归档根 Session：running 行显示 phase，stopped 行保留安静的静态样式；两者按 `{provider, providerSessionId}` 去重。Provider 当前 catalog 是 Session 身份、存在性与可见性的唯一权威；workbench snapshot、remembered recent、metadata cache 和 stored-history replay runtime 都只是展示/启动缓存，不能在 catalog 与真实 live runtime 都不包含某个 identity 时把旧 row 重新带回 Sidebar。完整 provider scan 会清理已移除或已过滤 row；不完整 scan 保留该 provider 的 last-good rows。用户置顶的 running Session/Council 进入 Workspaces 上方独立的 `Pinned` 区，并从原 workspace 列表移除；取消置顶后回到所属 workspace，不能同时显示两份。置顶顺序按用户操作持久化，Session 与 Council 清单尚未完成首次加载时不得把已保存项误删。桌面只存在一个固定在屏幕左上角的 edge toggle；侧栏展开、折叠时该按钮的坐标、尺寸和图标都不能变化，页面标题只预留等尺寸占位，不能再渲染第二个按钮。侧栏只在用户没有拖拽 resize 时执行 150ms 宽度过渡，拖拽期间必须关闭 transition，避免大量 session DOM 持续滞后重排。侧栏使用独立的语义背景、单像素内描边和极浅右侧阴影，不通过加深整块灰色来制造边界。`compact` 环境使用 Sheet 容器，但内部复用同一套纵向全局导航、Pinned、Workspaces 与底部 Settings 结构，不能退回顶部横排快捷图标或维护第二套导航状态。

Session tooltip 的实现协议是 sidebar 级 `idle / pending / open` 状态机加唯一 Portal layer，而不是每行各自维护 `open` 与 timer。Session 行只声明稳定 tooltip key 与当前 ARIA 关联；跨行 hover/focus 由侧栏根节点事件委托，document/window 仅发送统一 cancel。pending 状态以 epoch 拒绝旧 timer，显示前检查 anchor 仍连接且仍为 `:hover`，列表刷新移除 anchor 时由 MutationObserver 关闭。任何变更都必须同时通过纯状态转换测试与 Chromium 的离开、等待期点击、跨行唯一性回归。

iOS standalone/PWA 的 Home New task workspace selector 位于 composer 外部、但顶部 8px 收入 composer 下方的低对比附属条，保留 Folder 图标与完整可读名称；超过 18 个字符才使用共享单向跑马灯，短名称保持静止。390px 下 composer 仍与 Desktop 复用同一条 toolbar rail：权限/Plan 自动压缩为图标，模型保持在主动作左侧并在有界宽度内滚动，workspace 不参与该宽度竞争；普通窄屏浏览器也使用同一防重叠协议。Provider 组与桌面复用同一 selected/module 协议，触屏无 hover 时仍必须直接看到唯一选中项。

Session 启动画面必须把 provider identity 与 progress 分开：provider 图标保持静态且不叠加右下角 spinner，进度动画和 `Starting / Resuming / Opening` 状态同行显示。这样 provider 图标在启动前后保持同一语义，也不会出现两个边框相互遮挡。

Settings 在桌面使用可见的纵向 section 导航，在 compact 环境使用横向可滚动 section 导航；内容区采用扁平设置行与单层 section surface，不使用卡片嵌套卡片。两种容器只改变导航排布，不维护不同的设置状态。

补充侧栏状态协议：上文的“action 出现时状态点临时隐藏”只适用于支持可靠 hover 的 fine-pointer Desktop。coarse-pointer/PWA 必须同时为状态、Pin 与 Archive 保留固定槽位，不能因操作按钮常显而把 `Working`、Unread 或 Error 状态设为透明。

### 3.4 Conversation State 顶层协议

Session 和 Council 共享同一套用户可见生命周期协议，协议入口在 `packages/runtime-protocol/src/conversation-state.ts`：

- `status: "running" | "stopped"`
- `phase: "starting" | "ready" | "working" | "waiting_input" | "waiting_permission" | "stopping" | "failed" | "ended"`

状态语义：

- `running` 表示 RAH 仍持有可继续工作的执行体：native local server session、tmux/TUI mux session、Council/agent runtime，或本进程内正在启动的 council/session。是否正在 thinking、是否空闲、是否等待用户批准，都不改变 `running`。
- `stopped` 表示执行体已经不存在或不再由 RAH 管理，只剩 transcript/history/projection。`stopped` 对应用户语义是“这个对话已停止”，不是删除历史。
- `phase` 描述 `running` 或 `stopped` 内部的细分状态。`ready` 是 running 但空闲；`working` 是正在执行；`waiting_input` 和 `waiting_permission` 是运行中等待用户；`failed` 是停止在错误态；`ended` 是正常停止。
- `live`、`archived` 不属于 runtime 生命周期状态。RAH 的执行体状态统一说 `running/stopped`；`Archived` 只作为正交的会话库位置使用。

命名边界：

- 用户可见生命周期、前端 view model、workspace/sidebar/history/canvas/council 过滤，都必须使用 `running/stopped`。
- RAH 运行体生命周期 capability 必须使用 `actions.stop` 和 `stopLifecycle`。
- `previous_running` 表示“之前由 RAH running runtime 产生、现在作为 recent/stored 历史展示的记录”。旧持久化里的 `previous_live` 只作为迁移输入接受。
- `liveBackend`、`structuredLiveEvents`、timeline `origin: "live"`、`live stream/event` 可以保留，因为它们描述实时事件源或 provider 技术通道，不是用户层对象状态。
- `StoredSessionRef.libraryState.placement: "workspace" | "archive"` 是 RAH 跨 provider 的会话库位置；provider 原生历史字段可以保留 provider 自己的 `archive/archived` 命名，例如 OpenCode `time_archived`、Codex `archived_sessions`。两者都不等于 RAH Stop。

协议落地规则：

- `ManagedSession.status/phase` 是唯一用户状态；`runtimeState` 只保留为 adapter/runtime 协调与诊断源，写入时必须同步映射到 `status/phase`，前端不得用它兜底决定页面状态。
- `Council.status` 只允许 `running/stopped`，启动、失败、结束都进入 `phase`。旧 council 文件中的 `starting/running/idle/stopped/failed` 会在加载时迁移。
- `SessionActionCapabilities.actions.stop` 表示这个 running session 能否被 RAH 停止；runtime feature 使用 `stopLifecycle`。`archive/restore` 只描述 stored-history/library 动作，不能作为运行体生命周期字段。
- 前端 selector、sidebar、history dialog、Canvas pane、session info、Councils browser 都只用 `status/phase` 做用户可见判断。
- Stop/Close 是关闭 running 执行体；Archive/Restore 改变会话库位置；删除历史走 provider stored-session remove/trash 语义。三者不能和 `stopped` 混为一谈。完整事务见 [Session Library 与 Archive 重构方案](./session-library-archive-refactor.zh-CN.md)。
- 删除 stopped Council 属于 Council 历史删除，不会把其 agent provider history 重新解释为用户 Session。RuntimeEngine 在 Council record 消失前收集 agent 的稳定 `providerSessionIds`，删除成功后把它们写入 workbench hidden-session tombstone；因此后续 provider catalog refresh、页面刷新和 daemon 重启都不能把 `Council <model>` 子 Session 投影进 Workspace/Recent。
- CLI 用户入口使用 `rah close <rahSessionId>` 关闭 running session；旧 `rah archive` 只能作为兼容 alias，不出现在新文档和提示里。
- 启动中的 Council 只有在当前 daemon 进程确实有 pending launch 任务时，才可以暂时显示为 `running/starting` 且没有活终端；daemon 重启后遗留的 stale starting council 如果没有 live agent，必须投影或 reconcile 为 `stopped/ended`。

### 3.5 Workbench / Canvas 对象面板边界

Session 和 Council 都是 workspace 里的可打开对象。它们在普通页面、左侧 workspace sidebar、Canvas pane、Canvas 最大化 pane 中应共享同一个对象 UI 语义，而不是分别实现几套风格漂移的视图。

当前前端用 `ObjectPaneVariant` 固定两个展示变体：

- `compact`：伸缩版本，使用紧凑对象标题栏和 Chat 主区域，适合普通 Canvas 分屏 pane。
- `expanded`：扩展版本，允许更完整的对象动作和 Side dock，适合 Canvas 最大化 pane 和完整页面壳。

具体映射：

- Session `compact/expanded` 都可以按需打开 Inspector；区别只在标题动作密度和 Side dock，不在 Inspector 可用性。
- Council `compact/expanded` 都可以按需打开 Agents；区别只在标题动作密度，不在 Agents 可用性。

Canvas 的普通分屏 pane 使用 `compact`，pane 最大化后切到 `expanded`；二者都复用同一个 Session/Council 对象表面。完整页面 shell 不是另一种对象 UI，而是把同一个对象主区域和侧边栏组合进顶层 workbench chrome。

Session Inspector 与 Council Agents 的展开按钮属于共享对象标题栏；侧栏 shell 只负责内容、resize 和覆盖层，不能再引入另一套 X/关闭语义。完整 Session 页面中，主 Chat 与 Inspector 必须先组成一个 `conversation-panel-surface`，整个 surface 再作为 `SessionSideDock` 的 main 子项；Side tasks 是该 surface 右侧的兄弟区域，Inspector 绝不能包围或覆盖 Side dock。完整页面按全局响应式档位选择 inline 或 overlay；Canvas 则按每个 pane 自己的容器宽度选择：宽度至少 `760px` 时在所属 pane 内 inline 并可拖宽，否则只覆盖所属 pane，绝不能覆盖其他 pane 或整个 viewport。侧栏可用性不依赖 pane 是否最大化。覆盖层使用侧栏标题内同款 Panel 图标关闭；inline panel 通过覆盖在边界上的单像素 divider 调整宽度并按 surface 持久化，且始终为主对话保留至少 `320px`。Inspector 的 Changes / Outputs / Sources / Files 四个标签等宽。Session/Council/Canvas 顶级页面统一使用同一个 `ConversationHeader` 单行结构、`40px` 高度与底部分割线；Council 的 agent 数量作为同行 meta，Canvas 不再保留独立双行说明。全局左 Sidebar 的 RAH header 属于独立的 `codex-compact-v1`，同样固定为 40px 但无下分割线。

Inspector `Changes` 默认以当前 checkout 分支的 HEAD 为 baseline，展示当前 worktree 中 staged、unstaged 和 untracked 的统一文件树；它不是 base-branch review。选择器必须明确标成 `Diff baseline`，并在真实 checkout 项后标注 `current branch`；远端跟踪引用（例如 `origin/main`）不是当前分支。分支下拉只改变只读 diff baseline，不执行 checkout。选择非当前分支时，UI 必须明确称为 worktree diff，不能称为未提交变动。Sources 只收录可再次打开的用户附件、网页搜索/打开记录，以及 provider 明确暴露为 URL 的外部或 Git 引用；agent 通过 CLI 读取的普通项目文件属于 Process/Files，不属于 Sources，本地 list/search 目录、查询词、shell argv 和没有可打开资源的裸工具调用同样不能进入。Sources 由 provider 持久历史按需补齐，不要求 session 已在 RAH 中 resume/运行；空集合表示 provider 历史没有记录上述资源，而不是 session 尚未激活。

Changed Files Review 是 workbench 根级唯一 overlay：Chat、Task summary 与 Inspector 只提交 `ReviewScope`，不能各自挂载全局 Portal。单文件预览与 Review 复用同一 diff inspection surface 与偏好，但窗口 ownership 分开：普通 Session 单文件预览仍是一个非模态浮窗；Canvas 单文件预览按 `CanvasPaneId` 持有，每个 pane 最多一个且不同 pane 可以同时存在。普通 viewer 与 pane viewer 的读取目标都必须保留点击来源的 session、workspace root 与 path，不能回退到当前全局 selected session；异步读取结果也只能提交给自己的实例。Session、Council、workspace、Canvas active pane 或设置/终端等顶层上下文发生改变时，普通 viewer 与不属于目标 owner 的 Review 在下一次绘制前失效；离开 Canvas 或由顶层功能接管时清空全部 pane viewer，但 Canvas 内仅切换 active pane 不销毁其他 pane 的独立 viewer。

Canvas pane 的持久化语义是固定槽位与可变布局树模型：

- Canvas 最多有 8 个固定 pane，内部 ID 固定为 `canvas-1` 到 `canvas-8`。
- remembered target 的 provider identity 恢复属于 pane 本地操作：恢复失败写入该 target 的本地错误卡片，不得写入全局 workbench error。这样即使用户在异步恢复结束前切到 Council、Chat 或 New，也不会在新页面看到与当前页面无关的陈旧 Session notice。
- 回复中的本地文件在所属 pane 内打开，viewer 被 pane 边界裁剪并可折叠为 pane 内标题条。默认形态由 pane 自己的内容框决定：至少 `560×480px` 时使用靠右的 pane 内浮窗，保留左侧底层对话点击带；宽或高不足时占满 pane 内容区；因此 390×844 PWA、三列和较矮的多行 pane 自然最大化，而足够大的 Desktop pane 可以在 viewer 打开时继续点击正文文件并 retarget。窗口化 viewer 只开放上、下边缘调整高度，不开放移动或横向 resize，最小高度为 `280px` 且始终夹在 pane 边界内；这样可以按需露出底层对话，同时维持 pane 布局稳定。用户可显式最大化或还原，显式选择和已调整高度在该 viewer 后续换文件时保留；点击当前或其他正文文件会以新 request identity 激活同一 viewer、解除折叠并切换内容。最大化或临时隐藏 pane 也保留 viewer。替换、清空或移除 pane 只清除该 pane 的 viewer，绝不能让 B pane 的点击改写 A pane 的内容。
- Pane 外层标题只表达固定槽位身份，显示为 `Pane 1` 到 `Pane 8`；编号必须从固定 pane ID 推导，不能根据当前可见数组下标重新编号，因此最大化 `canvas-2` 依然显示 `Pane 2`。session / Council 的真实标题、状态、操作只由内部对象标题栏负责。
- 布局是持久化的二叉 split tree。每个 split 只记录横向或纵向轴、稳定 ID、比例和两个子节点；pane target 不属于布局树，因此改变布局不会重建会话状态。
- 顶部快捷按钮保留常用的双列、双行、三列和 `2 x 2`；布局设计器可以直接选择规则网格，包括 `2 x 3` 和 `4 x 2`。每个 pane 还可以局部 `Split right` 或 `Split below`，因此双列可以扩展成等宽三列，也可以只把左列拆成上下两个形成 `2 + 1`。
- 布局选择高于临时最大化状态：布局只剩一个 pane 时自动把该 pane 视为最大化；随后显式选择任意多 pane 布局（包括 compact 的纵向 `1 + 1`）必须立即清除最大化并展示新布局，不能让旧最大化状态继续遮住其他 pane。
- 布局切小只隐藏超出新布局的固定槽位，不会销毁 hidden pane，也不会清掉其 running session、history replay 或 Council；再次扩展到包含该槽位的布局时恢复原绑定。
- Session pane 绑定同时保存当前 RAH runtime ID 和稳定的 `provider + providerSessionId` 身份。daemon 重启导致 runtime ID 变化时，先按稳定身份匹配新的 running projection，未找到时再按同一身份恢复 history replay；旧版本只保存 runtime ID 的悬空绑定在首次 Session 清单加载完成后自动清空，不能无限停留在 `Restoring session…`。
- 总数大于 1 时，每个 pane 都提供 `Remove pane`。显式移除会折叠该 pane 所在 split、清除该槽位绑定和右侧栏状态，并把焦点移到布局顺序中最近的相邻 pane；Canvas 最少保留 1 个 pane。它与选择较小 preset 的“暂时隐藏多余固定槽位”是两种不同语义。
- 进入 Canvas 只切换页面，绝不根据当前大页选中的 Session/Council 改写 pane。Pane target 的唯一写入口是用户在 Canvas pane 内通过 Chats/New 打开对象、把对象拖入 pane，或恢复上次持久化的 Canvas 状态；无论对象是 running 还是 history/stopped，都不能被外部页面选择隐式带入。
- 用户拖拽任意层级的 Canvas 分割线时，pointer event 只保留最新比例，React state 每个 animation frame 最多提交一次；`pointerup` / `pointercancel` 会 flush 最终值，避免高频 render 并丢失最后一次拖拽位置。
- Canvas 工作面使用 8px 单层透明 gutter。Split 的完整横向或纵向区域只作为透明 resize 命中区，静止视觉只在 split 中心显示一段短而浅的圆角标记；单条 split 显示短竖杠或短横杠，真实交点按布局拓扑显示 T 形或十字，例如上二下一显示倒 T、`2 x 2` 显示一个十字、`4 x 2` 显示三个十字。hover/drag 时标记略微伸长和加深，不能再用贯穿 pane 全长的线切割工作区。每个 pane 是 8px 圆角、单边框的平面工作区，不使用阴影或嵌套 card。Canvas 内容区在桌面只保留每边 8px、compact 只保留每边 4px，因此圆角不会像旧版 12px 外边距加阴影那样明显压缩内容。选中态由 pane 根层的完整圆角内描边表达，必须覆盖标题栏、conversation 和 composer，且不能改变 pane 尺寸。
- Pane 外层固定槽位标题栏高度为 32px；槽位名和结构动作在这条紧凑栏内垂直居中。对象自己的 Session/Council 标题栏继续位于 pane 内容区，两者不能合并或重复显示对象标题。
- Pane 标题栏动作顺序固定为 `Clear content`、`Split`、`Maximize/Restore`、`Remove pane`。`Clear content` 是唯一随 pane 内容显隐的首项，因此后三个结构/视图按钮在内容从 empty 到 active 时保持屏幕位置；空 pane 不渲染 `Clear content`。`Remove pane` 在总数大于 1 时出现在每个 pane，最后一个 pane 不提供无效移除。
- 空 pane 不显示橡皮擦；只有绑定了 Session/Council/New/Opening 内容的 pane 才能清除内容。空 pane 在可移除时只提供 `Remove pane`。
- `compact` 默认投影独立的纵向双 pane 安全布局，隐藏布局设计和局部拆分入口，但允许用户移除其中任意 pane 并保留单 pane；进入或退出 compact 不改写持久化的 desktop/iPad 布局。compact Canvas 的全局左侧栏入口由 Canvas 顶级 header 唯一持有，pane 内不能再渲染一个无效或重复入口。
- Pane 橡皮擦、Clear all、删除对应对象，以及在 pane 内显式 Stop session/Council 会清除该 pane 绑定。
- Clear all 必须清掉全部 8 个 pane，而不是只清掉当前布局下可见的 pane。
- 在 pane 内 Stop running session/Council 后回到 `Empty pane`；历史仍可从 Chats 再次打开，Stop 不删除 provider 历史。

#### Fork / Side 工作面

Fork 和 Side 共享 provider-native 分支协议，但不是同一种产品对象：

- Fork 是持久化的新 session。它继承父 session 到指定 turn 的 provider 上下文，拥有独立 provider/session identity，出现在 Chats，并在创建后成为当前选中对象。父 session Stop/Close 不删除 Fork。原任务保持原名，持久 Fork 按 `(2)/(3)/...` 编号；名称同时写入 provider thread 与 Workbench override，Stop、刷新和 Resume 后不得丢失。
- Side 是父 session 内的临时协作面。它同样拥有独立 provider thread，但带 `kind: "side"`、`workspaceMode: "shared"`、`persistence: "ephemeral"` 关系；它不进入 Chats、Recent、左侧 workspace session 列表或持久化 workbench history。
- Side 使用 `ready -> active -> completed` 的可复用 turn 状态机；Completed 只是本轮结束，父 session Ready 或 Side turn 完成都不会自动关闭 Side。
- provider 明确报告同一 Side thread `notLoaded/closed/deleted`，或承载 pathless Side 的专属 app-server 通道终止时，Side 进入 `expired`，保留可见诊断并提供 New Side，而不是伪装成 Completed 或自动恢复旧 Side。
- 关闭父 session 时必须递归关闭所有 ephemeral Side descendants；显式关闭 Side 与级联关闭都先执行 interrupt、unsubscribe 和 app-server 回收。ephemeral Side 不支持 goal，任何 Side 清理路径都不得调用 goal API；只有普通持久 session/Fork 才沿用 goal pause。失败时 Side 进入 `cleanup_failed`，父任务保持打开且整个操作可重试。
- Parent Stop/Delete/Archive 都服从同一清理前置条件；history mutation API 拒绝直接处理仍有 managed session 的 provider identity。删除或关闭父 session 不能级联删除持久化 Fork。
- Provider 未声明 native branching capability 时，前端隐藏对应操作。RAH 不通过复制 transcript、拼 prompt 或创建无关系 session 来兜底模拟。
- 当前只支持 same-workspace Fork。Worktree Fork 在 Git worktree 生命周期完整实现前保持不可用。

完整状态、close disposition、Codex 30 分钟无订阅卸载机制与失败恢复协议见
[Fork 与 Side 生命周期协议](./fork-side-lifecycle.zh-CN.md)。

展示协议：

- 普通 session 页面和 Canvas 最大化 pane 提供完整 Side dock。
- 桌面宽屏默认把 Side 按列向右展开，可切换为纵向 stack；布局选择位于父 session 的 `...` 菜单，属于父 session 的 UI 偏好，不改变 provider relationship。
- 主任务与 Side、相邻 Side 之间使用共享的细分割线与透明拖动命中区；宽度/高度比例按父 session 持久化，不保留单独的粗布局轨道。
- 低于桌面宽度时只展示一个活动表面，通过 `Main` / `Side N` 标签切换，避免多列压缩 Chat。
- 普通紧凑 Canvas pane 不直接嵌入多列 Side，只显示 Side 数量；最大化后进入完整 Side dock。
- Side 的 Chat、composer、标题栏与普通 session 复用同一对象页面组件；Canvas 只负责承载，不维护另一套会话逻辑。
- Completed 保持可继续使用；Expired 显示 New Side；Cleanup failed 保留错误和 discard 重试入口。生命周期错误显示在对应 Side 标题栏下方，不能改变主任务与 Side 标题行的对齐。前端只消费 `session.side.state.changed`，不从气泡或通用 phase 猜测 Side 生命周期。

## 4. Session 类型

RAH 里需要区分四类 session 视角。

| 类型 | 含义 | 可输入 | 可 Stop/Close | 历史来源 |
| --- | --- | --- | --- | --- |
| Native local server running | daemon 启动并持有 provider 官方本地 server session；Codex/OpenCode 默认走该路径 | 可以，走 provider structured control | 显式 stop/close 才关闭或解除 RAH 管理 | provider server event + provider history backfill |
| TUI mux fallback running | daemon 启动并持有真实 provider TUI；Claude 默认走 tmux mux | 可以，但需要 control/surface lease | 显式 stop/close 才关闭 TUI/tmux pane | provider history mirror + TUI diagnostics |
| Read-only replay | 打开 provider 历史形成的只读 projection | 未归档时直接显示完整 composer；首次提交隐式 Resume 后发送 | 只关闭 UI projection | provider history |
| Structured test running | 只允许测试注入 adapter 直接调用 engine；公开 HTTP API 拒绝 `liveBackend: "structured"` | 可以 | 关闭 provider adapter client | injected adapter event + history |

Structured test running 的保留决策：

- 保留它作为内部测试 harness，而不是生产 running 主链路。
- 普通 daemon 不构造 Claude SDK/headless structured live adapter；该旧路径已删除。
- Codex/OpenCode 的 provider-server control adapter 是当前生产路径的一部分，虽然仍提供 structured event/control 能力，但默认 backend 是 `native_local_server`。
- 公开 Web/PWA/Canvas running 入口只进入 provider runtime descriptor 声明的主路径：Codex/OpenCode 是 native local server，Claude 是 tmux/TUI mux fallback。
- 旧 wrapper-control / terminal handoff runtime 已删除，不再作为测试或兼容面存在。

重要边界：

- 只要 provider session 被 daemon-owned runtime 拉起，就是 `running`；没有 client attach 时也仍然 `running`。
- `ready`、`working`、`waiting_input`、`waiting_permission` 都属于 `phase`，不是 `running/stopped` 边界。
- 只读打开历史不算 `running`，也不算写手；未归档历史仍立即显示可输入、可选 model/mode/permission 的完整 composer，不显示独立 Resume 按钮。
- 只读浏览本身不触发 resume。用户首次提交时，客户端先把文本/附件乐观写入 resident projection，等待当前 event transport 的 initial replay 完成，再把 composer 配置与同一份 `initialInput` 放入一个 `/sessions/resume` 请求；这里等待的是现有连接的 baseline 因果屏障，不得无故重连。daemon 完成 live resume 后必须先把输入接入该 Runtime 的 canonical queue，并持续等待相同 `clientMessageId` 被 Provider 接受，随后 HTTP 才能成功。队列接管不是交付确认，Session 已创建也不是交付确认。禁止恢复成功后再由浏览器发第二个 `/input`，也禁止 live resume 失败时回退成不可写 replay 却返回成功。等待中的 `submitting` 项必须投影为可刷新的用户消息并维持 `Starting/Working`；Provider 明确拒绝 `turn/start` 或 transport 结果不确定时，输入继续留在 queue 并显示错误/可恢复状态；迟到的 provider `idle/finished` 不能覆盖该状态。失败时保留历史 projection，并恢复 draft 与附件。同一 Provider thread 的并发激活只创建一个 runtime，但每一条实际提交都必须有独立稳定 identity 和交付/排队路径，不能因共享 Promise 静默丢弃。
- 主 Session、Canvas pane 等所有 surface 通过同一条 resume command 工作；同一个 provider thread 的并发首次提交共享一个在途操作，不能双击或跨 surface 创建两个 runtime。无输入激活已经在途时，后到的 Send 必须加入该操作、保留乐观消息，并在 Resume 完成后恰好发送一次，不能直接返回旧 Promise 而丢弃问题。
- Resume A 的完成只能在用户仍选中 A 的 history replay 或 A 已 claim 的 runtime 时改写选择。若等待期间用户已经打开 B，A 仍须在后台完成 projection 迁移、控制参数刷新和输入发送，但任何成功、失败回滚或迟到的 model/mode/permission 更新都不能把当前页面抢回 A。
- Resume 复用页面已经显示的 resident history projection，并使用 `historyReplay: "skip"` 避免重新读取同一段大历史；新 runtime 只补充恢复后的 revision/delta。Archived session 保持只读且不能隐式恢复。
- activation 的 projection 交接按来源明确权威：New Task 的 provisional projection 只提供乐观 draft/config，真实 Session 的 live projection 拥有 canonical conversation；历史 Resume 保留完整 resident transcript，再叠加 live lifecycle/delta。不得用一个未区分来源的通用 spread 顺序处理两种交接。
- 显式 Stop 当前 Session 后，客户端把 resident live projection 原地降级为 stopped/read-only replay：保留 feed、conversation page 和 turn directory，清除 live lease、runtime diagnostics 与可写能力，并继续选中同一个 Chat。Close event 先于 HTTP response 到达时，命令持有的原 projection 只在用户仍选中同一 Session 时作为降级 fallback；实时流、恢复或 event replay 重复投递同一个 `session.closed` 时，该降级必须保持幂等。随后列表/catalog refresh 只校准 metadata，不能删除这个当前可见 replay 或导航到 New task。
- client detach、浏览器 reload、PWA 切后台只应影响 attach 状态，不能隐式 stop/close/kill session。

## 5. Provider 当前实现

| Provider | 默认 running path | Launch/resume spec | Structured source | 增强控制边界 |
| --- | --- | --- | --- | --- |
| Codex | native local server | `codex app-server` + `codex --remote <endpoint> resume <threadId>` | app-server event + rollout/session backfill | model/mode/runtime config 按 Codex app-server 能力开放 |
| Claude | tmux/TUI mux fallback | `claude --session-id <uuid>` / `claude --resume <id>` inside tmux | `~/.claude/projects/**/*.jsonl` | permission/model/effort 作为启动参数增强；运行中以原生 TUI 为准 |
| OpenCode | native local server | OpenCode serve/session + `opencode attach <url> --session <id>` | server/session event + 有界官方 message API catch-up；SQLite 只用于 stored history | model/variant 和原生 agent 按 OpenCode API 能力开放 |

默认权限策略见 [Session 入口与权限边界](./session-entry-capability-boundary.zh-CN.md)。当前默认统一偏向低摩擦最大权限：

- Codex：`never/danger-full-access`
- Claude：`bypassPermissions`
- OpenCode：provider 原生默认 agent，通常为 `build`

这些默认值由 adapter 的 `ProviderModelCatalog.defaultModeId` 提供。前端只传 RAH 标准 `modeId`，daemon 在 native TUI launch spec 中尽量翻译为 provider 启动参数。启动增强失败或 provider 语义变化不应影响 PTY core 的产品边界；用户始终可以切到原生 TUI 使用官方 `/permission`、`/model`、`/plan`、`/goal` 等能力。具体映射见 [Provider Adapter 协议与能力边界](./provider-adapter-protocol.zh-CN.md)。

OpenCode 的权限需要额外注意：OpenCode 默认多数工具是 `allow`，但 `external_directory` 默认是 `ask`。因此当 agent 读取或操作启动工作区之外的路径时，即使使用默认 `build` agent，也可能请求 approval。RAH 不应把这误判为 OpenCode 没有高权限模式。需要减少这类确认时，优先在用户级 `~/.config/opencode/opencode.json` 配置：

```json
{
  "permission": {
    "external_directory": {
      "*": "allow"
    }
  }
}
```

也可以通过 `OPENCODE_PERMISSION='{"external_directory":{"*":"allow"}}'` 只影响某次启动。`opencode --permissions/--tools` 是允许列表入口，不适合表达 `external_directory` 这种路径规则。

`SessionModeDescriptor.role` 是 UI 的稳定语义层：

- `ask`
- `auto_edit`
- `full_auto`
- `plan`
- `custom`

Provider 原生 mode id 仍可作为 `id` 保留，但前端只用 `role` 做稳定展示。比如 Codex `on-request/read-only` 的 role 是 `ask`，不应在 UI 上被解释成绝对“只读”。

`SessionModeDescriptor.applyTiming` 是 mode 的应用时机语义层，用来区分 `immediate`、`next_turn`、`idle_only`、`restart_required`、`startup_only`。在当前 provider runtime 范围内，Codex/OpenCode 的 mode 多数是下一 turn 或 native local server/ACP 边界生效；Claude 以官方 TUI/CLI 当前能力为准。

## 6. Native Server / Tmux TUI Surface 原则

Native local server 与 tmux attach 的目标是：

- 普通 running session 中，Codex/OpenCode 的 provider session 始终由 daemon 管理的 native local server 持有；Chat 与 Web TUI 都是 client/view。
- Claude 的真实 provider TUI 始终运行在 daemon 管理的 tmux session/pane 中；Web terminal、PWA/iPad/iPhone、Canvas pane 都只是 view client。
- Council 是例外：Council agent 运行在 RAH 管理的 provider session 中，并挂载 Council MCP 协作工具；daemon subscription/direct wake 负责消息激活，短时 MCP waiter 只负责热讨论。它不代表普通 Codex/OpenCode session 的 runtime 边界。
- provider session 只从 Web/PWA/Canvas 创建或 resume；公开 CLI 不再提供 provider session handoff。
- Web TUI view 断开只 detach，不杀 session；显式 stop/close 才关闭或解除 RAH 管理。
- Web UI 可以立即看到 running session，并在 reload/focus 后通过 provider event/history 或 tmux replay 追上。

当前锁定原则：

- single-writer：任意时刻只有一个 client 拥有 control lease。
- single-display-surface：tmux TUI display surface 需要显式 claim。Web/PWA 只有进入 `TUI` 视图才 claim；Chat 发问和 Stop 不 claim display surface。
- 不同步 draft：只同步已提交 turn，不同步光标、未提交草稿、选区、slash menu。
- transcript 主要来自 provider history 文件/数据库，不从屏幕画面解析主内容。
- terminal 画面是用户体验 surface，不是 canonical data source。
- Native TUI 的 provider identity 绑定必须先由 SessionStore 原子确认唯一所有权，再提交到本地 terminal runtime；不能先改本地状态再依赖后续写入校验。两个 runtime 观察到同一 provider session ID 时，已有 owner 保持不变，冲突 runtime 进入 `stopped/failed` 并关闭自己的 PTY/tmux。
- provider output parser、identity binding 或 observation callback 抛错只能造成当前 session scoped failure。daemon 必须保持运行，其它 session 和原 identity owner 不受影响；失败记录为 `binding_failed` diagnostic 和 session `lastError`，不能退回启发式绑定或让异常穿透 PTY event loop。
- Codex/OpenCode Chat composer 走 provider structured control，不通过键盘注入普通 turn。
- Claude fallback Chat composer 是 TUI 文本注入桥：使用 bracketed-paste + 单次 Enter；显式 Web Send 会先清掉 prompt dirty 草稿，agent busy 时后续输入进入每 session FIFO。
- Stop/Close 必须关闭 provider native server session 或 Claude 对应 tmux session，避免孤儿 runtime。

当前不承诺：

- 在原生 TUI 内部 `/new` / `/resume` 后所有 provider 都能自动 rebind。
- 多客户端同时双写。
- Web 对 native TUI session 动态修改所有 provider 私有权限/模型/plan 状态。
- structured mirror 100% 覆盖 provider 新增的私有 UI 功能；mirror missing/failed 只进入 diagnostics，不影响 TUI live。

### 6.1 退出与孤儿清理边界

RAH 对“一退全退”的设计目标是：正常退出时尽量在事前同步关闭 RAH-owned runtime；崩溃、断电、`SIGKILL` 等没有退出钩子的场景，在下一次 daemon 启动时做状态修正和孤儿清理。这里的 RAH-owned runtime 只包括：

- 当前 daemon 管理的 running session、Council/agent session。
- RAH 创建的 `rah-*` tmux session。
- RAH 启动且带有 `RAH_NATIVE_SERVER_OWNER=rah` 标记的 Codex/OpenCode native local server 进程。
- `~/.rah/council/councils.json` 中 Council/agent 的持久化运行状态。

正常退出路径是 `SIGINT` / `SIGTERM` -> `daemon.close()` -> `RuntimeEngine.shutdown()`。`daemon.close()` 首先停止 HTTP listener 接受新连接，同时立即启动 runtime 清理，而不是先等待现有 HTTP 请求 drain；进入 shutdown 后，新的 start/resume/fork/input 请求会被 runtime 拒绝。event/PTY WebSocket client 会收到 `1001` shutdown，500 ms 内未完成 close handshake 的 socket 会被 terminate。HTTP drain 最多等待 5 秒，超过后关闭剩余连接；HTTP drain、WebSocket close 和 runtime cleanup 并行收敛。这样卡住的上传或长请求不会阻止 Council、terminal 和 provider runtime 在退出窗口内开始清理。daemon 入口在收到信号后最多等待 30 秒再强制退出；`rah stop` 最多等待 35 秒再 `SIGKILL`，给 provider close、tmux kill、状态落盘留出时间。

`RuntimeEngine.shutdown()` 的顺序是：

1. 关闭 stored-session monitor。
2. 关闭 Council runtime。
3. 关闭 terminal/tmux runtime。
4. 关闭 provider structured adapters。
5. 清理 RAH 标记的 Codex/OpenCode native local server 孤儿进程。
6. 清理未被当前 daemon 管理的 `rah-*` tmux session。
7. flush workbench state。

Council runtime 退出与显式 Stop 使用同一个可重试停止事务：先把 Council 标记为 `running/stopping`，阻止新消息、新 agent 和 MCP 写入，然后 resolve 等待中的 Council message waiter 并清理 MCP client state。runtime 会关闭已知 agent session、等待正在启动的 agent 收敛，再次关闭并核验是否仍有 managed session。只有所有 agent 都已确认关闭，才能持久化为 `stopped/ended`。关闭失败时保持 `running/stopping`，记录错误并允许用户重试，不能先从 RAH 消失再留下 provider 孤儿。

关闭 Council agent session 时，runtime 会先尝试 native TUI/tmux close；如果不是 native TUI/tmux session，再走 structured lifecycle adapter 的 destroySession。成功后还会用 runtime checker 确认 session 已不存在，才清除 agent 上的 session binding。这保证 Council Claude 的 `tui_mux` session、以及 Codex/OpenCode native local server session 都走各自真实的 runtime close 路径。shutdown 会尝试收敛所有 Council，再汇总失败；崩溃等无退出钩子场景仍由下次启动的 reconcile/orphan janitor 收敛。

Terminal runtime 退出时会并行关闭当前进程内管理的 tmux session，然后扫描并清理未被当前 daemon 管理的 `rah-*` tmux session。每个 RAH tmux session 同时写入由 `RAH_HOME` 派生的 `@rah_owner_scope` 和创建 daemon 的 `@rah_owner_pid`；接管与 janitor 只处理同 scope、未被当前 runtime 管理且 owner PID 已不存在的 session。其它 RAH_HOME、仍存活的旧 daemon 和用户自己的 tmux 都不能只因名称以 `rah-` 开头而被删除。Codex/OpenCode native local server 启动时会注入 `RAH_NATIVE_SERVER_OWNER=rah`、`RAH_NATIVE_SERVER_PROVIDER=codex|opencode`、`RAH_NATIVE_SERVER_DAEMON_PID=<pid>`，因此 orphan janitor 只清理 RAH 明确拥有的 provider server，不会按进程名误杀用户自己启动的 Codex/OpenCode。

tmux/TUI mux 的意外退出与显式关闭必须区分：每个 provider pane 在创建时就以 window option 启用 `remain-on-exit`，保证进程即使在订阅建立前快速退出，最后屏幕和退出证据也不会随 pane 一起消失。退出轮询串行执行，并在清理 runtime 前抓取 dead pane 的最后屏幕。分类顺序固定为“显式 expected close -> 最后屏幕中的 provider 错误 -> signal -> exit code -> 未知异常”；显式关闭不报错，正常 exit 0 可以收敛，signal、非零 exit 和无证据消失都保留为 `failed`，供 Chat 与 diagnostics 展示。这样快速启动失败不会因为订阅与轮询竞态而从界面静默消失，也不会把用户 Stop 误报成 crash。

崩溃、断电、`SIGKILL` 不能执行退出钩子，所以不可能只靠 shutdown 做绝对保证。下一次 daemon 启动时会先恢复仍可重新接管的 `tui_mux` running session，然后运行 startup orphan janitor：

- 清理仍带 RAH native server 标记的 Codex/OpenCode 孤儿进程。
- 清理没有被当前 daemon 管理的 `rah-*` tmux session。
- reconcile Council 持久化状态：running council 如果没有 live agent，会被标记 stopped；running council 中已经没有 live terminal 的 recoverable agent，也会被标记 stopped。

这个机制的非目标也很明确：浏览器/Web/PWA client 断开只 detach，不关闭 session；RAH 不清理没有 RAH env 标记的外部 provider 进程，也不能保证旧版本未打标的 provider server 会被识别；OS hard-kill 或 provider 拒绝退出时，只能通过下一次启动的 janitor 尽量收敛。

## 7. 历史浏览与同步边界

RAH 只有一套 Conversation 同步协议：

- `ensureConversationLoaded`：读取 canonical tail baseline；首屏默认 8 turns。
- `loadOlderConversation`：使用 opaque `nextCursor` 加载更早 turns。
- WebSocket `conversationDeltas`：补充 baseline 之后的 live 变化。
- replay gap：只在 delta 无法连续应用时重新读取一次 canonical baseline。

新建 running session 先使用 resident live projection，不读取完整 provider 历史。optimistic user
item 会立即显示，随后由 daemon 的 canonical delta 接管。Codex/OpenCode 由 provider server 事件推进；
Claude 由 daemon 内的 transcript mirror 推进。浏览器不再设置 1.5 秒 history tail 轮询，也不直接读取
JSONL、rollout 或 SQLite。

只有 read-only replay 或用户向上滚动接近顶部时，才进入 older-turn paging：

1. 客户端请求 20 个 canonical turns。
2. 新页面 prepend 到同一个 `ConversationSyncState.turns`。
3. scroll anchor 保持当前阅读位置；读者脱离 tail 后优先冻结视口内稳定正文后代的像素位置，再以
   canonical row identity 兜底，所以超长单行内部的 lazy image/Markdown 慢布局也不能推动读者。
4. 内容不足一屏时可以继续请求更早 cursor，直到填满或没有下一页。

后端 `HistorySnapshotStore` 只冻结 provider evidence 边界，再由 projector 生成 canonical page：

- 首屏冻结 provider 历史 revision。
- 首屏 response 携带它实际扫描完成的 provider `sourceRevision`；客户端在 `phase=loading` 时不得
  启动 revision probe，避免取消并重复请求同一份超大历史。
- 后续 cursor 只能在同一个 frozen snapshot 内翻页。
- Resume 保留已展示 turns，并以 resident live projection 覆盖重叠 turn 的 lifecycle。
- Resume 不重新请求已经显示的 history page；live attach 与 resident projection 只补充新的 revision/delta。
- 浏览器内存负责同一页面生命周期内的 A→B→A，且 Conversation LRU 与 Session catalog map 分离：
  目录刷新/replay gap 不能清空已读正文，返回 Session 时先同步展示 bounded tail，再只对可见 Session
  做 canonical tail 校准。跨 Runtime ID 的 baseline 清除旧 revision/cursor；非可见项惰性校准，禁止
  replay gap 全量并发补拉。该 LRU 只按稳定 provider identity 保存最多 16 项、单项约 8 MiB、总计约
  32 MiB、30 分钟，不参与 Sidebar/Workspace 派生，也不持久化正文。

Sidebar 向 Canvas pane 投放 Session 使用 provider-neutral 的稳定 target。running Session 携带 runtime id；
stopped/history Session 携带 `{provider, providerSessionId}` 并通过同一个 stored-ref owner 解析。两者都必须
可拖动，drop 是 copy 而不是从 Sidebar 移走；WebKit 丢弃自定义 MIME 时使用带 RAH 命名空间的
`text/plain` 回退，Canvas 不创建第二套 Session catalog 或 activation 路径。
- 整页 reload 或 iOS Web 进程回收后只通过 daemon 内存中的有界 canonical hot page 加速。命中必须
  同时匹配 Runtime Session、cursor/limit、provider source revision 与 live
  revision，且不缓存任何工作中状态。浏览器不持久化 Conversation 正文；revision 变化时旧热页直接
  失效并重读，不能与新 baseline 混合。浏览器仅在当前 tab 的 `sessionStorage` 保存最后选中对象的
  稳定 provider identity；reload 后按 live catalog、再按 Recent/Stored 解析它并复用 daemon canonical
  hot page。正文、turn 和 Runtime Session id 都不进入浏览器持久化缓存，显式回到 New task、Workspace
  或 Council 时清除该选择。

### 7.1 Council 列表与消息同步

Council 使用“摘要目录 + 显式消息窗口 + 单条实时增量”，不把完整消息窗口混入全局目录：

- `GET /api/council` 只返回 `CouncilSummary`：标题、workspace、生命周期、agents 和 message meta，不返回 `messages`、message window 或 storage 路径。
- `councils.json` 持久化每个 Council 的 `messageMeta`，列表、启动 reconcile 和低频 mutation 都只读这个摘要索引，不扫描每个 Council 的 JSONL transcript。
- 只有打开具体 Council、翻页历史或 MCP 读取时才懒加载对应 JSONL。旧版 store 在第一次启动时扫描一次完成索引迁移；新消息在 append 时同步增量更新摘要。
- daemon 启动时从每个 JSONL 尾部 64 KiB 开始查找最后一个有效消息 ID；只有末条消息跨越当前窗口时才继续向前扩展，不在常态下解析完整历史。
- 打开具体 Council 后，前端通过消息分页接口按需读取最近 100 条；向上滚动再使用 `nextBeforeMessageId` 请求更早内容。
- `council.message.created` 只携带一条新消息和更新后的 Council summary，不附带最近 100 条消息快照。
- `App` 是 Council transport 的唯一 owner，只维持一条按 event type 过滤的 WebSocket。普通 Council 页面和 Canvas pane 都消费同一份 Council store，不建立私有 socket 或 5 秒轮询。
- 所有 Council 写入都必须经过 `App` 的原子 updater；受控 `CouncilPage` 只能提交 updater，不能把从旧 render 捕获的整份数组写回全局 store。
- Council socket 不回放 event retention 中的旧消息；连接建立并进入实时订阅后，再刷新一次摘要目录作为基线。这样连接与 HTTP refresh 之间没有事件缺口，也不会在每次重连重复传输旧事件。
- socket 重连或页面回到前台时只刷新一次摘要目录；并发 refresh 会合并为同一个请求。已加载的消息窗口按 message id 保留并与增量合并，较旧的 HTTP summary 不得覆盖较新的 live summary。
- 摘要中的 `meta.lastMessage.id` 是最近窗口是否陈旧的判据；即使本地已经装满 100 条，只要尾消息 id 不一致，选中该 Council 时仍要重取最近窗口。
- WebSocket client 会把 session/event filter 放在 upgrade URL 中，daemon 在发送首次 replay 前即应用过滤；连接建立后的相同 subscription frame 不触发第二次 replay。

Council 的创建、改名、增删 agent 等显式 mutation 是低频、用户触发的事务响应，但 store/runtime 内部仍优先返回轻量摘要；如果页面需要消息窗口，应通过选中 Council 的分页接口单独 hydrate，不能把完整 transcript 扩展到持续列表或消息广播。

Council MCP 的 `channel_post` canonical 参数为 `content`，工具 schema 与 daemon wake prompt 都必须明确该参数。daemon 边界同时接受历史 `text` 和常见 `message` 别名，避免 agent 已完成任务却因为参数名差异丢失最终答复。

Council delivery 的单一 owner 是 runtime daemon 的 `CouncilDeliveryCoordinator`。managed session 启动后 daemon 直接登记 Council/agent/session 订阅，不发送 join/bootstrap 模型 turn；Claude 等 MCP `tools/list` ready 后才允许 wake，但 ready 本身同样不发送 prompt。新消息先命中 active `channel_wait_new` 热 waiter；没有 waiter 时在 120ms 内按 agent 合并 canonical 消息，并通过原 Session input queue 直接注入包含完整原文、稳定 `clientMessageId/clientTurnId` 的 wake。busy 或已有 wake 时只排队；精确 `session.input.accepted` 才推进 delivery cursor，turn terminal 后才调度下一批。不得退化为“通知 agent 有新消息，再让它读 inbox”的两段路径。

agent 完成本批消息后只做一次 30 秒热等待；timeout 返回 `sleeping: true / next_action: end_turn`，结束模型 turn 但保留 daemon 订阅和 provider session。明确 `@<agent name>` 由 daemon 缩小投递范围，`@all` 或无已知 mention 的消息广播。生命周期 system row 永远不进入 agent 的 wait/inbox/history wake 路径。

Council 对话的用户可见消息协议是“当前生命周期 + 最终答复”：同一个 agent 的 `subscribed / waking / working / queued / listening / sleeping` 更新同一条稳定状态行，不为每次状态迁移堆叠独立正文；旧 `sent / joined / listening` 仍可兼容折叠。agent 工作过程使用 `channel_set_status`，`channel_post` 只发布一次面向用户的最终答复，禁止思考过程、工具旁白、进度和阶段性草稿。最终答复继续使用 agent/provider 对应的 Council 气泡视觉，不把多个 agent 的输出合并成匿名正文。

硬约束：

- live/native-mirror event 不能被 baseline 加载挡住。
- Codex/OpenCode Chat 的当前回复来自 native local-server event/client push。OpenCode 只用串行、有界的官方 recent-message API 补齐事件缝隙，不在 live loop 扫描 SQLite。
- Claude Chat 的当前回复来自 daemon transcript mirror，不从 ANSI 屏幕解析主内容。
- provider history 文件/DB 是 backfill 和 read-only history 的依据，不是新 live turn 的唯一实时来源。

各 provider 的底层分页实现和前端函数边界见 [历史浏览与分页边界](./history-browsing.zh-CN.md)。

### Stored-session catalog 生命周期

Catalog 只保存用于 Chats/Resume 定位的轻量 metadata 与 provider-owned storage path，不保存
Conversation 正文。生产 daemon 的目录发现必须遵循：

1. 启动同步读取 last-good 原子快照，立即提供最多 15 条 Recent。
2. 启动后异步、周期性以及 All 请求所需的全量发现都在隔离子进程运行，不能阻塞 daemon
   event loop。
3. Codex、Claude、OpenCode 分 provider 返回；一个 provider 扫描失败时保留其旧快照，其他
   provider 正常更新。
4. Stop 成功后先由 runtime 立即发布 stopped session upsert，再由目录进程校准磁盘事实。
5. 删除/归档前读取权威目录；删除成功同步更新内存 revision 和原子快照。
6. 当前 provider catalog 是身份权威；remembered/workbench/per-file cache 只能补充 metadata，
   不能独立证明 Session 仍存在或仍属于当前产品表面。
7. Codex 必须从首个 `session_meta.payload` 保留所有用户拥有的根会话，包括
   `originator=Codex Desktop` 与 `originator=codex_work_desktop`；明确标记为 subagent 的内部
   rollout，以及尚未接受任何真实用户 turn 的 metadata-only rollout 都不进入 catalog。Claude
   和 OpenCode 遵循同一首个用户 turn 门槛；标题、路径或 assistant/system metadata 不能把启动失败
   留下的空壳升级为可见 Session。物理文件与标题索引不能替代该边界。
8. catalog snapshot 与 provider metadata cache 具有 visibility contract version。完整扫描清理旧
   row；不完整扫描保留 last-good，不能因一次中断扫描让 Sidebar 数量抖动。
9. 扫描结果、启动快照和持久化快照在进入 Session 投影前都必须按
   `{provider, providerSessionId}` 规范化：空 identity 直接拒绝，同一快照内 active/archive
   短暂并存时保留 active，其他重复项按最新 provider 时间和稳定 storage path 决定。完整扫描的
   规范化结果仍是权威集合；不完整扫描只原位 upsert，不重排或删除未观察到的 last-good row。
10. Sidebar 的 workspace inventory 只来自用户已经登记的工作区；live runtime 不得因为在另一个
    目录运行而自动登记工作区。Sidebar stored-session 投影还必须能由最具体的已登记工作区认领，
    未被登记工作区包含的 provider history 只可留在全局 Chats/History，不得进入左侧工作区列表。

因此 Recent 的“快”不以牺牲一致性为代价，All 的“准”也不能成为启动、Resume 或 Chat 首屏的
串行依赖。

用户选中 Session 后的读取顺序同样固定为 `Chat -> Changes/Files -> Outputs/Sources`；每个可见 Canvas Session pane 也必须为这条共享预载链建立 owner，不能只依赖全局 selected Session，否则 pane 内 Inspector 会永久等待未启动的 cache fill。浏览器刷新后，历史占位 id 可能不在 daemon 的 live Session registry；Changes 仅在 Session Git 接口明确返回 `Unknown session …` 时回退到同一已授权 workspace 的 Git 接口，其他网络、权限或 Git 错误必须继续显示，Outputs/Sources 仍使用原历史 identity。后两阶段
在 Chat 可读后按顺序启动但并发完成，Inspector tab 只消费共享缓存。前端最多保留 40 条不含正文
的本地阶段计时，并发布 `rah:session-view-performance` 供回归诊断；这些诊断不持久化、不上传，
也不进入 RAH 会话协议。

Stop 的前端收口也遵循同一边界：close API 成功即应用权威 stopped summary、关闭 Closing 层并允许继续操作；随后 workbench/catalog refresh 只做 fire-and-forget metadata 校准，不能延长用户等待时间。

## 8. Stop / Close 语义

Stop 在 RAH 里的实际语义是“断掉 runtime 管理的 running 执行体”，不是删除 provider 历史，也不是把历史移入回收站。

| Session 类型 | Stop/Close 行为 |
| --- | --- |
| Native local-server running | 关闭 RAH 管理的 provider server client / optional TUI client，session 变为 `stopped`，provider 原始历史仍保留 |
| TUI mux fallback running | 显式关闭 RAH 管理的 tmux/TUI pane，session 变为 `stopped`，provider 原始历史仍保留 |
| Read-only replay | 只关闭 RAH UI projection，不删除 provider 原始历史 |
| Structured test running | 关闭 injected provider adapter client，session 变为 `stopped` |

删除历史是另一类动作，应走 provider stored session remove/trash 语义，不应混进 Stop。

## 9. Running / Stopped 边界

RAH 判断 session 或 Council 是否 `running` 时按执行体和 owner 区分：

- 有 RAH 管理绑定：running。
- 有 RAH 管理的 native local server session 或 tmux/TUI mux session：running，即使当前没有 attached client。
- provider 历史文件有外部活跃写手：external live。
- 只是 Web 打开历史读取文件：不算 running。
- 无 RAH 管理写手、无活跃外部写手、文件稳定：stopped history / read-only replay。

Codex pending tool 收口的细节见 [Codex 历史 liveness 与 pending tool 收口边界](./codex-history-liveness.zh-CN.md)。

## 10. UI 状态边界

左侧 sidebar 的状态含义：

- `ready`：running 但空闲。
- `unread`：running 或历史 projection 有未读更新。
- `waiting_permission`：running turn 等待用户批准。
- `working`：running turn 正在执行。

这些是 session/council 的展示状态，不是 `running/stopped` 判定条件。`running/stopped` 的边界来自 RAH runtime ownership / provider write liveness。

Stop 按钮语义：

- 用作 working 状态提示。
- 如果当前 turn 是 Web 发起且 provider 支持 interrupt，Stop 应尝试传递 interrupt。
- 如果当前 turn 是 terminal TUI 发起，Web 可能只能提示“terminal 接管中，Web 无中断权限”。

## 11. Provider 历史与 Markdown 展示

主 UI 展示的是 provider history 翻译后的 canonical timeline：

- user message
- assistant message
- reasoning
- tool call
- observation
- permission
- attention / notice

重要规则：

- 不把 provider 内部 control tags 直接展示给用户。
- 过滤 `<turn_aborted>` 等上下文标签时必须保留原始换行、列表和代码块。
- 不用 `replace(/\s+/g, " ")` 这类全局压平逻辑处理 assistant text。
- 不同 provider 的原始结构化输出差异由 adapter 吸收，前端只渲染 canonical text/markdown。
- live 与 history 的重复消除应优先依赖 `TimelineIdentity.canonicalItemId`，而不是靠文本相同、时间接近来猜。
- 当前阶段是 Timeline Identity v2 的 MVP：协议、daemon 透传、前端 upsert、core provider 的 native/derived identity 已具备。后续如果继续增强，应在 daemon 侧增加 epoch/seq ledger 做 replay/gap/catch-up，而不是把 text/time window 重新变成主逻辑。
- assistant message 除纯文本视图外可以携带有序
  `TimelineAssistantContentPart[]`，当前 union 只包含 `text` 与 `interactive_html visual`。
  这是 provider-native history 的无损投影，不是 Markdown 扩展：Codex adapter 识别官方
  `::codex-inline-vis{file="..."}`，在流式指令闭合前暂存协议尾部，闭合后才原子发布 visual；
  历史 replay 使用同一个 parser，因此无需在 RAH 中启动 session 也能恢复。RAH 不改写用户
  问题、不注入生成 PNG/HTML/CSV 的提示，也不从普通附件或文件扩展名猜测可视化。artifact 由
  provider adapter 从 provider-owned visualization storage 解析，经过文件名、真实路径包含性、
  symlink、普通文件和 2 MB 上限检查后，由 no-store HTML endpoint 返回；Web 仅在
  `sandbox="allow-scripts"`、严格 CSP 的 iframe 中加载 vendored Codex Visualize host。
  新旧 provider 指令都在 adapter 内归一：旧 `visualize{...}` 的精确路径，或同一
  provider turn 工具证据中明确出现的 `.codex/visualizations/.../<safe-name>.html` 路径，被编码为
  opaque artifact id；没有路径证据的 basename 才按 session workspace 的
  `.codex/visualizations/<date>/<providerSessionId>/` 与 provider home 旧目录回退。文档渲染失败时，独立 source endpoint 只返回 adapter
  已经通过同一 realpath/symlink 边界校验的真实文件路径，供 Web 复用 host file preview；
  source 不存在时才显示明确的缺失状态，前端不能自行拼路径或留下不可操作的通用占位符。

### Assistant 处理过程与最终回答

`TimelineItem.assistant_message.phase` 用来区分一次 turn 中的两类 assistant 文本：

- `commentary`：中间说明、进度播报和工具调用前后的工作叙述。
- `final_answer`：该 turn 面向用户的最终回答。

Codex rollout JSONL 与 app-server `agentMessage.phase` 都属于结构化事实，adapter 必须原样保留。前端不能根据颜色、文本内容或“后面是否还有 tool call”重新猜 Codex phase。provider 或旧历史没有 phase 时，才允许使用“同一可见用户 turn 的最后一条 assistant message”为 final answer 的兼容规则。

Chat 展示按 turn 聚合：

- commentary、reasoning、compaction、tool call、observation 和内部 operation 进入同一个处理过程区域。
- 只有已经出现 final answer 的 turn 才算展示层完成，其处理过程自动折叠为 `Worked …`；最终回答保持为常驻正文。`generationActive`、`ready` 或重连状态都不能替代 final answer 作为折叠证据。
- 尚无 final answer 的处理过程必须保持展开且不可手工折叠。当前执行中的 turn 显示为 `Working`；已中断但没有 final answer 的历史过程显示为 `Work interrupted`，同样保留展开内容。
- 展开处理过程后，连续工具活动仍默认折叠。reasoning/commentary 是活动批次边界：边界之间如果只有
  command/test/build/lint/read/edit/search 等工具事件，同类批次使用 `Ran N commands`、`Read N files`
  等语义摘要，混合批次使用 `Used N tools`；展开后必须保留 provider 原始事件顺序。
- 折叠区域如果包含失败工具，外层摘要必须保留失败数量和 warning tone，不能因为折叠而让失败不可见。
- pending permission 不进入折叠处理组，必须始终留在主 timeline 等待用户操作。

iOS standalone/PWA 与 Desktop Conversation 共享一个仅作用于 Session/Council 正文的 Appearance token。默认正文/代码为 `14px/12px`，正文 variable font weight 约 `430`，行高为 `22px`；用户可在 12–20px 调整对话正文，变更即时应用并持久化，不影响导航、标题、菜单。代码字号随正文按 11–16px 自动联动，没有独立控件。用户气泡最大宽度为 Chat 内容区的 75%，Desktop/PWA 普通 turn gap 分别为 14px/12px；隐藏动作不得占永久空白行。assistant commentary 直接作为白底正文显示，不包裹带 padding 的浅灰卡片；final-answer 相邻 Markdown block 间距为 12px。目标是同时提高字面可读性和每屏有效正文，不能只放大字号，也不能靠缩小字号掩盖动作行、气泡 padding 或 turn gap 造成的空白。

Composer 的视觉密度与 Conversation 正文密度独立：Desktop 和 PWA 可以采用不同宽度参数，但都使用同一白色 surface、相同控件层级和 focus 状态机。PWA 的宽度动画只能改变 surface 的水平 inset，不能改变 textarea 内容、丢失选区/注释、移动 Send 到框外或造成页面横向滚动。

PWA 的全局恢复提示不能居中覆盖 composer、消息正文或主要按钮。它固定在顶部 safe-area 控制行下方，以单行紧凑 toast 呈现；`390×844` 下高度不得超过 72px。PWA 与 Wide Desktop 共用低对比橙色恢复提示语义：使用明确的 orange-500 基色，背景只把橙色以约 8% 混入页面底色，边框以约 18% 混入普通边框，不使用投影；橙色主要保留给小图标，不能退回偏黄或土黄色 warning surface。Session Chat、Council、Canvas 及其他带标题的工作台页面必须共用 `WORKBENCH_HEADER_LAYOUT` 的 40px 单行高度，提示条也从同一 2.5rem token 计算 top，始终落在标题栏分割线以下。滚动宿主仍须给卡片留出内边距，不能裁掉四角。Web/daemon generation 不一致在所有响应式尺寸共享唯一文案：`Restart RAH to update` / `Restart it on the host, then refresh this page.`；隐藏 PID 与 generation 等诊断细节，只保留键盘/触控可达的 `Mute today`，不提供无法完成后台重启的 Retry。`Mute today` 由 daemon 的 `WorkbenchNoticePreferencesStore` 按主机本地午夜持久化；同一个 `RAH_HOME` 下，手机 PWA、Mac 浏览器与不同同源别名都读取同一状态，客户端在重新聚焦及短周期同步时收敛。浏览器仍先写当前页面内存，并容错同步 localStorage、sessionStorage 与同源 cookie，但这些仅用于“新 Web 连接尚未实现 notice API 的旧 daemon”兼容窗口；任一层不可用不能阻止其余层。该静音只作用于 generation compatibility advisory，不能吞掉 workbench、session、认证或 transport 错误。Wide Desktop 只改变几何并固定在真正的右下角：最大宽度 24rem，距右侧和底部各 16px，不得再消费 composer、底部浮动控件或 keyboard anchor 预留量；普通宽屏单 notice 应收敛为约 49px 高的横向 toast。窄屏非 PWA 仍可使用居中 callout，避免把角落 toast 强塞进不足宽度。

`Worked` 的兼容耗时使用该可见 turn 的 user message 时间到 final answer 时间；这与 Codex persisted `task_started/task_complete` 的用户可感知区间一致，也避免为纯展示再维护第二套计时状态。分页尚未加载到 user message 时可以退化为首个已知 process item 时间，加载完整边界后应自动校正。

### Plan 与 canonical turn

Plan 不是脱离 timeline 的全局浮动文本。前端只检查最新 canonical turn，并从该 turn 的
`ConversationTurnProjection.items` 中寻找最新 plan：

- 底部 Plan/Task summary dock 只在该 turn 为 `in_progress` 且尚无 canonical final answer 时显示；final
  answer 到达，或 turn 进入 `completed/interrupted/failed` 后立即撤下。
- dock 的状态、活动计数和耗时都读取该 turn，不从当前 session phase 或最近一条消息推断。
- dock 胶囊固定为 32px 高，只显示 plan 图标、`completed/total` 和当前 active step；不显示冗余的 `Task summary`、`Working` 或展开箭头。详情底部过滤与上方计划正文重复的 plan activity，命令统计统一写作 `Run N commands`，其余活动与 `Changed N files` 保持在同一条不换行统计带中。只要本轮存在权威 Changed files，带点击能力的 Changed files 必须排在统计带最左侧；没有变更时完全不渲染该项。
- Wide Desktop 用 hover 显示详情，指针点击不能把浮层锁住；键盘 focus 仍可访问。iOS standalone/PWA 不使用 hover，只允许点击胶囊切换，第二次点击、点外部或 Escape 均关闭。
- inline feed 隐藏同一 plan item，避免 dock 与 timeline 重复显示；plan 原始 item 仍保留在 canonical projection 中。
- 历史分页、live delta 和 Resume 都按 conversation item identity 合并，因此 plan 会随所属 turn 一起校正，
  不会绑定到后来出现的用户问题、另一个 working turn，也不会在后续无 plan 的 turn 中复活。
- 没有结构化 steps 时展示 plan markdown；有 steps 时只按 provider 给出的 `pending/in_progress/completed` 渲染，不从文字内容猜进度。

### Chat 阅读导航

Chat 主滚动区有两个不同的浮动导航动作：

- `Scroll to bottom`：回到当前 timeline 底部，并恢复 bottom-follow。
- `Read latest reply`：只要最新 assistant 最终回复的内容起点已经滚出当前 ChatThread 可滚动视口，就滚回这条回复的内容起点。最终回复本体即使较短，其后的 Changed Files、visual outputs、复制动作等本轮附属内容也可能让回复起点离开视口；因此不得再用最终回复自身高度决定按钮是否出现。

`Read latest reply` 是纯前端阅读辅助，不触发历史加载、provider 请求或 session 状态变化。它只对最新可见对话气泡生效：最新 message 气泡必须是可导航的 assistant 最终回复，才允许继续做起点可见性判断；如果用户已经发出新问题而新 assistant 回复还没出现，即使上一条 assistant 回复很长，也不显示该按钮。tool、reasoning、status 等非 message 事件不改变这个判定。起点允许至多 4px 的几何误差以吸收子像素取整；超过该容差即显示，点击后仍以已挂载 DOM 行做精确校正。

`Turn Navigator` 是阅读辅助而不是第二套 Chat feed。轮次以非内部 reminder 的 `user_message` 为唯一边界；当前视口和多个已加载轮次相交时同时激活多个刻度。悬停摘要优先显示 `final_answer`，未完成轮次才回退到最近 assistant 过程消息。点击已加载 turn 先按虚拟布局定位，再在目标行挂载后做一次 DOM 精确校正；点击未加载的 Codex turn 只读取目录记录的 byte range，合并该 turn 正文后再定位。悬停本身不触发 provider 请求。

如果后续出现新的 assistant 回复，即使新的回复很短，也不再跳回上一轮较长回复，避免跨 turn 乱序阅读。

判定依据是最新回复起点与当前 ChatThread 自己的可滚动视口顶部，而不是浏览器窗口、composer 高度或回复自身高度。普通 session/council 页面使用中间 chat 区域；Canvas pane 内使用该 pane 自己的 chat 区域。pane 最大化、右侧栏展开、composer 高度变化或浏览器 resize 后都由真实滚动宿主重新同步坐标；model meta 行、Changed Files 等行的增删只能通过实际布局自然影响坐标，不能各自参与导航门槛。

## 12. 常用开发命令

首次 checkout 或依赖变化时：

```bash
npm install
```

日常源码启动/更新后重启：

```bash
node bin/rah.mjs restart --no-open
```

如果只改后端、不需要重新构建 Web：

```bash
node bin/rah.mjs restart --no-build --no-open
```

`restart` 会停止当前 managed daemon，再用当前 checkout 的源码启动新 daemon。它会中断当前由 daemon 管理的 running provider runtimes，因为旧 daemon 会被关闭。`start` 只保证 daemon 正在运行；如果旧 daemon 已经 ready，它不会替换成新代码。普通代码更新不需要 `npm install`。

后台 daemon 管理命令：

```bash
node bin/rah.mjs status
node bin/rah.mjs logs --follow
node bin/rah.mjs stop
```

如果希望全局 `rah` 命令指向当前 checkout，可选执行一次：

```bash
npm link
rah restart --no-open
```

验证命令：

```bash
npm run test:ci
npm run test:provider-contracts
npm run test:smoke:native-browser
npm run test:smoke:native-browser-webkit
git diff --check
```

`test:ci` 递归发现 protocol/Web/runtime 的全部 test/spec 文件，并把每个文件放在独立 Node test 进程中运行；随后执行生产 Web build、确定性 Desktop/PWA 浏览器门禁、仓库卫生检查、生产源码可达性/架构检查和 `npm audit --omit=dev`。源码可达性门禁从三个 package 的真实入口静态遍历 import/export、动态 import 和 worker URL；测试专用 helper 必须进入显式小型 allowlist，不能让已失去生产 owner 的旧实现继续滞留。架构门禁对普通生产文件采用 1,600 行上限；当前 12 个历史超大 owner 进入显式、只减不增的 debt budget，并锁定 `App`、`RuntimeEngine` 已拆出的 owner 边界。仓库卫生检查同时校验 Markdown 本地链接及文档中的 `npm run` 命令。新增测试文件不需要再维护脚本白名单。

Provider browser smoke 依赖本机 CLI、账号状态和额度，只应在已配置完整的机器上运行。当前主链路优先使用 native local server probe 验证 Codex/OpenCode 的 provider-server 能力，再用 browser smoke 验证 UI：

```bash
npm run test:smoke:native-local-server
npm run test:smoke:native-browser
npm run test:smoke:native-browser-webkit
```

`test:smoke:native-browser` 是默认浏览器 smoke，会用 deterministic fake provider 跑 Codex、Claude、OpenCode 的 Chat/TUI/replay/stop/foreground recovery/Web resume 关键路径，并保存 Chat mirror、Web TUI、reload replay、Web resume history 截图。它会断言 Chat 中问题在回答之前、回答不重复、新 running session 不显示 `Loading older history` / `Unhandled provider event` 噪声、Stop 出现后可回到 idle、TUI dirty prompt 不会误注入 Chat 文本。旧的 `test:smoke:codex-browser`、`test:smoke:claude-browser`、`test:smoke:opencode-browser` 仍可作为真实 provider smoke 辅助；需要一次性跑真实三家时使用 `test:smoke:real-browser-providers`。

`npm run serve:workbench`、`npm run dev:daemon`、`npm run dev:web` 仅用于前台调试或拆分调试。Provider smoke 不是所有机器默认门禁。

## 13. 维护检查清单

改 session/control/history/provider 行为时，至少检查：

- Web new / Web resume / Canvas new 是否按 provider runtime 进入 Codex/OpenCode native local server 或 Claude tmux/TUI mux fallback。
- Codex/OpenCode Chat 输入是否走 provider structured control；Claude fallback Chat 是否以 bracketed-paste 原子提交、在 prompt dirty 时先清草稿、在 agent busy 时按 FIFO 延后注入。
- Web/PWA/Canvas 新建或 resume 后，session 是否及时出现在左侧 running 列表。
- Web 接管是否能 single-writer 发送、结束、恢复 idle。
- Stop/Close 是否能关闭对应 running 执行体。
- Detach / reload / hide canvas 是否不会关闭真实 TUI。
- 历史打开是否先显示 tail，并能上滚到第一条用户消息。
- Codex Sidebar 是否包含 Codex Desktop 展示的全部用户根会话（包括 `codex_work_desktop`），且不包含
  internal subagent rollout 或 remembered/cache 复活的旧 row；reload/focus 后数量、身份和顺序是否稳定。
- 超大且仍在增长的 rollout 首屏是否只发一个 history request；`sourceRevision` probe 是否等待
  `phase=loading` 完成并从响应 byte boundary 增量追赶。
- Chat mirror 是否来自 provider 原厂 history/db 文件，Markdown 换行、列表、代码块是否保留且不重复。
- interrupted/aborted turn 是否不会留下永久 Running tool。
- Enhanced controls 是否保持 optional；native TUI 不应暴露假的 RAH-managed plan/access/model 控制。
- iOS / iPad / desktop 的 composer、safe-area、sidebar 状态是否正常，且所有用户可见生命周期文案统一使用 running/stopped。
- iOS standalone/PWA 的 New task workspace 是否位于 composer 外部、长名称才跑马且不挤占 agent 配置；390px New task 是否继续复用单行响应式 toolbar rail、模型紧贴主动作且无横向溢出；Chat 是否保持单行 idle，并在 focus 或权限/模型菜单打开时持续展开；Session/Council 对话字号 12–20px 是否即时生效且不改变 UI 菜单；全局恢复提示是否位于统一 40px 单行标题栏下方且不遮挡 composer；Wide Desktop 提示是否保持最大 24rem、右/下 16px；Markdown 多图缩略图组是否保持有效。

## 14. 非目标

当前不做：

- 云端多用户服务。
- provider 历史文件跨机器同步。
- Web 直接接管用户未通过 RAH 启动的野生 TUI。
- 在同一个真实 TUI 中同步未提交草稿和光标。
- 为每个 provider 原生 UI 状态做像素级镜像。
