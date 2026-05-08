# RAH Zellij Mux Backend Goal

目标：在 `experiment/zellij-mux-backend` 分支上，把 RAH 的 live TUI 主链路从自研 daemon PTY relay 迁移为 zellij-backed mux runtime。核心不是继续补自研 PTY，而是复用 zellij 的 session/pane/scrollback/subscribe/send-keys/web/remote attach 能力，验证它能否成为 RAH 的长期底层。

## 背景

当前 `refactor/pty-first-core` 已经把 live provider 收敛到 Codex / Claude / OpenCode，并移除了 Gemini/Kimi CLI 一等支持。它证明了 PTY-first 方向，但自研 PTY relay 仍暴露出 Codex/Claude 卡顿、ANSI 重绘敏感、终端模式恢复、移动端输入法联动等高成本问题。

zellij 0.44.x 已提供 RAH 需要的底层能力：

- 后台 session 和 pane 生命周期。
- `zellij run` 创建 command pane 并返回 `terminal_<id>`。
- `zellij action list-panes --json --state --command --geometry` 获取 pane 状态、退出码、尺寸、命令。
- `zellij action dump-screen --full --pane-id` 获取 viewport + scrollback。
- `zellij subscribe --pane-id --format json --scrollback` 获取实时 pane 更新。
- `zellij action write-chars` / `send-keys` 向指定 pane 注入输入。
- `zellij web` / token / read-only token 作为未来远程访问候选。

已知工程约束：

- macOS 默认 `$TMPDIR` 可能导致 zellij IPC socket path 过长；RAH 必须固定短路径，例如 `ZELLIJ_SOCKET_DIR=/tmp/rah-zellij-sock`。
- RAH 必须使用短 session id。
- zellij 默认 layout 有 tab-bar/status-bar/about 插件；RAH provider pane 需要 clean layout 或创建后清理默认 shell pane。
- Codex 在 multiplexer 下需要重点验证 `--no-alt-screen`、scrollback、Esc Stop、`/exit`、长历史。
- zellij 是实验 backend，不能破坏已提交的 `refactor/pty-first-core` 可回滚基线。

## 核心原则

1. 实用主义：先做最小可运行垂直切片，不一次性重构全部 UI。
2. 稳健性：所有 zellij session/pane 必须可发现、可恢复、可关闭、可诊断。
3. MVP：先证明 Codex 一家真实可用，再扩到 Claude/OpenCode。
4. DRY：Web New、Web Claim、`rah <provider>`、`rah <provider> resume` 都复用同一个 zellij runtime。
5. 不反编译 TUI 语义：Chat structured view 继续来自 provider 原厂 jsonl/db/session 文件；zellij screen 只作为 TUI view 和远程控制面。
6. 不继续扩大 provider 私有控制：模型、权限、plan、slash command 等不是这次核心；用户可在原生 TUI 内操作。
7. zellij backend 必须能随时回退到上一提交的 PTY-first runtime。

## 目标架构

引入一个明确的 mux abstraction：

```text
Provider launch spec
  -> MuxRuntime.createSession()
  -> ZellijMuxBackend.createPane()
  -> zellij session + pane id
  -> Web terminal view via subscribe/dump-screen
  -> Web input via write-chars/send-keys
  -> desktop terminal via zellij attach/watch
  -> structured chat mirror via provider history files
```

RAH 需要持久化或记住：

- `rahSessionId`
- `provider`
- `providerSessionId`，如果已绑定
- `workspace cwd/rootDir`
- `zellijSessionName`
- `zellijPaneId`
- `zellijSocketDir`
- `launch command/args`
- `createdAt/updatedAt`

## Phase 0：实验保护与基线

- 确认当前分支为 `experiment/zellij-mux-backend`。
- 保留 `e59ca6f Finalize PTY-first native TUI core` 作为回滚基线。
- 不删除当前 `PtySessionRuntime`，先让 zellij backend 以并行实验路径接入。
- 新增 runtime feature flag，例如 `RAH_MUX_BACKEND=zellij` 或请求参数 `liveBackend: "zellij_tui"`。
- 所有新增 zellij 文件命名清晰，避免混入 provider adapter。

验收：

- `npm run typecheck` 通过。
- 不影响默认 `rah start` 和现有 native_tui 路径。

## Phase 1：ZellijMuxBackend 最小实现

新增 zellij runtime 模块，封装命令而不是散落调用：

- `ensureZellijAvailable()`
- `createSession({ sessionName, cwd, command, args })`
- `createProviderPane(...)`
- `listPanes(sessionName)`
- `dumpScreen(sessionName, paneId, { full, ansi })`
- `subscribePane(sessionName, paneId)`
- `writeChars(sessionName, paneId, text)`
- `sendKeys(sessionName, paneId, keys[])`
- `closePane(sessionName, paneId)`
- `killSession(sessionName)`

实现要求：

- 固定 `ZELLIJ_SOCKET_DIR=/tmp/rah-zellij-sock`，目录可配置但默认短路径。
- session name 使用短 id，例如 `rah-<8 chars>`。
- 创建 provider pane 后获取并保存 `terminal_<id>`。
- 处理 pane `exited` / `exit_status`，同步到 RAH `runtimeState: "stopped"`。
- zellij 命令失败必须产生 diagnostics，不得让 daemon 崩溃。

验收：

- 单元测试覆盖 list/dump/write/send/exit 状态解析。
- 用 fake shell pane 做集成测试：输入 `hello` 后 dump/subscribe 能看到 echo；输入 `exit` 后 list-panes 显示 exited。

## Phase 2：Codex 垂直切片

先只接 Codex：

- `rah codex --mux zellij` 或 `RAH_MUX_BACKEND=zellij rah codex` 启动 Codex 到 zellij pane。
- Web New Session 可以选择 zellij backend 创建 Codex。
- Web TUI view 通过 zellij subscribe/dump-screen 渲染。
- Chat composer 向 zellij pane 注入文本 + Enter。
- Stop 发 Codex 原生 Escape，不再发 Ctrl-C。
- `/exit` 后 RAH 识别 pane exited，UI 不再显示可输入 live。
- Codex 启动优先带 `--no-alt-screen` 做 scrollback 兼容验证。

验收：

- `rah codex --mux zellij` 桌面可 attach 并看到原生 Codex TUI。
- Web 可看到同一个 pane。
- Web 输入能进入 TUI。
- TUI 输入后 Web chat mirror 能从 Codex rollout 文件看到结构化内容。
- Stop 不退出 Codex 进程。
- `/exit` 能同步 stopped。
- 长输出/长历史 dump-screen 能拿到可用 scrollback。

## Phase 3：Claude / OpenCode 扩展

在 Codex 成功后扩展：

- Claude：验证颜色、Levitating 状态残留、Esc Stop、API error 刷屏展示、`/exit`。
- OpenCode：验证其原本流畅体验不因 zellij backend 退化，确认 model/variant 边界仍以 OpenCode 原生能力为准。

验收：

- 三家 provider 都能通过 zellij backend 启动、输入、stop、exit、dump、subscribe。
- structured chat mirror 仍来自原厂文件，不来自 zellij screen scrape。

## Phase 4：Web/PWA TUI 体验

- Web terminal view 可以先使用 zellij subscribe JSON 渲染为 xterm 或轻量 screen snapshot。
- 若 zellij 内置 web client 明显更好，记录是否可以嵌入/跳转作为 TUI fallback。
- iOS/PWA 重点验证键盘弹出、中文输入、快捷键、滚动、viewport 高度。
- Web attach 不应强行改变桌面 terminal 尺寸；需要研究 zellij 是否有等价 read-only/watch 或尺寸隔离方案。

验收：

- iPad/Safari 真机记录。
- iPhone 竖屏不允许进入不支持的分屏/画布 TUI 操作。
- TUI 切换不导致 chat send 按钮卡死。

## Phase 5：收敛或放弃决策

完成真实 provider 测试后做决策：

- 如果 zellij backend 在 Codex/Claude/OpenCode 上明显优于自研 PTY，逐步把默认 backend 改为 zellij。
- 如果 zellij 的 scrollback/resize/Web 控制无法满足需求，保留实验分支结论，回到 tmux backend 或当前 PTY-first。
- 不允许在没有真实 provider + 浏览器 + iOS 人工证据时宣称完成。

## 必跑测试

- `npm run typecheck`
- `npm run test:runtime`
- `npm run test:web`
- `npm run build:web`
- zellij fake pane smoke
- Codex real smoke
- Claude real smoke
- OpenCode real smoke
- iPad/Safari manual QA

## 人类 QA 清单

1. `rah codex --mux zellij` 桌面 terminal 是否原生流畅。
2. Web TUI 是否能看到同一个 zellij pane。
3. Web chat 输入是否准确进入 TUI。
4. TUI 内输入是否能被 chat mirror 结构化展示。
5. Stop 是否只中断 thinking，不退出 provider。
6. `/exit` 是否让 RAH session 变 stopped。
7. Codex 长历史/scrollback 是否可用。
8. Claude 颜色和临时状态行是否正确。
9. OpenCode 是否继续流畅。
10. iOS 键盘弹出时 TUI 是否可用。
11. 多端同时 attach 时尺寸和输入是否可控。

## 非目标

- 不恢复 Gemini/Kimi CLI 一等 provider。
- 不把 zellij screen dump 当 structured chat 的事实来源。
- 不在第一阶段重做全部 canvas/session UI。
- 不承诺 provider 模型/权限/plan 的跨 CLI 统一语义。
- 不实现自己的 tmux/zellij 级 screen buffer。

## 最终判断标准

zellij backend 只有在同时满足以下条件时才可以成为默认主线：

- 本地 terminal 体验明显接近原生 TUI。
- Web/PWA 可以继续操作同一个没有 resume 的 session。
- `/exit`、Stop、resize、detach、reconnect 都稳定。
- Chat mirror 不重复、不串 session、不依赖 ANSI。
- 代码复杂度相比自研 PTY relay 下降，而不是新增一套更复杂的并行系统。
