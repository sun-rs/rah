# RAH Native TUI Backed Sessions 完成审计

日期：2026-05-03

分支：`refactor/native-tui-backed-sessions`

本文件用于把用户目标、根计划、代码产物和验收证据逐项对齐。它不是替代
`NATIVE_TUI_BACKED_SESSIONS_PLAN.zh-CN.md` 的设计文档，而是用于判断“是否已经足够可靠可封板”的审计清单。

## 1. 目标拆解

原始目标可以拆成这些交付物：

1. 根目录存在完整 native TUI backed sessions 重构计划。
2. Web new session 默认可以启动官方 provider TUI，而不是只走旧 structured live adapter。
3. Web live session 可以显示真实 TUI，并能在 Chat / TUI 之间切换。
4. Chat 视图只是 mirror，官方 TUI 才是 live truth source。
5. 五家 provider：Codex、Claude、Gemini、Kimi、OpenCode 都有 native TUI 主链路。
6. Web Chat composer 可以把输入注入 daemon-owned native TUI，但不能在 TUI 中存在未提交本地草稿时误注入。
7. Stop 应转成 native TUI 的 Ctrl-C / interrupt，并能回到 idle。
8. 页面 reload、online/focus 恢复、canvas 分屏切换后，TUI replay 和 Chat mirror 应能追上。
9. 移动端 / iPad / Safari 方向需要 terminal 输入桥和基础验证。
10. 保留现有 structured 路线作为兼容/回退，不一次性删除旧路径。
11. 有可重复的自动化 gate，不能只靠手感。
12. 明确仍需要人工真实 CLI QA 的范围。

## 2. Prompt 到产物清单

| 要求 | 产物 / 文件 | 当前证据 | 状态 |
| --- | --- | --- | --- |
| 根目录完整开发计划 | `NATIVE_TUI_BACKED_SESSIONS_PLAN.zh-CN.md` | 文件位于 repo root，包含目标、阶段、风险、测试门槛、未完成闭环 | 已落地 |
| 真实 CLI QA 清单 | `docs/native-tui-real-cli-qa.zh-CN.md` | 包含五家 provider、OpenCode、iPad/Safari/PWA 的真实 QA 步骤和失败模板 | 已落地 |
| 人类 QA 交付说明 | `NATIVE_TUI_HUMAN_QA_HANDOFF.zh-CN.md` | 根目录交付文件明确当前可停止自动开发阶段、已由自动化覆盖的范围、必须人工测试的范围、刷新证据命令和失败记录格式 | 已落地 |
| native TUI 启动参数协议化 | `packages/runtime-daemon/src/native-tui-launch-spec.ts` | `native-tui-launch-spec.test.ts` 覆盖五家 start/resume spec | 已落地 |
| native TUI provider runtime 边界 | `packages/runtime-daemon/src/native-tui-provider-runtime.ts`、`native-tui-provider-runtime-types.ts`、`native-tui-provider-handlers.ts`、`native-tui-*-provider-handler.ts` | `native-tui-provider-runtime.test.ts` 锁定五家 native provider set、binding probe 能力、unbound mirror 行为；`RuntimeEngine` native start/resume 以及 `RuntimeTerminalCoordinator` binding / mirror 已通过该 contract；provider-specific handler 已从 runtime contract 和 registry 中拆出 | 已落地 |
| session event 发布边界 | `packages/runtime-daemon/src/runtime-session-events.ts` | `runtime-session-events.test.ts` 覆盖 created/started、attach、claim control、state changed 的统一发布；该测试已加入默认 `test:runtime` | 已落地 |
| terminal wrapper runtime 边界 | `packages/runtime-daemon/src/terminal-wrapper-session-runtime.ts` | `RuntimeTerminalCoordinator` 不再直接持有 wrapper registry / sender / preemptive interrupt / closing set；`runtime-engine.test.ts` 和 wrapper smoke 覆盖 `rah xxx` handoff 注册、输入、interrupt、rebind、close | 已落地 |
| Web new/claim 默认 native TUI | `packages/client-web/src/session-store-session-startup.ts` | `session-store-session-startup.test.ts` 覆盖 new session 和 claim history 默认 native TUI | 已落地 |
| 协议层声明 nativeTui/chatMirror | `packages/runtime-protocol/src/session.ts`、`packages/runtime-protocol/src/contract.ts` | `contract.test.ts` 覆盖 session capabilities 与 prompt state canonical values | 已落地 |
| 后端 native TUI session 生命周期 | `packages/runtime-daemon/src/runtime-terminal-coordinator.ts`、`runtime-engine.ts` | `runtime-engine.test.ts` 大量覆盖 launch、binding、mirror、stop、reload/replay、prompt dirty | 已落地 |
| 通用 prompt state | `packages/runtime-daemon/src/native-tui-prompt-state.ts` | `native-tui-prompt-state.test.ts` 独立覆盖 provider activity 推进 clean/busy、terminal draft dirty、提交和控制键清理；不再挂在 Codex bridge 测试里 | 已落地 |
| stale mirror guard | `packages/runtime-daemon/src/native-tui-mirror-guard.ts` | `native-tui-mirror-guard.test.ts` 独立覆盖旧 persisted mirror 不能把新注入 native TUI turn 标回 idle/clean；该测试已加入默认 `test:runtime` | 已落地 |
| terminal capability policy | `packages/runtime-daemon/src/runtime-terminal-capabilities.ts` | `runtime-terminal-capabilities.test.ts` 独立覆盖 native TUI terminal-first 能力、custom provider 无 structured mirror 降级、terminal wrapper provider permission 边界；该测试已加入默认 `test:runtime` | 已落地 |
| PTY replay 和 terminal WebSocket | `packages/runtime-daemon/src/pty-hub.ts`、`http-server-websocket.ts` | `pty-hub.test.ts`、browser smoke 覆盖 replay、resize、slow client | 已落地 |
| Web 真实 TUI 面板 | `packages/client-web/src/TerminalPane.tsx` | Browser smoke 覆盖 xterm 输出、输入、resize、reload replay、mobile bridge；mobile canvas 点击会聚焦 RAH 输入桥而不是 xterm hidden textarea | 已落地 |
| 移动端 terminal 视口重绘与主题 | `packages/client-web/src/terminal-viewport.ts`、`TerminalPane.tsx`、`styles.css`、`index.css` | `terminal-viewport.test.ts` 覆盖 visual viewport/键盘 inset/可见高度；WebKit/Chromium browser smoke 覆盖 mobile bridge 与 canvas focus；terminal theme 使用 RAH 语义 token | 已落地 |
| Chat/TUI 切换 | `WorkbenchSelectedPane.tsx`、`CanvasSessionPane.tsx` | Codex/provider browser smoke 覆盖 session 页面和 canvas pane | 已落地 |
| Chat composer 防误注入 | `composer-contract.ts`、`workbench-notice-contract.ts`、`runtime-terminal-coordinator.ts` | 前端 contract 测试 + 后端 Claude/Gemini prompt dirty regression + WebKit browser smoke | 已落地 |
| Stop -> Ctrl-C / idle | `runtime-terminal-coordinator.ts`、`TerminalPane.tsx` | Codex/provider browser smoke 覆盖五家 fake native Stop 和 runtimeState idle | 已落地 |
| Chat mirror 降级不杀 TUI | `native-tui-diagnostics.ts`、Settings diagnostics UI | 计划记录 `mirror_failed` 降级；runtime/browser smoke 覆盖 diagnostics 基础路径 | 已落地 |
| Codex rollout 双写去重 | `codex-rollout-activity.ts`、`codex-stored-session-history.ts`、`native_codex_browser_smoke.py` | 覆盖 `agent_message` + assistant `response_item` 双写、frozen history window 缺失 `task_started`、同 canonical history event 去重、browser Chat mirror 不重复 | 已落地 |
| 统一 history canonical 去重 | `history-snapshots.ts`、`history-snapshots.test.ts` | materialized history、frozen initial page、frozen older page 都按 `canonicalItemId` 去重 `timeline.item.added`，测试已加入 `test:runtime` | 已落地 |
| Browser smoke 进程清理 | `scripts/native_smoke_process.py`、`native_codex_browser_smoke.py`、`native_provider_browser_smoke.py` | smoke 成功/失败路径都会 best-effort close session，并终止 daemon 子进程树；2026-05-03 跑完 Codex/provider browser smoke 后确认无 fake provider/codex 残留进程 | 已落地 |
| 真实 CLI help drift 探测 | `scripts/native_cli_probe.ts` | `test:smoke:native-cli-probe` 采集五家版本，并要求 help flag 命中且 exit code 为 0 | 已落地 |
| 真实 CLI TUI 启动/关闭探测 | `scripts/native_real_tui_launch_probe.ts` | 可选 `test:smoke:native-real-tui-launch` 已在本机五家 provider 通过；报告含 RAH branch/commit/dirty 与 raw/visible output；不发送模型问题 | 已落地 |
| 自动证据完整性检查 | `scripts/native_qa_status.ts` | `test:smoke:native-qa-status` 读取 CLI probe 和真实 TUI launch probe JSON，检查五家 provider、报告 commit 与仍需人工 QA 清单；可用 `RAH_NATIVE_QA_STATUS_OUTPUT` 落盘 | 已落地 |
| 人类 QA 结果完整性检查 | `scripts/native_manual_qa_status.ts` | 可生成 `test-results/native-manual-qa.json` 模板，并校验五家通用真实用例、provider 专项用例、iPad/Safari 用例是否全部有 `pass`、tester、testedAt、evidence；provider 项还必须记录 cliVersion。它不替代真实测试 | 已落地工具，未人工闭环 |
| 内部探针 session 不污染用户列表 | `packages/runtime-daemon/src/runtime-session-list.ts` | `runtime-session-list.test.ts` 覆盖 `test-results/native-real-tui-workspaces` 不进入 Live / History / Recent / Workspaces | 已落地 |
| 总 gate | `scripts/native-tui-gate.sh`、`package.json` `test:native-tui` | 最近一次 `npm run test:native-tui` 通过，包含 typecheck、web/runtime、build、CLI probe、browser smoke、wrapper smoke、diff check | 已落地 |
| WebKit/Safari 近似自动 smoke | `package.json` `test:smoke:native-browser-webkit` | 最近一次 `npm run test:smoke:native-browser-webkit` 通过 | 已落地 |
| 真实账号/额度/权限弹窗 | `docs/native-tui-real-cli-qa.zh-CN.md` | 需要真实 provider 账号和人类操作，自动测试不能证明 | 未自动闭环 |
| iPad/Safari 真机输入、旋转、PWA 后台 | `docs/native-tui-real-cli-qa.zh-CN.md` | WebKit 只能近似，不能替代真机 | 未自动闭环 |

## 3. 最近自动验收证据

最近一次本机自动 gate：

```bash
npm run test:native-tui
```

已覆盖：

- `npm run typecheck`
- `npm run test:web`：148 pass
- `npm run test:runtime`：367 pass
- `npm run build:web`
- `npm run test:smoke:native-cli-probe`
- `npm run test:smoke:native-codex`
- `npm run test:smoke:native-providers`
- `npm run test:smoke:native-codex-browser`
- `npm run test:smoke:native-provider-browser`
- `npm run test:smoke:wrapper`
- `git diff --check`

额外通过：

```bash
npm run test:smoke:native-browser-webkit
RAH_NATIVE_REAL_TUI_PROBE_OUTPUT=test-results/native-real-tui-launch.json npm run test:smoke:native-real-tui-launch
```

`test-results/native-cli-probe.json` 当前记录的本机 provider 版本：

- Codex：`codex-cli 0.128.0`
- Claude：`2.1.123 (Claude Code)`
- Gemini：`0.40.0`
- Kimi：`kimi, version 1.40.0`
- OpenCode：`1.14.30`

此外，2026-05-03 本轮针对用户实测问题的增量验收已通过：

```bash
node --import tsx --test --test-force-exit packages/runtime-daemon/src/codex-rollout-activity.test.ts
npm run test:smoke:native-codex
npm run test:smoke:native-codex-browser
npm run typecheck
npm run test:runtime
npm run test:smoke:native-provider-browser
git diff --check
```

本轮新增覆盖：

- Codex `agent_message` + assistant `response_item` 双写不再导致第一个 assistant 重复显示。
- Codex Web 新建 native TUI session 使用隔离 `CODEX_HOME` wrapper home，只共享 auth/config，不共享 `sessions`；providerSessionId binding probe 只接受该 wrapper home 下的 rollout，避免同 cwd 的外部 Codex 对话被误绑定并把当前对话输出显示到新 session。
- 2026-05-03 针对“Web 新建 Codex session 显示当前 Codex 对话输出”的回归已加入默认 runtime suite：`native TUI backend ignores unrelated Codex rollout updates outside its isolated home`。该用例模拟同 cwd 的外部 Codex rollout 在新 session 启动后更新，并断言 Web 新建 native TUI session 不会绑定该外部 providerSessionId。
- Codex frozen history window 即使缺失 `task_started` 也能去重双写 assistant。
- Codex history response 会按 `canonicalItemId` 去重同一 timeline item。
- History snapshot store 现在统一按 `canonicalItemId` 去重 materialized/frozen history page 中的重复
  `timeline.item.added`。
- 移动端点击 terminal canvas 会聚焦 RAH 输入桥，browser smoke 断言不会落到 xterm hidden textarea。
- Kimi JSON-RPC client dispose 会在 SIGTERM 超时后升级 SIGKILL，避免测试和真实 shutdown 遗留子进程。
- Codex/provider browser smoke 的 cleanup 已补强：即使中途失败也会 close 已启动 session，并清理 daemon 子进程树；本轮验证结束后 `ps` 未发现 `/rah-native-*-browser-*/fake-*.js` 残留进程。
- 完整 `npm run test:native-tui` 二次通过：覆盖 typecheck、147 个 web 测试、364 个 runtime 测试、build、CLI probe、Codex/provider fake smoke、Codex/provider browser smoke、wrapper smoke 和 `git diff --check`。
- `npm run test:smoke:native-browser-webkit` 通过：WebKit 下 Codex mobile/touch TUI input bridge、canvas 点击聚焦输入桥、Claude/Gemini/Kimi/OpenCode Chat/TUI、Stop、replay 和 foreground recovery 均通过自动近似验证。
- Native TUI 主路径继续从旧 `ProviderAdapter` 肥接口脱离：`RuntimeEngine` 通过 `NativeTuiProviderRuntime` 获取 start/resume launch spec；`RuntimeTerminalCoordinator` 已把 provider-specific binding probe、TUI output observation 和 Chat mirror update 交给该 runtime；过程产物 `scripts/__pycache__/inspector_browser_smoke.cpython-313.pyc` 已删除。

2026-05-03 继续瘦身后增量验证：

```bash
node --import tsx --test --test-force-exit \
  packages/runtime-daemon/src/native-tui-provider-runtime.test.ts \
  packages/runtime-daemon/src/native-tui-launch-spec.test.ts \
  packages/runtime-daemon/src/runtime-engine.test.ts
npm run typecheck
npm run test:native-tui
```

结果：51 个 targeted runtime/native 测试通过，`npm run typecheck` 通过，完整 `npm run test:native-tui` 通过。该 gate 覆盖 147 个 web 测试、364 个 runtime 测试、build、真实 CLI help/version drift probe、Codex/provider fake smoke、Codex/provider browser smoke、wrapper smoke 和 `git diff --check`。跑完后 `ps` 未发现 native browser smoke fake provider/codex 残留进程。

随后继续拆分 provider runtime：

- `native-tui-provider-runtime.ts` 从 665 行降到 125 行，只保留 runtime contract、launch spec 分发、handler dispatch 和通用错误隔离。
- 新增 `native-tui-provider-runtime-types.ts`，集中共享类型。
- `native-tui-provider-handlers.ts` 继续缩为 21 行 registry。
- 新增五个 provider-specific handler 文件：Codex 157 行、Claude 56 行、Gemini 106 行、Kimi 76 行、OpenCode 127 行。
- Targeted runtime/native 测试再次通过：51 pass。
- 通用 terminal prompt state 已从 Codex bridge 中抽出到 `native-tui-prompt-state.ts`，`RuntimeTerminalCoordinator` 和 `rah codex` handoff 共享同一套 prompt clean/dirty/busy 判定，且测试已迁到 `native-tui-prompt-state.test.ts`，避免 native TUI 主路径继续依赖 Codex 命名模块。
- stale persisted mirror guard 已从 `RuntimeTerminalCoordinator` 私有函数抽出到 `native-tui-mirror-guard.ts`，并由独立测试锁定“旧 history mirror completion 不能覆盖新 Web 注入 turn 状态”的不变量。
- terminal capability policy 已从 `RuntimeTerminalCoordinator` 抽出到 `runtime-terminal-capabilities.ts`，并由独立测试锁定 native TUI / terminal wrapper 能力边界。
- native TUI runtime timing/env config 已从 `RuntimeTerminalCoordinator` 抽出到 `native-tui-runtime-config.ts`，并由独立测试锁定默认值、env override 和 legacy `parseInt` 行为。
- native TUI diagnostic 记录/告警/resolve helper 已集中到 `native-tui-diagnostics.ts`，coordinator 只保留调用点和一次性告警 flag；独立测试覆盖 binding missing、mirror missing、mirror failure 和 process exit 诊断。
- native TUI session state / queue / timer helper 已从 `RuntimeTerminalCoordinator` 抽出到 `native-tui-session-state.ts`，并由独立测试锁定 runtime session 投影、FIFO 队列、client interrupt cancel 和 timer cleanup。
- 完整 `npm run test:native-tui` 再次通过，覆盖 typecheck、147 个 web 测试、364 个 runtime 测试、build、真实 CLI help/version probe、native fake smoke、browser smoke、wrapper smoke 和 `git diff --check`。

随后继续拆分 terminal runtime：

- 新增 `runtime-session-events.ts`，集中 session created/started、attach、claim control、state changed 的系统事件发布，避免 coordinator 和 wrapper runtime 各自手写同一套事件负载。
- 新增 `terminal-wrapper-session-runtime.ts`，把 `rah codex/claude/gemini/kimi/opencode` terminal handoff 的 wrapper registry、sender、preemptive interrupt、provider binding、prompt state、close / exited 处理从 `RuntimeTerminalCoordinator` 移出。
- `RuntimeTerminalCoordinator` 从 1185 行进一步降到 806 行，当前主要保留 native TUI process / PTY / prompt queue / mirror lifecycle，旧 terminal wrapper 逻辑成为独立运行时。
- Browser smoke 焦点假设修正：Chat composer 提交改为对 textarea locator 直接 `press("Enter")`，避免 TUI/Chat 切换后全局键盘事件被错误焦点吞掉。
- Targeted 验证通过：`npm run typecheck`，以及 `runtime-session-events.test.ts`、`terminal-wrapper-*`、`runtime-engine.test.ts` 共 65 个测试。
- 完整 `npm run test:native-tui` 再次通过：typecheck、147 个 web 测试、364 个 runtime 测试、build、真实 CLI help/version probe、native fake smoke、browser smoke、wrapper smoke 和 `git diff --check` 均通过。

2026-05-03 移动端 terminal 视口与主题补充：

- 新增 `terminal-viewport.ts` / `terminal-viewport.test.ts`，用 `visualViewport.height + offsetTop` 推导键盘 inset 和 terminal 可见高度，避免 iOS 键盘弹出时依赖页面滚动顶起固定高度 terminal。
- `TerminalPane` 在 mobile/touch bridge 模式下会按可见高度设置 terminal panel，并 schedule xterm fit / PTY resize；点击 terminal canvas 聚焦 RAH 输入桥时不再主动滚动页面。
- 键盘活跃时 terminal panel 会按 `visualViewport` 固定到当前 pane 的可见矩形，输入桥贴到键盘上方；这只能近似 Blink iOS 的 native `keyboardLayoutGuide/inputAccessoryView` 行为，真机 iPad/Safari 仍需人工 QA。
- xterm theme 与移动端输入桥改用 RAH Web UI semantic tokens，light/dark 下背景、前景、光标和 selection 与主界面统一；terminal font family、letter spacing、line height 已向 Web UI 风格收敛，降低中文字符间距异常。
- WebKit smoke 曾暴露 composer 自动化焦点/受控 textarea 残留问题，smoke 已改成对具体 textarea 聚焦、清空、真实键入并提交；发送按钮补充 `aria-label`。
- 已通过 `npm run typecheck`、`npm run test:web`、`npm run build:web`、`npm run test:smoke:native-codex-browser`、`npm run test:smoke:native-provider-browser`、`npm run test:smoke:native-browser-webkit`、`git diff --check`。
- Chromium mobile smoke 暴露 xterm 窄屏软换行会把稳定 marker 拆成视觉行；browser smoke 文本匹配已改为同时检查原始文本和去换行文本，避免把 terminal resize 后的视觉软换行误判为输入/interrupt 丢失。
- 修复后完整 `npm run test:native-tui` 再次通过：typecheck、148 个 web 测试、364 个 runtime 测试、build、真实 CLI help/version probe、native fake smoke、Chromium browser smoke、wrapper smoke 和 `git diff --check` 均通过。
- 随后 `npm run test:smoke:native-browser-webkit` 再次通过，确认同一套 mobile input bridge / canvas focus / Chat/TUI / Stop / replay / foreground recovery 路径在 WebKit 近似环境仍然成立。
- browser smoke 增加 runtime preflight；本机 Firefox Playwright runtime 缺失时会在 daemon/session 启动前以 `phase: "browser_preflight"` 失败，不再先创建 native fake session。Chromium Codex/provider browser smoke 和 WebKit Codex/provider browser smoke 已在 preflight 改动后通过；`package.json` 也提供了 `test:smoke:native-browser-firefox` 作为可选入口。
- 2026-05-03 重新运行完整 `npm run test:native-tui` 通过：typecheck、148 个 web 测试、367 个 runtime 测试、build、真实 CLI help/version drift probe、Codex/provider fake smoke、Codex/provider Chromium browser smoke、wrapper smoke 和 `git diff --check` 均通过。跑完后已重启 `43111`，并确认无 native smoke fake provider 残留进程。
- 2026-05-03 随后重新运行 `npm run test:smoke:native-browser-webkit` 通过：WebKit 下 Codex mobile input bridge、canvas 点击聚焦输入桥，以及 Claude/Gemini/Kimi/OpenCode 的 Chat/TUI、Stop、replay 和 foreground recovery 均通过自动近似验证。
- 2026-05-03 随后重新运行 `RAH_NATIVE_REAL_TUI_PROBE_OUTPUT=test-results/native-real-tui-launch.json npm run test:smoke:native-real-tui-launch` 通过：五家真实官方 TUI 均能进入 RAH PTY host、3 秒内不退出并可关闭；该探针仍不发送 prompt，因此不证明真实模型回答。
- 2026-05-03 `RAH_NATIVE_QA_STATUS_OUTPUT=test-results/native-qa-status.json npm run test:smoke:native-qa-status` 通过：自动证据文件完整，且明确列出真实模型长运行、权限/登录/额度、Codex `/goal`、iPad/Safari 真机输入法和 PWA 恢复等人工 QA 缺口。
- 2026-05-03 `RAH_NATIVE_MANUAL_QA_STATUS_OUTPUT=test-results/native-manual-qa-status.json npm run test:smoke:native-manual-qa-status` 未通过：`test-results/native-manual-qa.json` 中五家 provider 通用真实用例、provider 专项用例和 iPad/Safari 用例均仍为 `pending`。该校验现在输出分组 summary；当前为 39 项 pending，其中五家 provider 各 7 项，iPad/Safari 4 项。这确认当前不能标记最终完成。

`test-results/native-real-tui-launch.json` 当前记录：五家真实 provider TUI 均能被 RAH native launch spec 启动、进入 PTY host、启动窗口内不退出，并可被关闭。报告包含 RAH branch / commit / dirty 状态和 raw/visible output 区分。该探针不发送 prompt，因此不能证明真实模型回答。

2026-05-03 重新运行：

```bash
RAH_NATIVE_REAL_TUI_PROBE_OUTPUT=test-results/native-real-tui-launch.json npm run test:smoke:native-real-tui-launch
```

结果为 `ok: true`。五家真实 TUI 均启动并关闭成功，且 `ps` 未发现 `test-results/native-real-tui-workspaces` 下的残留进程。该次输出还观察到 Claude 在新测试工作区显示官方 trust-folder safety prompt；这证明真实 TUI 能展示该交互，但是否确认、确认后长任务行为、权限弹窗行为仍属于人工 QA 范围。

2026-05-03 最新补充验证：

```bash
RAH_NATIVE_REAL_TUI_PROBE_OUTPUT=test-results/native-real-tui-launch.json npm run test:smoke:native-real-tui-launch
npm run test:smoke:native-browser-webkit
```

结果：真实 CLI 启动探针再次 `ok: true`，Codex / Claude / Gemini / Kimi / OpenCode 均能按当前 launch spec 进入 PTY host 并关闭；WebKit browser smoke 通过，覆盖 Codex 以及 Claude/Gemini/Kimi/OpenCode 的 Chat/TUI、Stop、replay、foreground recovery、mobile input bridge 近似路径。`ps` 未发现 native smoke fake provider 或 real TUI probe 残留进程。仍需注意：WebKit smoke 不是 iPad/Safari 真机输入法验证；真实 CLI probe 不发送模型 prompt。

2026-05-03 最新真实 TUI 启动探针：

```bash
RAH_NATIVE_REAL_TUI_PROBE_OUTPUT=test-results/native-real-tui-launch.json npm run test:smoke:native-real-tui-launch
```

结果：`ok: true`。Codex / Claude / Gemini / Kimi / OpenCode 均能进入 RAH PTY host、在 3 秒 settle 窗口内不退出，并可由 RAH PTY host 关闭。当前报告观察到：Claude 显示官方 trust-folder safety prompt，Kimi 显示 `Kimi-k2.6` welcome，OpenCode 显示 TUI 首页；Codex 只有 raw terminal output，Gemini 在窗口内暂无输出。这些都不视为失败，因为该探针只验证真实 launch/PTY/close，不发送 prompt。

## 4. 不应误判为完成的部分

下面这些不能被自动 smoke 完全证明，不能因为 gate 通过就视为最终封板：

- 真实模型长时间回答是否稳定。
- 真实账号登录态、额度耗尽、429、Google login、Claude trust-folder / permission prompt。
- Codex `/goal` 在真实 TUI 内的使用体验。
- OpenCode 真实 `opencode [project]`、`--session`、`--model`、Ctrl-C 中断。
- Kimi long-running turn。
- iPad / Safari 真机输入法 composition、terminal 键盘锚定、点击 terminal 任意区域与输入桥的一致性、terminal 中文间距/主题、旋转、PWA 后台恢复、真实拖拽 resize。

## 5. 当前结论

代码层面已经完成 native TUI backed sessions 的 MVP 主链路：

- 五家 provider 有 native TUI launch / resume 主路径。
- Web 能显示 TUI，并能从 provider 历史/DB mirror 出 Chat 视图。
- Chat composer 不再在 TUI prompt dirty 时盲注入。
- Stop、replay、browser recovery、canvas、mobile input bridge 都有自动测试覆盖。
- mobile terminal 视口计算、WebKit 近似路径和主题 token 已有自动测试/构建覆盖。

但目标尚不能标记为最终完成，因为真实 CLI 长运行和真机 QA 仍未由人类完成。当前状态应定义为：

> Native TUI MVP 自动门槛已通过；进入真实 CLI / 真机 QA 阶段。

人类测试入口见根目录 `NATIVE_TUI_HUMAN_QA_HANDOFF.zh-CN.md`，完整步骤仍以
`docs/native-tui-real-cli-qa.zh-CN.md` 为准。

最终标记 goal complete 前必须同时满足：

```bash
npm run test:native-tui
npm run test:smoke:native-browser-webkit
RAH_NATIVE_REAL_TUI_PROBE_OUTPUT=test-results/native-real-tui-launch.json npm run test:smoke:native-real-tui-launch
RAH_NATIVE_QA_STATUS_OUTPUT=test-results/native-qa-status.json npm run test:smoke:native-qa-status
RAH_NATIVE_MANUAL_QA_STATUS_OUTPUT=test-results/native-manual-qa-status.json npm run test:smoke:native-manual-qa-status
```

其中 `native-manual-qa-status` 必须基于人类真实测试后填写的 `test-results/native-manual-qa.json`，不能使用自动 fixture 或空模板替代。
