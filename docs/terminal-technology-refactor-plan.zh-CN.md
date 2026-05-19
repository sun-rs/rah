# RAH Terminal 技术重构计划

## 目标

RAH 不再把所有交互都塞进同一种 terminal 生命周期。新的边界是：

- terminal 是可见操作面，不等于 agent 主循环。
- 关闭 terminal 窗口默认是 hide/detach，不是 kill。
- 只有用户明确点击单个 terminal tab 的关闭按钮，才终结该 terminal 后台进程。
- Council 的权威状态来自 council log/MCP，而不是 terminal transcript。

## 三个场景

### 1. Session/Workspace 临时 Terminal

用途：开发辅助 shell，例如 `npm run dev`、测试 watch、本地 server、临时命令。

设计语义：

- 多 tab terminal 弹窗右上角关闭：只隐藏窗口，所有 tab 对应 PTY 后台保活。
- 单个 terminal tab 上的 `x`：终止该 tab 的 PTY。
- 重新打开 terminal 弹窗：列出并 attach 已存在的后台 PTY。
- 页面刷新或 PWA 切后台：不主动杀 PTY。
- daemon 重启：临时 PTY 消失，暂不承诺跨 daemon 持久化。

技术方案：

- 后端维护 `TerminalRegistry`，按 workspace/session 归属记录 terminal tab。
- 前端多 tab terminal 弹窗只管理 attach/detach，不拥有进程生命周期。
- xterm 只接收增量输出；允许小 bounded replay 兜底，但不能用长历史 snapshot 重建画面。
- UI 文案区分 `Hide` 和 `Terminate`，避免用户误杀后台任务。

### 2. Live Session Native TUI / 无缝接续

用途：常规 chat session 的 provider 原生 TUI 或远程接续。

Codex/OpenCode：

- 使用 server/app-server 作为 session runner。
- agent turn 和 MCP wait 可以在 server 侧无头运行。
- 本地 terminal TUI、Web terminal、手机 PWA 都只是 attach/client surface。
- 关闭可见 TUI 不应该终止 session runner。
- 已验证 OpenCode 和 Codex：无 TUI client 时，server 仍能 `channel_wait_new -> channel_post -> channel_wait_new`。

Claude：

- 暂未验证存在等价的 server-side runner。
- 继续保留 persistent real TUI runner，目前统一为 tmux-backed Claude TUI。
- Claude 的 terminal 不是纯展示，而是 runner surface；关闭 UI 只能 detach，不能 kill。

技术方案：

- Codex/OpenCode 优先收敛到 provider native local server/client 模型。
- Claude 单独保留 TUI-backed runner，直到有可靠 headless/server runner 替代。
- Web chat 输入走 provider server/control API，不依赖往 terminal 里“打字”。
- TUI 面板只作为观察和少量直接操作入口，不能成为 session 状态唯一来源。

### 3. Council Agent Terminal

用途：查看 Council agent 当前状态、调试卡住的 agent、必要时人工接管。

设计语义：

- Council 权威数据是 council log、agent status、task/evidence/claims，不是 terminal 内容。
- Codex/OpenCode agent runner 应改为 headless server-side runner。
- Claude agent 暂时保留 persistent TUI runner。
- terminal 只是 optional attach/debug surface。
- 关闭 terminal dialog 不影响 agent 继续监听 council。

技术方案：

- Codex/OpenCode Council agent：server-side turn + MCP wait loop。
- Claude Council agent：TUI-backed persistent runner。
- Council terminal dialog 复用统一多 tab terminal UI。
- 禁用 Council terminal snapshot/replaceReplay 作为主机制。
- 访问过的 terminal tab 可保活；切 tab 不销毁 xterm、不重连、不重放长历史。
- 首次打开长期静默 terminal 时，只做 bounded replay 或 resize jolt，不能全量 replay。

## 技术栈收敛

新的实现应收敛成两类后端生命周期，加一个统一前端 terminal surface：

- `Background PTY Registry`：用于 session/workspace 临时 shell，以及 Claude 这类必须依赖真实 TUI 的 runner。
- `Provider Headless Runner`：用于 Codex/OpenCode 这类可以由 server/app-server 持续运行的 provider。
- `Unified Terminal Surface`：前端统一 xterm 多 tab 组件，只负责 attach/detach/input/resize，不决定后台进程是否存在。

### Runner 策略协议

RAH 当前采用一条固定策略：

- Codex / OpenCode：默认 `native_local_server`。provider server 是 session runner，本地 TUI、Web TUI、PWA 都只是 client surface。
- Claude / Gemini：默认 `tui_mux`。两者暂时没有 RAH 可用的等价 native local server，tmux TUI 是 session runner fallback。
- 其它 provider：不进入 live session 主线，只能作为 stored history/custom 扩展处理。

这条策略必须由协议层共享，而不是在前端、daemon、CLI、Council 各自写一遍判断。当前代码中的权威入口是 `packages/runtime-protocol/src/live-backend-policy.ts`：

- `defaultLiveBackendForProvider(provider)`
- `isNativeLocalServerProvider(provider)`
- `isTuiMuxFallbackProvider(provider)`
- `liveBackendSupportedByProvider({ provider, liveBackend })`

任何新入口（例如 Council runner、CLI attach、未来 tmux backend）都必须先经过这套策略。这样 Codex/OpenCode 的 server-client 主线和 Claude 的 mux fallback 不会再次漂移。

Native local server 的 TUI client attach 命令也必须集中生成。当前 daemon 侧入口是 `packages/runtime-daemon/src/native-local-server-attach.ts`：

- Codex：`codex --remote <ws-endpoint> resume <thread-id>`
- OpenCode：`opencode attach <server-url> --session <session-id>`

该模块同时负责 runtime diagnostics 里的 `attachCommand`。Info 面板、Web TUI client 启动、未来 Council debug terminal 都应引用同一处结果，不能手写 provider-specific attach 字符串。

## 画面性能与长期运行策略

核心原则：terminal 画面不能依赖“把历史全部重放一遍”。长期运行后打开慢、切 tab 白屏、滚动卡顿，根因通常都是 unbounded replay、unbounded scrollback、反复销毁/重建 xterm、隐藏 terminal 仍高频渲染。

### 通用技术

- 后端输出缓冲使用 byte/line bounded ring buffer，只保留近期可视 tail，不保存无限 terminal 历史。
- 前端 xterm 设置明确 scrollback 上限；历史对话、council log、工具调用走结构化 timeline，不塞进 terminal scrollback。
- PTY/WebSocket 输出批量写入 xterm，按 animation frame 或小时间窗合并，避免每个 chunk 触发一次渲染。
- resize/input/control 只有当前可见 surface 可以 claim；隐藏 tab 不 claim、不抢 resize、不抢焦点。
- tab 切换不销毁已访问过的 xterm instance；关闭 dialog 才释放前端 xterm，但不杀后台进程。
- 重新打开 dialog 只拉 bounded tail 或 provider 当前屏幕，不做全量历史 replay。
- 如果输出速度超过 UI 消费能力，视觉层可以丢弃最老的未渲染 tail，但不能阻塞后台 runner。

### Session/Workspace 临时 Terminal

稳定策略：

- 后台 PTY 常驻在 daemon 的 registry 里，dialog 只是 attach surface。
- dialog 关闭后 PTY 继续运行，输出进入 bounded ring buffer。
- 重新打开时立即返回最近 tail，再接 live stream。
- tab `x` 才 terminate PTY，同时清理 registry、buffer、xterm。

性能边界：

- 这类 terminal 面向 shell/server/test watcher，不承诺无限 scrollback。
- 如果用户在里面跑全屏 TUI，重新 attach 后只能靠当前输出、bounded tail 或 resize jolt 恢复画面；不能为了全屏 TUI 保存小时级 snapshot。
- 需要长期保留的日志应由任务日志/文件/timeline 承载，不由 xterm scrollback 承载。

### Live Session Native TUI

Codex/OpenCode：

- runner 在 provider server/app-server 中，terminal client 不是状态源。
- 打开 terminal 时 attach 到 server session 或启动轻量 client；关闭 terminal 不影响 runner。
- chat 历史、工具调用、reasoning、token usage 来自 provider structured events/history，不来自 terminal replay。
- 因此 terminal 可以只显示当前 client 画面，不需要重放完整 session transcript。

Claude/Gemini：

- Claude/Gemini 暂时依赖 persistent real TUI runner，建议继续由 tmux 这类成熟 multiplexer 承担长期 TUI 状态。
- Web terminal attach 时只取当前屏幕/近期 tail，不读取完整 multiplexer scrollback。
- Claude/Gemini 的 transcript 仍应从 provider history/structured parser 进入 RAH timeline，不能靠终端画面解析。

性能边界：

- Codex/OpenCode 的“无缝接续”应优先走 server/client，不走 PTY replay。
- Claude 如果还没有 headless runner，只能接受它是 provider 特例；稳定性依赖 multiplexer，而不是 RAH 自己重建 TUI 屏幕。

### Council Agent Terminal

稳定策略：

- Codex/OpenCode Council agent 默认 headless runner；terminal 只在用户需要调试时 attach。
- Claude Council agent 暂时 persistent TUI runner。
- Council 的权威输出是 council log/MCP event，不是 terminal transcript。
- terminal dialog 内访问过的 tab 保留 xterm instance；切 tab 只切可见层。
- inactive tab 不应持续高频渲染；可以记录 dirty 状态和 bounded tail，激活时再批量补最近输出或触发当前屏幕刷新。

性能边界：

- Council terminal 不做周期性 snapshot，不做 replaceReplay，不做长历史全量重放。
- 关闭 Council terminal dialog 不影响 agent runner。
- 重新打开长期运行的 agent terminal，允许短暂 current-screen 恢复，但不允许随运行时间线性变慢。

## 重构顺序

1. 先重构 session/workspace terminal 生命周期：关闭 dialog 变成 hide，tab `x` 才 terminate。
2. 抽出统一 terminal dialog/tab 组件，让 workspace/session/Council 共用视觉和 attach 行为。
3. Council 的 Codex/OpenCode agent 改为 headless runner，terminal 仅作为 optional attach。
4. Claude Council 保持 persistent TUI runner，并明确标注为 provider 特例。
5. 移除 Council terminal snapshot 依赖，保留 bounded replay/resize jolt 兜底。
6. 补充 registry 状态 API，让 UI 能展示后台 terminal 是否 running、detached、exited。

## 实施记录

### 2026-05-17 第一阶段：Session/Workspace Terminal Lifecycle

状态：生命周期语义已完成，低延迟性能尚未最终验收。

已完成：

- 后端为 independent terminal 增加 registry。
- 新增 `/api/terminal/list?cwd=...`，用于重新打开 terminal dialog 时找回后台 PTY。
- terminal registry 支持 `workspace` / `session` owner scope，同一工作区下不同 session 的 terminal 可以隔离找回。
- 前端 terminal dialog 关闭按钮语义改为 `Hide`，不再终止后台 PTY。
- 单个 terminal tab 的 `x` 和 terminal 面板内关闭按钮语义改为 `Terminate`。
- 重新打开 terminal dialog 时优先 attach 同工作区已有 terminal；没有已有 terminal 时才创建新的。
- Session/Workspace terminal tab 已保活，切 tab 不再销毁并重建 xterm。
- 非当前 tab 不再持续写入不可见 xterm，只保留 bounded output tail；切回时补写最近输出，避免多 tab 高频输出拖慢浏览器。
- terminal reconnect 支持 tail replay，Workbench 默认只请求近期 replay，不再拉完整 PTY replay。
- PTY WebSocket 输出按短时间窗合包并限制单批写入，降低小包抖动和大块写入导致的主线程卡顿。

当前实现校准：

- Workbench hidden tab 仍保持 `TerminalPane` 与 PTY WebSocket 订阅，但不会持续写入不可见 xterm；`renderOutput={active}` 会让非当前 tab 只累积 bounded paused tail，切回时再补写最近输出。
- Workbench dialog 关闭后会释放前端 xterm surface，但不终止 daemon 后台 PTY；重新打开 dialog 时通过 `/api/terminal/list` 找回后台 PTY。
- 重新打开 dialog 不是 `initialReplay=false`，而是 bounded tail replay；Workbench 当前请求最近 `512KB` PTY replay，然后继续接 live stream。
- 单 tab 切换和 dialog 重开是两种不同恢复路径：tab 切换优先使用前端 paused tail，dialog 重开使用后端 PTY tail replay。
- daemon 内部 `IndependentTerminalProcess <-> independent-terminal-host.py` 已从 `base64 + JSON line` 改为长度前缀二进制帧，减少 shell echo、小块输出和 resize/input 控制消息的序列化开销。

未覆盖：

- Council Codex/OpenCode agent 已切到 native local server runner。
- Claude mux fallback 已收敛为 tmux-only。
- 尚未把 PTY WebSocket 改成 browser binary frame；当前 daemon -> browser 仍是 JSON frame。
- 尚未完成真实浏览器长输出/连续输入延迟基准测试；第一阶段不能只靠单元测试判定完成。

### 2026-05-17 第二阶段准备：Runner 策略提纯

状态：策略层已集中，Council 复用普通 session runner；Claude mux fallback 已收敛为 tmux-only，旧 zellij backend 已移除。

已完成：

- 在 `runtime-protocol` 增加 live backend policy，统一定义 Codex/OpenCode -> `native_local_server`、Claude/Gemini -> `tui_mux`。
- 前端 new/resume 入口改用共享策略，不再本地硬编码 provider/backend 对应关系。
- daemon runtime engine 改用共享策略验证 provider/backend 组合，避免 Claude 被误接 native local server、Codex/OpenCode 被误接 mux fallback。
- runtime descriptor 默认值改为共享策略：缺省 backend 时，Codex/OpenCode 仍描述为 native local server，Claude/Gemini 描述为 mux fallback。
- native local server attach 命令集中到 `native-local-server-attach.ts`，Codex/OpenCode diagnostics 与 Web TUI client 启动不再各自拼命令。
- Council 的 Codex/OpenCode agent 已切到普通 session 的 native local server runner，不再用独立的 `startAgentPty` 路径启动 provider TUI。
- 新增 `MuxRuntime` 的 tmux backend，实现 session/window/pane 创建、pane capture、输入、控制键、resize、关闭和诊断基础能力。
- `tui_mux` fallback 的底层 mux backend 只有 `tmux`。不再提供其它 mux backend 入口。
- CLI `rah attach` / `rah claude` 只使用 tmux attach。

仍未完成：

- `bin/rah.mjs` 仍保留 JS 侧轻量策略函数，因为 CLI 当前不直接加载 TypeScript protocol helper；后续可在构建产物稳定后消除这份重复。
- 内部命名已统一到 `tui_mux` / `tmux` 语义；后续只做局部命名清理，不再保留 zellij 运行入口。

验证记录：

- `tmux-mux-backend.test.ts` 覆盖 tmux session 名、fake shell pane、tab pane、control bytes。
- `tmux-tui-runtime.test.ts` 覆盖 Claude `tui_mux` fallback 的启动、输入、中断、关闭和 tmux session 清理。

## 必须保证的不变量

- 关闭 terminal dialog 不杀进程。
- 只有关闭单个 terminal tab 才杀对应进程。
- agent 是否继续工作不能依赖 terminal 是否打开。
- Web UI 的 session/council 状态来自 daemon/provider events，不来自 terminal transcript。
- 对长期运行 terminal，不允许通过全量历史 replay 重建屏幕。
- provider runner 崩溃、terminal attach 断开、council 停止必须是不同状态，不能混成一种 stopped。

## 仍需验证

- Codex/OpenCode headless runner 多小时 `channel_wait_new` 稳定性。
- Codex/OpenCode server 崩溃后的 council/session 恢复策略。
- 多 agent 同时 wait/post 的竞争与顺序一致性。
- Claude 是否有可替代 tmux/TUI runner 的 headless 方案。
- iPad/PWA 后台切换后 terminal attach 与后台 PTY 的状态恢复。
