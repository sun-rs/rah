# PTY-First Progress Audit

日期：2026-05-08

分支：`refactor/pty-first-core`

本文是当前实现审计，不是完成声明。最终完成仍需要真实 CLI / 真机 QA。

> 维护说明：本文记录 `refactor/pty-first-core` 阶段的历史审计。当前 `1.0.0-rc.1`
> 以 `experiment/zellij-mux-backend` 为准，最新状态见
> [`RAH 1.0 RC 说明`](./1.0-rc-notes.zh-CN.md) 和
> [`RAH_ZELLIJ_MUX_BACKEND_STATUS.zh-CN.md`](../RAH_ZELLIJ_MUX_BACKEND_STATUS.zh-CN.md)。

## Objective Restatement

RAH 收敛到一个 live core：

- daemon owns the real provider PTY/TUI process。
- Web、PWA、desktop terminal、canvas 都只是 attach clients。
- Structured Chat 来自 provider-native history files/DBs，不从 ANSI screen scraping 反推。
- `rah <provider>`、Web New、Canvas New、`rah <provider> resume <id>`、Web Claim History 复用 PTY runtime 和 launch/resume specs。
- detach、reload、background 不杀 live TUI；close/archive/kill 必须显式。
- Provider adapter 收敛为 launch spec、binding probe、mirror parser、minimal PTY control。
- Model、permission、effort、plan、slash-command 是 optional enhancements。
- Core live provider 当前为 Codex、Claude、OpenCode。
- Gemini/Kimi CLI 一等支持已删除；相关模型通过 OpenCode/API provider 承载。

## Artifact Checklist

| Requirement | Current artifact / evidence | Status |
| --- | --- | --- |
| Phase 0 boundary audit | `docs/pty-first-phase0-audit.zh-CN.md`; `RAH_PTY_FIRST_SEAMLESS_WORKBENCH_PLAN.zh-CN.md` | Done, historical audit partially superseded by three-provider reduction |
| Provider scope reduction | `packages/runtime-protocol/src/session.ts`, `bin/rah.mjs`, `ProviderSelector.tsx`, `provider-diagnostics.ts` | Done |
| Gemini/Kimi CLI removal | runtime/client/scripts grep has no non-doc Gemini/Kimi refs; deleted provider files and smoke scripts | Done |
| PTY runtime extraction | `packages/runtime-daemon/src/pty-session-runtime.ts`; `pty-session-runtime.test.ts` | Done |
| `rah <provider>` uses daemon PTY | `bin/rah.mjs`; `rah-cli-pty-first.test.ts` | Done |
| `rah <provider> resume <id>` uses daemon PTY | `bin/rah.mjs`; `rah-cli-pty-first.test.ts` | Done |
| Terminal detach does not close live PTY | `bin/rah.mjs` best-effort `/detach`; `rah-cli-pty-first.test.ts` | Done |
| Web detach does not close native TUI | `runtime-engine.test.ts` native TUI detach/listing tests | Done |
| Native TUI launch specs only cover core live providers | `native-tui-launch-spec.ts` and tests cover Codex、Claude、OpenCode | Done |
| Read-only history stays read-only | `preferStoredReplay` tests in startup/runtime/workbench state | Done |
| Mirror layer separated from coordinator | `native-tui-mirror-runtime.ts`; `NativeTuiMirrorProvider` seam | Done |
| Mirror failure does not affect TUI | native TUI diagnostics tests and runtime mirror failure tests | Covered |
| Structured source is provider history/DB | Codex rollout、Claude JSONL、OpenCode DB parser/mirror tests | Covered for current core providers |
| Workbench shell only view/attach | startup/canvas/workbench tests cover replay vs claim and pane-local selection | Covered |
| Canvas pane semantics | `canvas-state.ts` and `canvas-state.test.ts` | Covered |
| Mobile terminal input bridge | `terminal-mobile-bridge.ts`, `terminal-viewport.ts`, tests | Covered by tests; real iPad QA still required |
| Enhanced controls downgraded | native TUI capabilities expose `structuredControl: false`; session capability tests hide RAH-managed controls | Covered |
| Legacy structured path no longer public default | HTTP rejects `liveBackend: "structured"`; default adapters no longer construct legacy structured live | Done |
| Wrapper-control not public live path | normal daemon keeps wrapper-control closed; `test:smoke:wrapper` uses dedicated test daemon | Done |
| OpenCode model/variant boundary | native TUI launch spec passes `--model provider/model`; ACP setSessionModel test passes `provider/model/variant` | Done |

## Verification Run

Latest verified gates after Gemini/Kimi CLI removal and the 2026-05-08 PTY-first QA fixes:

- `npm run typecheck`: pass
- `npm run test:web`: 157 pass
- `npm run test:provider-contracts`: 109 pass
- `npm run test:runtime`: 339 pass / 0 skipped
- `npm run build:web`: pass
- `npm run test:native-tui`: last full pass was before `test:manual-qa-status` was added; the gate now includes provider contracts, WebKit browser smoke, and the manual QA verifier regression test, so final seal requires one fresh full run
- `npm run test:manual-qa-status`: 3 pass
- CLI drift probe in `test:native-tui`: Codex `0.129.0`, Claude `2.1.133`, OpenCode `1.14.41`
- `npm run test:smoke:native-codex-browser`: Chromium pass for Codex native TUI, Chat/TUI, mirror dedupe, Stop, replay, canvas, mobile input bridge
- `npm run test:smoke:native-provider-browser`: Chromium pass for Claude/OpenCode native TUI, Chat mirror, Stop, TUI input, replay, foreground recovery
- `npm run test:smoke:native-browser-webkit`: WebKit pass for Codex/Claude/OpenCode native browser paths
- `npm run test:smoke:native-real-tui-launch`: pass for real Codex、Claude、OpenCode TUI startup inside RAH PTY host; no model prompt is sent
- `npm run test:smoke:native-qa-status`: pass for current saved CLI probe and real TUI launch evidence
- `npm run test:smoke:native-manual-qa-status`: expected fail with 26 pending; pass results now require concrete provider session/device evidence
- `npm run test:smoke:wrapper`: pass for the isolated legacy wrapper-control harness
- `git diff --check`: pass
- `GET /api/providers`: returns only `codex`, `claude`, `opencode`
- non-doc grep over runtime/client/scripts/package/bin: no Gemini/Kimi refs

## Remaining Gaps

- Real Codex account / `/goal` / long-running turn QA.
- Real Claude trust-folder / permission prompt / long-running turn QA.
- Real OpenCode `opencode [project]`、`--session`、`--model provider/model`、Ctrl-C QA.
- OpenCode as API-key aggregator for Gemini/Kimi/Grok/DeepSeek-style models must be tested by humans with configured providers.
- iPad/Safari/PWA keyboard, terminal resize, input bridge, background replay, and typography QA.

## Current Conclusion

The PTY-first core implementation was materially in place for Codex、Claude、OpenCode at this historical checkpoint. Current completion status is superseded by the zellij `1.0.0-rc.1` documents linked at the top of this file.
