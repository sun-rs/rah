# Native TUI 真实 CLI QA 清单

日期：2026-05-18

目的：验证当前 `main` 的真实 provider runtime 路线。自动 smoke 能证明 RAH 的协议、daemon lifecycle、mock provider、browser recovery、Codex/OpenCode native local-server probes 和 Claude/Gemini tmux launch/exit；真实 CLI QA 用来覆盖账号、额度、官方 TUI 菜单、权限弹窗、长任务、真实跨客户端同步和移动端输入这些无法稳定 mock 的部分。

维护边界：Core live QA 覆盖 Codex、Claude、Gemini、OpenCode。Codex/OpenCode 默认走 `native_local_server`；Claude/Gemini 默认走 `tui_mux` / `tui_mux_fallback`。Kimi CLI 一等支持仍移除；低频 Kimi/Grok/DeepSeek 等 API-key 模型优先通过 OpenCode + API provider / 中转站验证。

## 当前本机 CLI 版本

Core live CLI 版本：

| Provider | 命令 | 当前输出 |
|---|---|---|
| Codex | `codex --version` | `codex-cli 0.130.0` |
| Claude | `claude --version` | `2.1.138 (Claude Code)` |
| Gemini | `gemini --version` | 本机安装版本，以 smoke/probe 输出为准 |
| OpenCode | `opencode --version` | `1.14.41` |

版本记录不是“兼容承诺”。`npm run test:smoke:native-cli-probe` 会在自动门槛中重新采集 core live CLI 的 `--version` 输出，并记录当前 RAH branch / commit / dirty worktree 状态；同时要求真实 CLI `--help` 探测既包含 native launch 依赖的 flag，也必须以 exit code 0 正常退出。每次升级 Codex、Claude、Gemini、OpenCode 这类 core live provider CLI 后，至少重跑本文的自动门槛和对应 provider 的真实 QA。

需要为真实 QA 固定保存一份本机证据时，可以写入 ignored 的 `test-results`：

```bash
RAH_NATIVE_CLI_PROBE_OUTPUT=test-results/native-cli-probe.json npm run test:smoke:native-cli-probe
```

完整 `npm run test:native-tui` 会默认写入同一份 `test-results/native-cli-probe.json`。需要换路径时，在运行完整 gate 前设置 `RAH_NATIVE_CLI_PROBE_OUTPUT` 即可。

需要进一步确认真实 CLI 能被 RAH native TUI launch spec 拉起、进入 PTY host 并被关闭，但不发送模型问题时，可以运行可选 smoke：

```bash
RAH_NATIVE_REAL_TUI_PROBE_OUTPUT=test-results/native-real-tui-launch.json npm run test:smoke:native-real-tui-launch
```

该命令可用于真实启动 core live provider TUI，等待默认 3 秒，确认进程没有在启动窗口内退出，然后通过 RAH PTY host 关闭。它默认使用稳定工作区 `test-results/native-real-tui-workspaces/<provider>`，避免制造已删除的系统临时目录 session。RAH 的 session list 聚合层会过滤这些内部探针工作区，避免它们出现在用户 Live / History / Recent / Workspaces。报告会记录 RAH branch / commit / dirty 状态，并区分 `rawOutputObserved` 与 `visibleOutputObserved`：有些 TUI 启动时只写 terminal escape 或短暂无可见文字，这不等于启动失败。它不发送 prompt，因此不证明模型响应、权限弹窗、额度、登录态或 long-running turn。

准备封板或开始人工 QA 前，可以先检查当前自动证据是否齐全：

```bash
npm run test:smoke:native-qa-status
```

该命令读取 `test-results/native-cli-probe.json` 和 `test-results/native-real-tui-launch.json`，确认 core live provider 的 CLI help/version probe 和真实 TUI launch probe 都通过且报告 commit 与当前 commit 一致。它也会输出仍需人工验证的项目；它不会替代 `npm run test:native-tui` 或真实 iPad/CLI QA。

需要固定保存 QA status 报告时：

```bash
RAH_NATIVE_QA_STATUS_OUTPUT=test-results/native-qa-status.json npm run test:smoke:native-qa-status
```

真实 QA 做完后，用 tracked 脚本校验人类结果是否覆盖完整清单：

```bash
RAH_NATIVE_MANUAL_QA_TEMPLATE_OUTPUT=test-results/native-manual-qa.json npm run test:smoke:native-manual-qa-status -- --print-template
RAH_NATIVE_MANUAL_QA_STATUS_OUTPUT=test-results/native-manual-qa-status.json npm run test:smoke:native-manual-qa-status
```

`native-manual-qa-status` 会要求每个必测项都是 `pass`，并且有 tester、testedAt、evidence。Provider 项还必须填写 cliVersion、workspace、sessionId；除 `*.web-new-native-tui` 外，还必须填写 providerSessionId。iPad/Safari 项必须填写 device、browser、url。它不替代人类测试，只防止最终封板时漏掉 provider 或 iPad/Safari 项。

## 自动门槛

每次 native TUI / PTY / session lifecycle 改动后必须运行：

```bash
npm run test:native-tui
```

`test:native-tui` 是完整 native TUI 自动门槛，等价于顺序运行：

```bash
npm run typecheck
npm run test:provider-contracts
npm run test:web
npm run test:runtime
npm run build:web
RAH_NATIVE_CLI_PROBE_OUTPUT=test-results/native-cli-probe.json npm run test:smoke:native-cli-probe
npm run test:smoke:native-codex
npm run test:smoke:native-providers
npm run test:smoke:native-codex-browser
npm run test:smoke:native-provider-browser
npm run test:smoke:native-browser-webkit
npm run test:manual-qa-status
git diff --check
```

这些命令覆盖 RAH 自身协议、daemon lifecycle、fake provider native TUI、Web Chat/TUI toggle、xterm 输入、Chat composer 注入 native TUI、TUI 中存在未提交草稿时 `nativeTui.promptState` 会变为 `prompt_dirty` 且 Chat composer 会被阻止不会误注入，并显示切 TUI 提交或清除草稿的 warning、core live fake native session 页面 reload 后 TUI replay、Codex 浏览器离线期间后台 native TUI 输出在 online/focus 后自动追上、Claude/OpenCode 浏览器离线期间后台 PTY 输入产生的新 native TUI 输出在 online/focus 后自动追上、Codex canvas 分屏布局切换后的 TUI replay 与 PTY resize 传递、core live fake native Stop -> Ctrl-C/SIGINT、Stop 后 runtimeState 回 idle、移动端 TUI input bridge 的快捷键、文本输入与 composition 输入，Chat 注入后 stale persisted mirror completion / Codex rollout lifecycle / OpenCode database completion 不会把 session 错误标回 idle、真实 CLI version / RAH commit 采集和真实 CLI help flag。它们不覆盖真实模型是否回答、真实权限弹窗是否出现、真实账号是否登录、真实额度是否耗尽。

`test:smoke:native-real-tui-launch` 不在完整 gate 内，原因是它会启动真实 provider TUI，可能受账号登录、官方安全确认、provider 本地状态影响；它适合作为升级 core live provider CLI 后的额外真实启动检查。它可能让 provider 记录空 session metadata，所以默认只写入稳定的 `test-results` 工作区，不使用会被删除的系统临时目录。旧的五家 provider 报告只能作为历史参考；新主线只要求 Codex、Claude、OpenCode 的真实 TUI 启动探针。人工 QA 需要在 TUI 中确认官方提示和真实 turn 行为。

`test:smoke:native-codex-browser` 还会模拟浏览器离线，后台通过 daemon 向同一个 Codex native runtime 写入新输入，然后恢复 online/focus，验证当前页面不用重新选择 session 就能追上 TUI 输出和 Chat mirror；它也会验证 Settings Version 页能从 daemon 读取并展示 terminal replay health，并在手动 Refresh 后显示 refresh-to-refresh delta；它也会验证 Codex TUI view 在 canvas 内可渲染，并在上下二分、三分、四分、左右二分布局切换后仍可恢复 replay，同时断言布局变化会同步 resize；它还会验证 TUI 中存在未提交草稿时 Chat composer 会被阻止且不会把文本误注入 TUI，并显示切 TUI 提交或清除草稿的 warning；它还会用 mobile/touch browser context 验证 TUI input bridge 和 Ctrl-C、Esc、Tab、方向键、Enter 快捷键按钮会渲染，并验证 Ctrl-C 快捷键、文本输入与 composition 输入都能写入 TUI surface。它仍不能替代 iPad/Safari 真机输入法、真实拖拽 resize 和旋转测试。

`test:smoke:native-provider-browser` 会对 core live provider 做同类浏览器恢复验证：页面离线期间通过对应 runtime 输入路径向同一个 session 写入输入，恢复 online/focus 后，当前页面必须不用重新选择 session 就追上 TUI replay / Chat mirror；同时验证 TUI 中存在未提交草稿时 `nativeTui.promptState` 会变为 `prompt_dirty`、Chat composer 会被阻止且不会误注入，并显示切 TUI 提交或清除草稿的 warning；OpenCode 还会断言 DB mirror 的 text、reasoning、tool、step 在 Chat UI 可见，且 token/cost usage 会进入 session summary。

`test:native-tui` 当前会运行 Chromium 与 WebKit browser smoke。WebKit 是主 gate 的一部分，用来尽早发现 Safari-like 的焦点、replay、canvas 和 mobile input bridge 回归；它仍不能替代 iPad / Safari 真机输入法和 PWA 后台恢复测试。需要局部复测 WebKit 时，可以单独运行：

```bash
npm run test:smoke:native-browser-webkit
```

Firefox 近似验证不属于主 gate，有独立入口：

```bash
npm run test:smoke:native-browser-firefox
```

`RAH_NATIVE_BROWSER` 支持 `chromium`、`firefox`、`webkit`。对应 Playwright browser runtime 必须已安装；如果 WebKit 或 Firefox 缺失，需要先用当前 Python Playwright 环境安装，例如 `python -m playwright install webkit` 或 `python -m playwright install firefox`。browser smoke 会先预检所选 runtime，缺失时不会启动 daemon 或 native fake session，并在 JSON 输出中标记 `phase: "browser_preflight"`。

2026-05-08 当前主 gate 已包含：

```bash
npm run test:smoke:native-browser-webkit
```

这轮 WebKit smoke 曾暴露并修复了一个真实 race：final-state Chat mirror 不能把 native TUI 中未提交的本地草稿从 `prompt_dirty` 覆盖回 `prompt_clean`。当前 core live 回归以 Claude/Codex/OpenCode 路径为准。

## 通用真实 QA

Core live provider 都按同一组用例跑，只有 provider 原生能力不同。Codex/OpenCode 的普通 Chat 输入应走 provider server API，不应通过 tmux/键盘注入；Claude fallback 的 Chat 输入仍需要通过 TUI/tmux 工作现场完成。

1. Web new session：从 RAH Web 创建新 session，默认应启动真实官方 TUI。
2. Chat 输入：在 Chat view 发一句短问题，TUI 应收到输入；如果 TUI 忙，第二句应排队而不是丢失。
3. TUI 输入：切到 TUI view 直接输入一条消息，Chat mirror 若支持应最终显示结构化内容。
4. Chat/TUI 切换：回答过程中反复切换视图，不应重启 TUI，不应丢 scrollback。
5. Stop：回答中点击 Stop，应传到 TUI；不应一直保持 running/stop 状态。
6. Archive/Close：关闭 session 应关闭 daemon-owned TUI；Hide / canvas pane 切换不应关闭 TUI。
7. 非预期退出：在 TUI 内执行退出或让 provider 异常退出，session 应变成 `stopped`，Settings Native TUI diagnostics 应出现 `process_exited` 或页面 warning。
8. 连续追问：连续发送两到三轮，不能丢第二个问题，不能重复用户问题或重复 assistant 气泡。
9. 权限弹窗：TUI 正在权限确认、菜单选择或本地草稿非空时，Chat composer 不应盲目注入文本；不确定时应提示切 TUI。
10. 历史回看：关闭浏览器再打开，TUI replay 和 Chat mirror 应能恢复最近内容，不应重复输出。
11. Mirror 诊断：如果 Chat mirror 源缺失或更新失败，Settings Native TUI diagnostics / session notice 应显示 `mirror_source_missing` 或 `mirror_failed`，但 TUI live session 不应被关闭。

## Provider 专项

### Codex

- `/goal` 能在 TUI view 原生使用。
- `/permissions` 或官方权限菜单能在 TUI view 原生使用。
- Chat mirror 以 rollout 为来源，回答完成后应显示 user / assistant / tool / lifecycle。
- Prompt clean 依赖 Codex prompt marker 与 rollout lifecycle；长任务和权限弹窗状态必须手测。

### Claude

- `--session-id` 新建和 `--resume` 恢复应绑定同一个 provider session。
- 真实 permission prompt 出现时，TUI view 应可操作；Web Chat 不应误注入到 prompt。
- JSONL mirror 是 final-state mirror，不承诺中间态流式；回答落盘后 Chat view 应显示完整消息。
- 真实模型/effort 参数只在启动参数稳定时使用，复杂官方菜单优先走 TUI。

### Gemini / Kimi

- Gemini CLI 已恢复为 `tui_mux` live provider；启动参数依赖 `--session-id` / `--resume` / `--approval-mode` / `--model`，历史 mirror 读取 `~/.gemini/tmp/**/chats/session-*.json`。
- Gemini 不恢复 ACP/headless structured live；Web Chat 的结构化内容来自历史文件 mirror，不从 ANSI/TUI 输出反推。
- Kimi CLI 一等支持仍移除；Kimi/Grok/DeepSeek 类低频模型优先通过 OpenCode + API provider / 中转站使用。

### OpenCode

- `opencode [project]` 的项目目录优先级必须真实验证。
- `opencode --session <id>` 恢复行为必须真实验证。
- `--model provider/model` 是否严格生效必须真实验证。
- 不要把 variant 拼进 TUI `--model`。已验证 `opencode run --variant` 和 ACP `provider/model/variant` 可用，但 TUI 主路径没有稳定 `--variant` 启动参数；variant/effort 应作为 OpenCode 原生 TUI 内部选择或后续 enhancement。
- Ctrl-C 中断真实 OpenCode turn 的稳定性必须真实验证。
- DB mirror 当前会增量展示已进入 DB 的 text/reasoning/tool/step parts 和 message token/cost usage，但不承诺完整复刻官方 UI 的所有中间态；实时交互以 TUI 为真相。

## iPad / Safari / PWA QA

这些问题不适合只靠桌面 Playwright 判断，必须真机或至少 Safari 手测：

1. iPad 竖屏应识别为可用 canvas / split screen 尺寸，不应退化成手机极窄布局。
2. TUI 输入法 composition 不应吞字、乱序、重复提交。
3. 页面切到后台再回来，PTY replay 和 Chat mirror 应补齐最新输出，不应重复输出。
4. 旋转屏幕和改变分屏比例后，xterm resize 应跟随 pane 尺寸。
5. 局域网访问时，WebSocket 断线重连后 TUI replay 应从 seq cursor 恢复。
6. 点击 terminal 任意区域弹出输入法时，终端应按键盘上方可见高度重绘，光标/最新行应停在输入法上方附近，不应出现需要来回滚动才能继续操作的漂移。
7. 点击 terminal 任意区域和点击 RAH 输入桥应触发一致的键盘处理：快捷键条应稳定停在键盘上方，terminal 不应因为焦点落到 xterm hidden textarea 而整体上移或乱飘。
8. RAH terminal light/dark 主题应与 Web UI 视觉一致，移动端输入桥和快捷键条不应像独立的黑色外来控件。
9. 中文、英文、符号混排时，字体间距、行距和背景底色应接近 Web UI 的正常阅读效果；不应出现汉字之间明显异常拉宽、行高过松或终端背景突兀的问题。

## 通过标准

一轮真实 QA 通过需要同时满足：

- 自动门槛全绿。
- `npm run test:smoke:native-manual-qa-status` 基于人类填写的 `test-results/native-manual-qa.json` 通过。
- Core live providers（Codex、Claude、OpenCode）至少完成 Web new、Chat/TUI 输入、Stop、Archive、历史恢复。
- Codex `/goal`、Claude permission prompt、OpenCode resume/model/interrupt 至少各手测一次。
- 任意失败必须记录 provider、CLI 版本、RAH commit、workspace、session id、复现步骤。

## 失败记录模板

```text
Provider:
CLI version:
RAH branch/commit:
Workspace:
Session id:
Provider session id:
Steps:
Expected:
Actual:
Diagnostics:
Logs:
```
