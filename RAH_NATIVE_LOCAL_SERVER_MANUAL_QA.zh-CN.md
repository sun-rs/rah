# RAH Native Local Server 人工 QA 清单

Date: 2026-05-09

Branch: `refactor/native-local-server-core`

Expected commit: `bd49367`

## 目的

这份清单用于完成 `test-results/native-manual-qa.json` 中的 26 项人工验收。自动化 smoke 已覆盖 mock provider、真实 Codex/OpenCode local server probe、Claude zellij launch/exit、Chromium/WebKit/Firefox browser smoke；人工 QA 只验证自动化无法可靠覆盖的真实账号、真实 TUI、真实设备和真实长 turn 行为。

## 准备

确认当前分支和 commit：

```sh
cd /Users/sun/Code/repos/rah
git status --short --branch
git rev-parse --short HEAD
```

期望：

- 分支是 `refactor/native-local-server-core`
- commit 是 `bd49367`
- worktree 干净

启动最新 RAH：

```sh
npm run build:web
node bin/rah.mjs restart
node bin/rah.mjs status
```

打开：

```txt
http://127.0.0.1:43111
```

如果要在 iPad/iPhone PWA 上测，使用同一局域网下的主机 IP，例如：

```txt
http://<mac-lan-ip>:43111
```

## 记录方式

把每项结果写入：

```txt
test-results/native-manual-qa.json
```

每个 pass 至少填：

- `tester`
- `testedAt`
- `device`
- `browser`
- `url`
- `workspace`
- `sessionId`
- `providerSessionId`
- `cliVersion`
- `evidence`

校验：

```sh
npm run test:smoke:native-manual-qa-status
```

只有该命令通过，goal 才能进入最终 completion audit。

## Codex

CLI version:

```sh
codex --version
```

### codex.web-new-native-tui

1. 在 Web 新建 Codex session。
2. 打开 `Info`，确认 runtime 是 `native_local_server`。
3. 确认 provider session/thread id 存在。
4. 点击 `TUI`，确认官方 Codex TUI 出现。

### codex.chat-input-and-mirror

1. 在 Chat 输入一个带唯一 marker 的问题。
2. 切到 TUI，确认问题进入官方 TUI。
3. 等回答完成，回到 Chat，确认结构化回答出现。

### codex.tui-input-and-replay

1. 在 TUI 直接输入问题。
2. 回到 Chat，确认同一轮出现在 Web。
3. 刷新浏览器，确认 TUI replay 和 Chat history 都还在。

### codex.stop

1. 发一个长任务，例如让 Codex `sleep 20` 后再回答。
2. 在 Chat 点 Stop。
3. 确认 TUI 没退出，状态回到 idle，后续还能继续发问。

### codex.continuous-followup-no-duplicates

1. 连续发 3 个短问题。
2. 确认三个问题都有回答。
3. 确认没有重复用户问题、重复回答、回答插到错误位置。

### codex.archive-history-recover

1. Archive 当前 live session。
2. 确认 Live 列表消失。
3. 到 History 找回该 session。
4. 确认 history 可读，且没有 orphan live 状态。

### codex.goal

1. 在 TUI 输入 `/goal` 创建简单目标。
2. 确认 TUI 原生 `/goal` 行为可用。
3. 确认 Chat 不因为 `/goal` 产生错误重复输出。

## Claude

CLI version:

```sh
claude --version
```

### claude.web-new-native-tui

1. 在 Web 新建 Claude session。
2. 打开 `Info`，确认 runtime 是 `tui_mux_fallback`。
3. 点击 `TUI`，确认 Claude Code 原生 TUI 出现。

### claude.chat-input-and-mirror

1. 在 Chat 输入一个唯一 marker 问题。
2. 切到 TUI，确认问题进入 Claude TUI。
3. 等 JSONL/history mirror 更新后，确认 Chat 出现回答。

### claude.tui-input-and-replay

1. 在 TUI 直接输入问题。
2. 回到 Chat，确认同一轮可读。
3. 刷新页面，确认 replay 不丢。

### claude.stop

1. 让 Claude 执行长任务。
2. 在 Web Chat 点 Stop。
3. 确认 TUI 不退出，状态回到 idle，后续可继续问。

### claude.continuous-followup-no-duplicates

1. 连续追问 3 次。
2. 确认不丢第二问，不出现 duplicate user/assistant。

### claude.archive-history-recover

1. Archive live Claude session。
2. 确认 zellij session/pane 被清理。
3. History 里可以打开该 session，不出现 archive 后空 pane 或残留遮盖。

### claude.permission-trust

1. 在新 workspace 触发 trust-folder 或权限提示。
2. 确认 TUI 内可以操作 prompt。
3. 确认 Web 不显示一个可点但无效的假权限按钮。

## OpenCode

CLI version:

```sh
opencode --version
```

### opencode.web-new-native-tui

1. 在 Web 新建 OpenCode session。
2. 打开 `Info`，确认 runtime 是 `native_local_server`。
3. 点击 `TUI`，确认 OpenCode attach 到同一 session。

### opencode.chat-input-and-mirror

1. 在 Chat 输入唯一 marker 问题。
2. 确认 OpenCode TUI 可见该问题。
3. 确认 Chat mirror 出现回答、reasoning/tool/usage。

### opencode.tui-input-and-replay

1. 在 TUI 直接输入问题。
2. 回到 Chat 确认同一轮出现。
3. 刷新页面确认 replay 存在。

### opencode.stop

1. 发起长任务。
2. 在 Chat 点 Stop。
3. 确认 abort 不退出 OpenCode session，状态回 idle。

### opencode.continuous-followup-no-duplicates

1. 连续发 3 个问题。
2. 确认都被回答，且没有重复气泡或碎片化气泡。

### opencode.archive-history-recover

1. Archive OpenCode live session。
2. 确认 server/session 不残留为 live。
3. History 里可读该 session。

### opencode.resume-model-interrupt

1. 从 History resume 一个 OpenCode session。
2. 选择一个明确 model。
3. 确认 TUI/Info/行为能证明 model 参数被启动路径接收。
4. 测 Ctrl-C 或 Stop 不退出 session。

### opencode.model-variant

1. 在 New session composer 选择 OpenCode model。
2. 如 UI 暴露 variant/reasoning，确认只在 capability 支持时可选。
3. 确认不会显示一个选择了但实际无效的假参数。

## iPad / Safari / PWA

### ipad-safari.keyboard-resize

1. 用 iPad Safari 打开 RAH。
2. 进入任意 live session 的 TUI。
3. 点击 terminal 和 input bridge，确认键盘弹出后仍可输入。

### ipad-safari.terminal-keyboard-anchor

1. 点击 terminal canvas。
2. 点击 input bridge。
3. 比较两种方式：terminal 应锚定在键盘上方，不应出现明显页面漂移。

### ipad-safari.terminal-typography-theme

1. 查看 Codex/Claude/OpenCode TUI。
2. 确认中文间距、行高、背景、颜色与 RAH Web UI 视觉一致。

### ipad-safari.rotation-split-pwa

1. 旋转 iPad。
2. 切换 PWA 后台再回来。
3. 尝试分屏/画布。
4. 确认 replay 和布局恢复正常。

## 通过标准

完成所有项目后：

```sh
npm run test:smoke:native-manual-qa-status
```

该命令必须通过，且没有 `pending`、`fail`、`blocked`。如果期间修改代码，必须重新生成模板或更新报告中的 commit/fingerprint。
