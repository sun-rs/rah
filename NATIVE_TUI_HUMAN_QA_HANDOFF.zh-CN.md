# Native TUI 人类 QA 交付说明

日期：2026-05-03

分支：`refactor/native-tui-backed-sessions`

## 当前状态

Native TUI backed sessions 已完成自动化 MVP 门槛，可以停止自动开发阶段并交给人类真实测试。

但这不等于最终封板。当前不能调用 goal complete，因为仍有真实账号、真实模型、真实移动设备才能验证的部分。

## 已由自动化覆盖

- 五家 provider 默认 native TUI 主链路：Codex、Claude、Gemini、Kimi、OpenCode。
- Web session / canvas pane 可显示真实 TUI，并支持 Chat / TUI 切换。
- Chat composer 可注入 daemon-owned native TUI。
- TUI prompt dirty 时 Chat composer 会阻止误注入。
- Stop 会走 native TUI interrupt 路径，并回到 idle。
- 页面 reload、online/focus 恢复、canvas 布局变化后 PTY replay 可追上。
- Codex / Claude / Gemini / Kimi / OpenCode fake native browser smoke 已覆盖主链路。
- WebKit 近似 Safari smoke 已覆盖移动端 input bridge、canvas focus、Stop、replay 和 foreground recovery。
- 真实 CLI help/version drift probe 已覆盖五家当前本机 CLI。
- 真实 TUI launch probe 已覆盖五家官方 TUI 能被 RAH PTY host 拉起和关闭，但不发送模型问题。

## 交付前刷新证据

```bash
npm run test:native-tui
npm run test:smoke:native-browser-webkit
RAH_NATIVE_REAL_TUI_PROBE_OUTPUT=test-results/native-real-tui-launch.json npm run test:smoke:native-real-tui-launch
RAH_NATIVE_QA_STATUS_OUTPUT=test-results/native-qa-status.json npm run test:smoke:native-qa-status
```

`test:smoke:native-qa-status` 只检查已保存的自动证据是否齐全。它不会证明真实模型回答或 iPad/Safari 真机行为。

## 人类 QA 结果校验

生成人工 QA 结果模板：

```bash
RAH_NATIVE_MANUAL_QA_TEMPLATE_OUTPUT=test-results/native-manual-qa.json npm run test:smoke:native-manual-qa-status -- --print-template
```

模板会为每个必测项写入 `id`、`title`、`provider`、`cliVersion`、`sessionId`、`providerSessionId`、`evidence` 等字段。人类测试时只需要把对应项从 `pending` 改成 `pass`，并补齐 tester、testedAt、cliVersion/provider 证据和简短 evidence。

人类测试完成并把每个必测项改为 `status: "pass"` 后，运行：

```bash
RAH_NATIVE_MANUAL_QA_STATUS_OUTPUT=test-results/native-manual-qa-status.json npm run test:smoke:native-manual-qa-status
```

该脚本会检查五家 provider 的通用真实用例、provider 专项用例和 iPad/Safari 用例是否都有 tester、testedAt 和 evidence；provider 项还必须填写 cliVersion。输出会包含按 codex / claude / gemini / kimi / opencode / ipad-safari 分组的 summary。它只验证人类填写的报告完整性，不自动证明真实行为。

2026-05-03 当前状态：已运行上述校验，结果为未通过。`test-results/native-manual-qa.json` 已存在，但所有必测项仍为 `pending`，因此最终封板条件尚未满足。

## 人类必须测试

- 五家 provider 的真实模型回答和长任务。
- 连续追问不能丢第二问，不能重复用户问题或重复 assistant 气泡。
- 回答中 Stop 必须能中断，不能长期停留在 running/stop 状态。
- Codex TUI 内 `/goal` 和官方权限菜单。
- Claude trust-folder、permission prompt 和 resume。
- Gemini Google login、额度/429 错误和 resume。
- Kimi long-running turn、`--thinking`、`--yolo`。
- OpenCode 真实 `opencode [project]`、`--session`、`--model` 和 Ctrl-C。
- iPad/Safari/PWA 输入法 composition、键盘弹出后 terminal resize、点击 terminal 任意区域与输入桥的一致性、terminal 中文间距/主题、旋转、后台切回和局域网 WebSocket replay。

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
