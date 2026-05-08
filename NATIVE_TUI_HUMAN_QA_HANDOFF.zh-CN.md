# PTY-First Human QA Handoff

日期：2026-05-08

分支：`refactor/pty-first-core`

## 当前状态

RAH 已从旧的 native TUI backed sessions MVP 收敛为 PTY-first seamless workbench：

- Core live provider：Codex、Claude、OpenCode。
- Gemini/Kimi CLI 一等支持已移除；新 Gemini/Kimi/Grok/DeepSeek/GLM/MiniMax 等低频模型工作优先通过 OpenCode/API provider 配置承载。

自动 gate 已覆盖 core live 的 PTY runtime、launch/resume spec、Web/Canvas attach、Chat/TUI toggle、browser replay、foreground recovery、Stop、resize、prompt-dirty 防误注入和 mirror diagnostics。

这不等于最终封板。真实账号、真实模型长任务、真实权限弹窗、真实 iPad/Safari 输入法仍需人类测试。

最近一轮针对人工测试暴露的问题已做自动化回归：Claude API error 压缩显示、OpenCode 首问注入、Stop/ESC 后 Chat composer 解锁、Codex `/goal` 通知、iOS terminal tap input bridge、窄屏 icon-only actions、phone portrait canvas 禁用、native TUI 假 plan/access controls 隐藏或降级。

## 已由自动化覆盖

- Codex、Claude、OpenCode 默认通过 daemon-owned PTY host 启动官方 TUI。
- `rah <provider>`、Web New、Canvas New 进入同一类 PTY session runtime。
- `rah <provider> resume <id>` 与 Web Claim History 走 resume launch spec + PTY session runtime。
- Web session / canvas pane 可显示真实 TUI，并支持 Chat / TUI 切换。
- Chat composer 可注入 daemon-owned native TUI。
- TUI prompt dirty 时 Chat composer 会阻止误注入。
- Stop 走 native TUI interrupt / Ctrl-C 路径，并回到 idle。
- 页面 reload、online/focus 恢复、canvas 布局变化后 PTY replay 可追上。
- Codex Chromium browser smoke 覆盖 Chat mirror 去重、settings replay stats、canvas resize、mobile input bridge。
- Claude/OpenCode Chromium browser smoke 覆盖 Chat/TUI、composer input、Stop、TUI input、replay、foreground recovery。
- Codex WebKit browser smoke 覆盖 Chat/TUI、Stop、replay、canvas、mobile input bridge、terminal tap focus。
- Claude/OpenCode WebKit browser smoke 覆盖 Chat/TUI、composer input、Stop、TUI input、replay、foreground recovery。
- Headless WebKit smoke 覆盖 Safari-like 自动路径，但不能替代真机 iPad/Safari。
- 真实 CLI help/version drift probe 已覆盖 Codex、Claude、OpenCode。
- 真实 TUI launch probe 已覆盖 Codex、Claude、OpenCode 能被 RAH PTY host 拉起和关闭，但不发送模型问题。
- `test:smoke:native-qa-status` 当前通过，说明已保存的 CLI probe 和真实 TUI launch probe 覆盖当前 branch/commit/dirty 状态。

## 交付前刷新证据

```bash
npm run typecheck
npm run test:web
npm run test:provider-contracts
npm run test:runtime
npm run build:web
npm run test:native-tui
npm run test:manual-qa-status
npm run test:smoke:native-codex-browser
npm run test:smoke:native-provider-browser
npm run test:smoke:native-browser-webkit
RAH_NATIVE_CLI_PROBE_OUTPUT=test-results/native-cli-probe.json npm run test:smoke:native-cli-probe
RAH_NATIVE_REAL_TUI_PROBE_OUTPUT=test-results/native-real-tui-launch.json npm run test:smoke:native-real-tui-launch
RAH_NATIVE_QA_STATUS_OUTPUT=test-results/native-qa-status.json npm run test:smoke:native-qa-status
git diff --check
```

`test:smoke:native-qa-status` 只检查已保存的自动证据是否齐全。它不会证明真实模型回答或 iPad/Safari 真机行为。

`test:native-tui` 是当前 PTY-first 主 gate，已经包含 provider contracts、Chromium browser smoke、WebKit browser smoke 和 `test:manual-qa-status`；单独列出的 smoke 命令用于局部复测和定位。

## 人类 QA 结果校验

生成人工 QA 结果模板：

```bash
RAH_NATIVE_MANUAL_QA_TEMPLATE_OUTPUT=test-results/native-manual-qa.json npm run test:smoke:native-manual-qa-status -- --print-template
```

模板会为每个必测项写入 `id`、`title`、`provider`、`device`、`browser`、`url`、`workspace`、`cliVersion`、`sessionId`、`providerSessionId`、`evidence` 等字段。人类测试时需要把对应项从 `pending` 改成 `pass`，并补齐对应证据。

人类测试完成并把每个必测项改为 `status: "pass"` 后，运行：

```bash
RAH_NATIVE_MANUAL_QA_STATUS_OUTPUT=test-results/native-manual-qa-status.json npm run test:smoke:native-manual-qa-status
```

该脚本会检查 Codex、Claude、OpenCode 的真实 live 用例、OpenCode 专项用例和 iPad/Safari 用例是否都有 tester、testedAt 和 evidence。Provider 项还必须填写 cliVersion、workspace、sessionId；除 `*.web-new-native-tui` 外，还必须填写 providerSessionId。iPad/Safari 项必须填写 device、browser、url。它只验证人类填写的报告完整性，不自动证明真实行为。

当前状态：`npm run test:smoke:native-manual-qa-status` 未通过。`test-results/native-manual-qa.json` 中 26 项仍为 `pending`：

- Codex：7 项。
- Claude：7 项。
- OpenCode：8 项。
- iPad/Safari：4 项。

## 当前人工测试入口

43111 已按当前 checkout 重启，可直接进行人工 QA：

```bash
node bin/rah.mjs status
curl -fsS http://127.0.0.1:43111/api/providers | jq '{count:(.providers|length), providers:[.providers[].provider]}'
```

最近确认状态：

- Daemon：running at `http://127.0.0.1:43111`
- Managed pid：`93888`
- Providers：`codex`、`claude`、`opencode`
- Web build：`packages/client-web/dist/index.html`
- 没有残留的 `npm run test:native-tui` / `native-tui-gate` 测试进程。

## 人类必须测试

`test-results/native-manual-qa.json` 当前要求 26 个必填项。测试时应按这些 id 回填 `status: "pass"`、tester、testedAt 和 evidence；provider 项补 cliVersion、workspace、sessionId/providerSessionId；iPad/Safari 项补 device、browser、url。

Codex：

- `codex.web-new-native-tui`：Web new 启动真实 Codex TUI。
- `codex.chat-input-and-mirror`：Chat 输入进入 TUI，mirror 最终显示该轮。
- `codex.tui-input-and-replay`：直接在 TUI 输入，刷新后 replay 保留输出。
- `codex.stop`：真实 turn 中 Stop 能中断并回到 idle。
- `codex.continuous-followup-no-duplicates`：连续追问不丢、不重复。
- `codex.archive-history-recover`：Archive/close 和 history recovery 不留下孤儿 live state。
- `codex.goal`：Codex `/goal` 能在官方 TUI 内正常使用。

Claude：

- `claude.web-new-native-tui`：Web new 启动真实 Claude Code TUI。
- `claude.chat-input-and-mirror`：Chat 输入进入 TUI，JSONL mirror 最终显示该轮。
- `claude.tui-input-and-replay`：直接在 TUI 输入，刷新后 replay 保留输出。
- `claude.stop`：真实 turn 中 Stop 能中断并回到 idle。
- `claude.continuous-followup-no-duplicates`：连续追问不丢、不重复。
- `claude.archive-history-recover`：Archive/close 和 history recovery 不留下孤儿 live state。
- `claude.permission-trust`：trust-folder 与 permission prompt 能在 TUI 内操作，Web 不误注入。

OpenCode：

- `opencode.web-new-native-tui`：Web new 启动真实 OpenCode TUI。
- `opencode.chat-input-and-mirror`：Chat 输入进入 TUI，DB mirror 最终显示该轮。
- `opencode.tui-input-and-replay`：直接在 TUI 输入，刷新后 replay 保留输出。
- `opencode.stop`：真实 turn 中 Stop / Ctrl-C 能中断并回到 idle。
- `opencode.continuous-followup-no-duplicates`：连续追问不丢、不重复。
- `opencode.archive-history-recover`：Archive/close 和 history recovery 不留下孤儿 live state。
- `opencode.resume-model-interrupt`：真实 `opencode [project]`、`--session`、`--model` 和 Ctrl-C 稳定。
- `opencode.model-variant`：OpenCode 模型选择和 model variant / reasoning option 传递行为符合当前边界。PTY TUI 只保证稳定 `--model provider/model`；variant/reasoning 需要按 OpenCode 原生能力或 ACP/structured enhancement 证据填写。

iPad/Safari：

- `ipad-safari.keyboard-resize`：输入法 composition 和 terminal resize 可用。
- `ipad-safari.terminal-keyboard-anchor`：点击 terminal 或输入桥时，terminal 锚定在键盘上方且不漂移。
- `ipad-safari.terminal-typography-theme`：中文间距、行高、主题色与 RAH Web UI 视觉一致。
- `ipad-safari.rotation-split-pwa`：旋转、分屏、PWA 后台、局域网 WebSocket replay 可用。

完整步骤见 `docs/native-tui-real-cli-qa.zh-CN.md`。

## 失败记录格式

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

## 判断标准

可以交给人类测试：是。

可以标记最终完成：否。只有真实 QA 覆盖上述人工项、`npm run test:smoke:native-manual-qa-status` 基于人类填写的报告通过、且没有阻塞问题后，才能更新 `NATIVE_TUI_COMPLETION_AUDIT.zh-CN.md` 并标记目标完成。
