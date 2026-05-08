# RAH PTY-First Completion Audit

日期：2026-05-08

分支：`refactor/pty-first-core`

本文件用于把当前 PTY-first seamless workbench 目标、代码产物和验收证据逐项对齐。它不是完成声明；只要真实 CLI / 真机 QA 仍未通过，就不能标记 goal complete。

## 当前目标拆解

1. Live truth 只能是 daemon-owned real PTY/TUI session。
2. Web、PWA、desktop terminal、canvas 都只是 attach client。
3. 结构化 Chat/mirror 只来自 provider 原厂 jsonl/db/session history 文件，不从 ANSI/TUI screen scrape 反推。
4. Core live provider 收敛为 Codex、Claude、OpenCode。
5. Gemini/Kimi CLI 一等支持已移除；相关模型通过 OpenCode/API provider 承载。
6. `rah <provider>`、Web New、Canvas New 统一为 create PTY session + attach。
7. `rah <provider> resume <id>` 和 Web Claim History 统一为 resume launch spec + create PTY session + attach。
8. client detach / reload / background 不杀 TUI；close/archive/kill 必须显式。
9. Provider adapter 主责收敛为 launch spec、binding probe、mirror parser、minimal PTY control。
10. 模型/权限/effort/plan/slash command 降级为 optional enhancement。
11. Mirror missing/failed 只进 diagnostics，不能影响 TUI session。
12. 避免 structured live、native TUI、wrapper handoff 三套公开 live 系统并行。
13. 有可重复的自动化 gate，不能只靠手感。
14. 明确仍需要人类真实 CLI / 真机 QA 的范围。

## Prompt 到产物清单

| 要求 | 产物 / 文件 | 当前证据 | 状态 |
| --- | --- | --- | --- |
| 根目录 PTY-first 计划 | `RAH_PTY_FIRST_SEAMLESS_WORKBENCH_PLAN.zh-CN.md`、`desgin.md` | 两份文件均声明三家 core live、Gemini/Kimi CLI 已移除、PTY Session Runtime 主线 | 已落地 |
| 移除原因 | `docs/provider-scope-codex-claude-opencode.zh-CN.md` | 记录为什么收敛到 Codex + Claude + OpenCode，以及 OpenCode model/variant 边界 | 已落地 |
| 人类 QA 交付说明 | `NATIVE_TUI_HUMAN_QA_HANDOFF.zh-CN.md` | 记录自动覆盖、人工必测项、模板命令和失败记录格式 | 已落地 |
| Core live provider selector | `ProviderSelector.tsx` | New Session provider list 只展示 Codex、Claude、OpenCode | 已落地 |
| 协议 provider 边界 | `packages/runtime-protocol/src/session.ts` | `ProviderKind` 只包含 `codex`、`claude`、`opencode`、`custom` | 已落地 |
| CLI live provider 边界 | `bin/rah.mjs` | `rah codex/claude/opencode` 可 live；其他 provider cleanly unsupported | 已落地 |
| native TUI launch spec | `native-tui-launch-spec.ts` | 只包含 Codex、Claude、OpenCode start/resume spec | 已落地 |
| native provider runtime 边界 | `native-tui-provider-runtime.ts`、`native-tui-provider-handlers.ts` | runtime provider set 为 Codex、Claude、OpenCode；Gemini/Kimi native handlers 已删除 | 已落地 |
| provider diagnostics 边界 | `provider-diagnostics.ts` | Settings diagnostics 只探测 Codex、Claude、OpenCode | 已落地 |
| PTY runtime | `pty-session-runtime.ts`、`pty-hub.ts` | create/attach/detach/replay/resize/interrupt/close 由 runtime/tests 覆盖 | 已落地 |
| session lifecycle | `runtime-engine.ts`、`runtime-terminal-coordinator.ts` | Web/CLI start/resume 使用 native TUI PTY path；structured live public path 被拒绝 | 已落地 |
| attach/replay/browser recovery | `TerminalPane.tsx`、browser smoke scripts | Chromium/WebKit smoke 覆盖 replay、foreground recovery、canvas resize、mobile input bridge | 已落地 |
| mirror layer | `native-tui-mirror-runtime.ts`、stored history parsers | Codex rollout、Claude JSONL、OpenCode DB 是当前 structured source | 已落地 |
| mirror failure diagnostics | `native-tui-diagnostics.ts` | mirror missing/failed 被记录为 diagnostics，不关闭 TUI | 已落地 |
| duplicate/reconciliation | canonical identity、history snapshot tests | live/history echo、Codex double-write、OpenCode DB mirror 等有测试覆盖 | 已落地 |
| enhanced controls downgraded | session capability tests、docs | native TUI sessions expose `structuredControl: false`；model/mode controls 隐藏或拒绝 | 已落地 |
| old structured live archived | `legacy-structured/`、runtime/http tests | public HTTP rejects `liveBackend: "structured"`；public HTTP also returns 400 for unsupported live provider；normal daemon 不构造 legacy structured adapters；production live start/resume 会在 structured fallback 前拒绝非 core live provider | 已落地 |
| wrapper handoff public path removed | `bin/rah.mjs`、http-server tests | public `rah xxx` 不再进入 wrapper handoff；wrapper-control 默认关闭 | 已落地 |
| manual QA verifier | `scripts/native_manual_qa_status.ts` | 可生成并校验 `test-results/native-manual-qa.json` | 已落地工具，未人工闭环 |

## 最近自动验收证据

2026-05-08 最近一次已确认通过的自动项：

```bash
npm run typecheck
npm run test:web
npm run test:provider-contracts
npm run test:runtime
npm run build:web
npm run test:manual-qa-status
npm run test:smoke:native-codex-browser
npm run test:smoke:native-provider-browser
npm run test:smoke:native-browser-webkit
RAH_NATIVE_REAL_TUI_PROBE_OUTPUT=test-results/native-real-tui-launch.json npm run test:smoke:native-real-tui-launch
RAH_NATIVE_QA_STATUS_OUTPUT=test-results/native-qa-status.json npm run test:smoke:native-qa-status
RAH_NATIVE_MANUAL_QA_STATUS_OUTPUT=test-results/native-manual-qa-status.json npm run test:smoke:native-manual-qa-status
git diff --check
```

关键结果：

- `npm run test:web`：157 pass。
- `npm run test:provider-contracts`：109 pass。
- `npm run test:runtime`：339 pass / 0 skipped。
- `npm run build:web`：pass。
- `npm run test:manual-qa-status`：3 pass，覆盖完整人工 QA 报告可通过、provider pass 缺 session 证据会失败、iPad/Safari pass 缺 device/browser/url 会失败。
- CLI drift probe 当前记录：Codex `0.129.0`、Claude `2.1.133`、OpenCode `1.14.41`。
- `npm run test:smoke:native-codex-browser`：Chromium pass，覆盖 Codex native TUI、Chat/TUI toggle、mirror 去重、Stop、reload replay、foreground recovery、canvas resize、mobile input bridge。
- `npm run test:smoke:native-provider-browser`：Chromium pass，覆盖 Claude/OpenCode native TUI、Chat mirror、Stop、TUI input、reload replay、foreground recovery。
- `npm run test:smoke:native-browser-webkit`：WebKit pass，覆盖 Codex/Claude/OpenCode 的同类 browser smoke 路径。
- `npm run test:smoke:native-real-tui-launch`：pass。真实 Codex、Claude、OpenCode 官方 TUI 均能在 RAH PTY host 内启动、观察到 raw/visible output，并由 RAH 关闭；该 probe 不发送模型 prompt。
- `npm run test:smoke:native-qa-status`：pass。已保存的 CLI probe 与 real TUI launch probe 均覆盖当前 branch/commit/dirty 状态。
- `npm run test:smoke:native-manual-qa-status`：预期失败。脚本现在会阻止缺少 tester/testedAt/evidence 的 pass；provider 项还要求 cliVersion、workspace、sessionId，除 `*.web-new-native-tui` 外要求 providerSessionId；iPad/Safari 项要求 device、browser、url。
- `git diff --check`：pass。
- `GET /api/providers`：只返回 `codex`、`claude`、`opencode`。
- 非文档 runtime/client/scripts/package 引用扫描：无 Gemini/Kimi 残留。
- 43111 已用 `node bin/rah.mjs restart --no-build --no-open` 重新拉起，当前 daemon provider 边界为三家。

本轮修复后新增覆盖点：

- Claude 503 / account error 不再把 raw headers / JSON 刷进 Chat；Chat 只保留压缩后的错误摘要。
- OpenCode new session queued input 会等 TUI prompt ready 后再注入，避免首问丢失。
- Codex/Native TUI Stop 或 ESC 后会回到 `prompt_clean`，避免 Chat send 永久灰掉。
- Codex `/goal` 的 persisted developer payload 会映射为简洁的 `Goal active` 通知。
- iOS terminal surface tap 走 RAH input bridge focus，不再直接触发 xterm hidden textarea 的漂移路径。
- 窄屏 Hide / Archive / Close 使用 icon-only；phone portrait 禁用 canvas 入口，避免白屏。
- Native TUI session 不再暴露假的 plan/access controls；OpenCode 只承诺稳定 `--model provider/model`。
- Production live provider 边界继续收紧：非 Codex/Claude/OpenCode 的 live start/resume 会在 structured fallback 前直接拒绝，并在 public HTTP 层返回明确 400，避免 public live path 误入 legacy structured coordinator 或表现成内部 500。

当前未闭环的自动 gate：

- `npm run test:native-tui`：最近一次完整 pass 发生在 `test:manual-qa-status` 接入主 gate 之前。当前脚本已经包含 `typecheck`、`test:provider-contracts`、`test:web`、`test:runtime`、`build:web`、CLI drift probe、native fake smoke、Chromium browser smoke、WebKit browser smoke、`test:manual-qa-status` 和 `git diff --check`；接入后曾启动完整 gate，但为了交付 43111 人工测试中途停止。最终封板前必须重新跑完整 `npm run test:native-tui`。

人工 QA verifier 当前状态：

```bash
RAH_NATIVE_MANUAL_QA_TEMPLATE_OUTPUT=test-results/native-manual-qa.json npm run test:smoke:native-manual-qa-status -- --print-template
RAH_NATIVE_MANUAL_QA_STATUS_OUTPUT=test-results/native-manual-qa-status.json npm run test:smoke:native-manual-qa-status
```

结果：26 项 `pending`，无 Gemini/Kimi warning。

- Codex：7 项。
- Claude：7 项。
- OpenCode：8 项。
- iPad/Safari：4 项。

## 不应误判为完成的部分

下面这些不能被自动 smoke 完全证明，不能因为 gate 通过就视为最终封板：

- 真实模型长时间回答是否稳定。
- 真实账号登录态、额度耗尽、Claude trust-folder / permission prompt。
- Codex `/goal` 在真实 TUI 内的使用体验。
- OpenCode 真实 `opencode [project]`、`--session`、`--model`、Ctrl-C 中断。
- OpenCode 经 API provider 承载 Gemini/Kimi/Grok/DeepSeek 等模型的真实可用性。
- iPad / Safari 真机输入法 composition、terminal 键盘锚定、点击 terminal 任意区域与输入桥的一致性、terminal 中文间距/主题、旋转、PWA 后台恢复、真实拖拽 resize。

## 当前结论

代码层面已经完成 PTY-first seamless workbench 的三家 core live 主链路：

- Codex、Claude、OpenCode 有 native TUI launch / resume 主路径。
- Web、CLI、Canvas 入口复用 daemon-owned PTY session runtime。
- Web 能显示 TUI，并能从 provider 历史/DB mirror 出 Chat 视图。
- Chat composer 不再在 TUI prompt dirty 时盲注入。
- Stop、replay、browser recovery、canvas、mobile input bridge 都有自动测试覆盖。
- Gemini/Kimi CLI 代码已移除；新低频模型工作通过 OpenCode/API provider 承载。

但目标尚不能标记为最终完成，因为真实 CLI 长运行和真机 QA 仍未由人类完成。当前状态应定义为：

> PTY-first core 自动门槛已通过；进入真实 CLI / 真机 QA 阶段。

人类测试入口见根目录 `NATIVE_TUI_HUMAN_QA_HANDOFF.zh-CN.md`，完整步骤以 `docs/native-tui-real-cli-qa.zh-CN.md` 为准。
