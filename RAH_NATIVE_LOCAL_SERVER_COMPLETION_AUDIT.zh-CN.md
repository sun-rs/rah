# RAH Native Local Server 完成审计

Date: 2026-05-09

Branch: `refactor/native-local-server-core`

Commit: `3764bbb`

Worktree: dirty, `test-results/native-manual-qa.json` 已记录当前 `worktreeFingerprint`

## 审计结论

当前分支已经完成 provider runtime 重构的主要代码路径和自动化验证，但不能标记 goal 完成。原因是目标明确要求真实 provider、真实浏览器/PWA/iOS/iPad、archive/exit/Stop/连续追问等人工验收；当前 `test-results/native-manual-qa.json` 仍有 26 项 `pending`。

更准确状态：

- Codex `native_local_server` 主链路已落地，并且采用确定性绑定：RAH 先创建 thread，再让 `codex --remote <endpoint> resume <threadId>` attach，不依赖 rollout/首条消息反推。
- OpenCode `native_local_server` 主链路已落地，并且 attach 绑定精确 provider session。
- Claude 保留 `zellij_tui` / `tui_mux_fallback`，没有假装成 native local server。
- Runtime capability、diagnostics、Session Info、prelaunch config、canonical timeline、Council 最小复用基础都已有自动化覆盖。
- 手动 QA 仍是封板前硬门槛。

## 需求到证据清单

| 要求 | 当前证据 | 状态 |
|---|---|---|
| Codex 改为 `native_local_server` | `bin/rah.mjs` 默认 Codex liveBackend 为 `native_local_server`；`packages/runtime-daemon/src/session-runtime-descriptor.ts` 声明 Codex runtime；`rah-cli-pty-first.test.ts` 覆盖 `codex --remote ... resume <threadId>` | 已实现 |
| Codex Web chat 走官方 app-server 事件/控制 | `packages/runtime-daemon/src/codex-app-server-client.ts`、`codex-live-rpc.ts`、`codex-app-server-activity.test.ts`、`codex-live-client.test.ts` | 已实现 |
| Codex TUI 作为官方 client/view 接入同一 thread | `scripts/native_local_server_probe.ts` 的 Codex remote TUI probe 已通过；CLI 测试断言 attach 命令 | 已自动验证 |
| Codex 不依赖第一句话/rollout 绑定 native local server thread | `RAH_NATIVE_LOCAL_SERVER_REFACTOR_PLAN.zh-CN.md` 已记录确定性绑定规则；`rah-cli-pty-first.test.ts` 断言 session summary 的 `providerSessionId` 被传给 remote TUI | 已实现 |
| OpenCode 改为 `native_local_server` | `bin/rah.mjs` 默认 OpenCode liveBackend；`opencode-live-client.test.ts`、`runtime-engine.test.ts` | 已实现 |
| OpenCode Web chat 走 server/API | `legacy-structured/opencode-live-client.ts` 当前承载 native local server client；`opencode-activity.test.ts`、`opencode-live-client.test.ts` | 已实现 |
| OpenCode TUI attach 精确绑定 session | `bin/rah.mjs` 对 OpenCode 使用 `opencode attach <endpoint> --session <providerSessionId>`；`rah-cli-pty-first.test.ts` 覆盖 | 已实现 |
| Claude 保留 zellij/TUI fallback | `session-runtime-descriptor.ts` 对 Claude catalog 返回 `tui_mux_fallback`；`zellij-tui-runtime.test.ts`、`zellij_real_tui_launch_probe.ts` | 已实现 |
| 不采用 Claude `--sdk-url` 默认路径 | 计划文档和 goal 文档明确禁止；当前默认 adapter/runtime 没有 `--sdk-url` 主链路 | 已满足 |
| zellij 长期 fallback | 计划文档、runtime descriptor、zellij tests 覆盖；Claude fallback 使用 zellij | 已实现 |
| 模型/权限/参数启动前配置 | `session-store-session-startup.test.ts` 覆盖 new/resume 发送 `mode/model/optionValues`；catalog adapters 只保留 Codex/Claude/OpenCode | 已实现 |
| 运行中配置只在 capability 支持时开放 | `session-capabilities.test.ts`、`composer-contract.test.ts`、`runtime-session-lifecycle.ts` gate | 已实现 |
| capability/runtimeKind/protocolStability 协议化 | `packages/runtime-protocol/src/session.ts`、`contract.ts`、`contract.test.ts`、`session-runtime-descriptor.ts` | 已实现 |
| UI 不展示假能力 | `SessionInfoDialog.tsx` 显示 runtime diagnostics；`session-capabilities.ts/test.ts` gate live controls | 已自动验证 |
| Timeline canonical merge | `provider-activity.test.ts`、`types.test.ts`、`history-snapshots.test.ts`、Codex/OpenCode/Claude parser tests | 已自动验证 |
| Gemini/Kimi 不恢复一等 provider | `rg -n "gemini|kimi" packages/runtime-protocol/src packages/runtime-daemon/src packages/client-web/src bin/rah.mjs package.json` 无结果；default adapters 只含 Codex/Claude/OpenCode | 已满足 |
| Council 最小 runtime/UI 复用 | `council-store.test.ts`、`council-runtime.test.ts`、`council-mcp-shim.test.ts`、`council-ui-state.test.ts` | MVP 已实现，但非完整产品 |

## 已通过命令

最近一次在当前分支/当前 dirty worktree 上通过：

```sh
git diff --check
npm run typecheck
npm run test:web
npm run test:provider-contracts
npm run test:runtime
npm run build:web
npm run test:manual-qa-status
npm run test:smoke:native-provider-browser
RAH_NATIVE_BROWSER=webkit npm run test:smoke:native-provider-browser
RAH_NATIVE_BROWSER=firefox npm run test:smoke:native-codex-browser
RAH_NATIVE_BROWSER=firefox npm run test:smoke:native-provider-browser
```

此前已通过并记录在计划文档中的真实 provider smoke：

```sh
npm run test:smoke:native-local-server
RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=codex RAH_NATIVE_LOCAL_SERVER_PROBE_CODEX_REMOTE_TUI=1 npm run test:smoke:native-local-server
RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=codex RAH_NATIVE_LOCAL_SERVER_PROBE_REAL_TURN=1 RAH_NATIVE_LOCAL_SERVER_PROBE_INTERRUPT=1 npm run test:smoke:native-local-server
RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=opencode RAH_NATIVE_LOCAL_SERVER_PROBE_OPENCODE_CROSS_CLIENT=1 npm run test:smoke:native-local-server
RAH_NATIVE_LOCAL_SERVER_PROBE_PROVIDERS=opencode RAH_NATIVE_LOCAL_SERVER_PROBE_REAL_TURN=1 RAH_NATIVE_LOCAL_SERVER_PROBE_INTERRUPT=1 npm run test:smoke:native-local-server
RAH_ZELLIJ_REAL_TUI_PROBE_PROVIDERS=claude npm run test:smoke:zellij-real-tui-launch
RAH_ZELLIJ_REAL_TUI_PROBE_PROVIDERS=claude RAH_ZELLIJ_REAL_TUI_PROBE_EXIT=1 RAH_ZELLIJ_REAL_TUI_PROBE_EXIT_INPUT=$'/exit\r' npm run test:smoke:zellij-real-tui-launch
npm run test:smoke:native-codex-browser
RAH_NATIVE_BROWSER=webkit npm run test:smoke:native-codex-browser
```

说明：Firefox 的 Codex browser smoke 覆盖桌面 Chat/TUI/Canvas/Stop/replay/foreground recovery。移动端 input bridge 子用例只在 Chromium/WebKit 跑，因为 Playwright Firefox 不支持 `Browser.newContext({ isMobile: true })`。

## 未完成项

这些项不是代码里完全没做，而是当前证据不足以封板：

- `test-results/native-manual-qa.json` 中 26 项仍为 `pending`。
- iPad/Safari/PWA 真机键盘、输入法、terminal anchor、旋转、分屏、后台恢复需要人工测试。
- Codex/OpenCode/Claude 真实账号下长 turn、Stop、连续追问、archive/history recover 需要人工确认。
- Claude 权限/trust-folder、Codex `/goal`、OpenCode model/variant 需要人工确认。
- Codex archive lifecycle 在 runtime descriptor 中仍是 `unverified`，不能宣称完全完成。
- Council 是最小可用基础，不是完整 agent-council 产品化融合。

## 封板条件

只有当下面条件都满足，才可以调用 goal complete：

1. 当前 worktree 已提交或 QA 报告记录的 `worktreeFingerprint` 与当前状态一致。
2. `npm run test:smoke:native-manual-qa-status` 通过，26 项人工 QA 不再 pending。
3. Codex/OpenCode/Claude 三家真实 session 的 Stop、连续追问、history reload、archive/exit 都有 session id、provider session id、CLI version 和设备/browser 证据。
4. iOS/PWA 相关四项有真机证据。
5. 若期间发生任何代码改动，重新跑基础 gate 并重新生成 QA 模板或更新 QA 报告。
