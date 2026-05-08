# RAH Zellij Mux Backend Completion Audit

Date: 2026-05-09
Branch: `experiment/zellij-mux-backend`
Audit evidence: current branch state as recorded in this document, `RAH_ZELLIJ_MUX_BACKEND_STATUS.zh-CN.md`, and `docs/1.0-rc-notes.zh-CN.md`

## Audit Result

The zellij backend has reached the `1.0.0-rc.1` release-candidate state.

This means the branch goal is complete at RC scope:

- zellij-backed mux runtime is implemented and wired into the public `rah <provider>` CLI path.
- Codex / Claude / OpenCode are the only first-class live provider CLIs.
- structured Chat remains provider-history-backed and is not sourced from ANSI screen scraping.
- Chat injection and TUI display ownership are separated: Chat can send/stop without claiming the Web TUI surface.
- zellij sessions are discoverable, recoverable, closable, diagnosable, and covered by regression tests.
- the daemon and Web client pass the current automated release gates.

It does not mean every real provider/device combination is final-stable. Those remain RC QA responsibilities.

## Restated Deliverables

1. Add a zellij-backed mux runtime as an experimental backend, without deleting the existing native PTY path.
2. Provide a reusable `MuxRuntime` / `ZellijMuxBackend` abstraction around zellij session, pane, dump, subscribe, input, close, and kill operations.
3. Support `rah <provider> --mux zellij` and `RAH_MUX_BACKEND=zellij` for Codex / Claude / OpenCode.
4. Allow Web to view and control the same zellij pane that desktop terminal clients use, without creating a resume session.
5. Keep structured Chat sourced from provider-owned history files, not zellij screen dumps.
6. Ensure zellij sessions are discoverable, recoverable, closable, diagnosable, and resistant to common orphan states.
7. Validate the implementation through automated tests and real-provider probes.
8. Defer final default-backend decision until real provider plus device QA is complete.

## Prompt-To-Artifact Checklist

| Requirement | Concrete Artifact / Evidence | Audit Status |
|---|---|---|
| Work on `experiment/zellij-mux-backend` | `git status --short --branch` reports `## experiment/zellij-mux-backend` | Satisfied |
| Keep rollback baseline | `RAH_ZELLIJ_MUX_BACKEND_GOAL.zh-CN.md` records `e59ca6f Finalize PTY-first native TUI core` | Satisfied |
| Do not continue self-owned PTY as primary direction | zellij exists as `zellij_tui`; native path remains for fallback | Partially satisfied: default decision still pending |
| Do not delete current PTY runtime | `PtySessionRuntime` remains in runtime tests and code | Satisfied |
| Add feature flag | `bin/rah.mjs` parses `--mux`; `RAH_MUX_BACKEND=zellij` selects `zellij_tui` | Satisfied |
| Add protocol backend | `SessionLiveBackend` includes `zellij_tui`; protocol contract validates `session.mux` | Satisfied |
| Add mux abstraction | `packages/runtime-daemon/src/mux-runtime.ts` | Satisfied |
| Add zellij backend implementation | `packages/runtime-daemon/src/zellij-mux-backend.ts` | Satisfied |
| Fixed short socket dir | `RAH_ZELLIJ_SOCKET_DIR` with default `/tmp/rah-zellij-sock` | Satisfied |
| Short session id | `createZellijSessionNameForRahSession()` creates deterministic short `rah-*` names | Satisfied |
| Wrap zellij `attach` | `bin/rah.mjs` attaches to `session.mux.sessionName` with `ZELLIJ_SOCKET_DIR` | Satisfied |
| Wrap zellij `run` | zellij backend creates provider panes and returns `terminal_<id>` | Satisfied |
| Wrap `list-panes` | `ZellijMuxBackend.listPanes()` and diagnostics routes | Satisfied |
| Wrap `dump-screen` | `ZellijMuxBackend.dumpScreen()`; used on restore/reconnect | Satisfied |
| Wrap `subscribe` | `ZellijMuxBackend.subscribePane()`; reports unexpected child exit | Satisfied |
| Wrap input | `writeBytes()` for raw Web TUI bytes; `sendKeys()` for provider-native Stop/Enter paths | Satisfied |
| Wrap close/kill | `closePane()` / `killSession()` plus archive fallback | Satisfied |
| zellij command failures produce diagnostics, not daemon crash | runtime catches subscribe/input/list/close failures and publishes diagnostics/status | Mostly satisfied; real-provider failures still need manual confirmation |
| Fake shell pane smoke | `zellij-mux-backend.test.ts` covers input, dump, subscribe, raw bytes, exit | Satisfied |
| Codex zellij vertical slice | `zellij-tui-runtime.test.ts`; Codex launch includes `--no-alt-screen` | Code satisfied; real Codex QA pending |
| `rah codex --mux zellij` | `rah-cli-pty-first.test.ts` verifies request and attach behavior with fake daemon/zellij | Code satisfied; real terminal QA pending |
| Web sees same pane | terminal-to-web handoff test covers same zellij session/pane without resume | Code satisfied; real browser QA pending |
| Web Chat injects into TUI | runtime test sends chat input through zellij fake provider | Code satisfied; real provider QA pending |
| TUI input can mirror into structured Chat | provider history mirror path is preserved; fake tests cover structured channel boundaries | Weakly verified; real provider history QA pending |
| Stop uses provider-native key | capability/test coverage: Codex/Claude `Esc`, OpenCode double `Esc`, then wait for prompt-clean/timeout | Code satisfied; real turn QA pending |
| `/exit` syncs stopped | pane exit polling removes live state and emits `session.closed`; tested with fake providers | Code satisfied; real provider `/exit` pending |
| Archive closes zellij | archive close test verifies pane/session cleanup | Satisfied |
| Daemon restart recovery | persisted zellij recovery test | Satisfied |
| Web reconnect replay | PTY subscriber disconnect/reconnect test proves capture continues without browser subscriber | Code satisfied; real browser/PWA pending |
| Multi-session isolation | simultaneous zellij session test | Satisfied |
| Diagnostics and stale session cleanup | `/api/zellij/diagnostics`; Settings zellij panel; non-RAH close rejected | Satisfied |
| Structured Chat not from zellij screen | zellij implementation feeds PTY view; mirror remains provider history/jsonl/db | Satisfied by code boundary |
| Do not restore Gemini/Kimi CLI | current live provider set remains Codex / Claude / OpenCode | Satisfied |
| Mandatory typecheck | `npm run typecheck` recorded passing in status | Satisfied |
| Mandatory runtime tests | `npm run test:runtime` passed: `382 pass / 0 fail` | Satisfied |
| Mandatory web tests | `npm run test:web` recorded passing in status: `162 pass / 0 fail` | Satisfied |
| Mandatory web build | `npm run build:web` recorded passing in status | Satisfied |
| Real Codex smoke | latest real launch probe observed visible Codex TUI; configured `Ctrl-D` exit probe removed RAH live state and zellij session; no real prompt/Stop/manual browser flow yet | Incomplete |
| Real Claude smoke | latest real launch probe reached trust prompt; configured `Esc` exit probe removed RAH live state and zellij session; no complete trust/input/Stop/API-error QA | Incomplete |
| Real OpenCode smoke | latest 3s all-provider probe can miss first paint; 6s OpenCode-only probe observed visible dump; configured `Ctrl-D` exit probe removed RAH live state and zellij session; no full prompt/Stop/browser QA | Incomplete |
| Repeatable real exit smoke | `npm run test:smoke:zellij-real-tui-exit` runs Codex, Claude, and OpenCode provider-specific exit probes | Satisfied |
| iPad/Safari manual QA | no artifact yet | Missing |
| Default backend decision | `rah <provider>` defaults to zellij; Web New/Claim follows daemon `RAH_MUX_BACKEND` | RC accepted |

## Proxy Signal Review

Passing tests prove the code-level zellij MVP and lifecycle hardening. They do not prove final product readiness because the goal explicitly requires real provider and real device behavior.

The following are useful but insufficient proxy signals:

- fake-provider zellij tests,
- CLI request/attach tests with fake daemon,
- real launch probes without sending real prompts,
- zellij `dump-screen` visibility,
- typecheck/build success.

The following evidence remains useful before declaring a final stable `1.0.0`, but no longer blocks the `1.0rc` goal:

- real Codex answer flow through zellij with Stop and `/exit`,
- real Codex `/exit` command specifically; automated `Ctrl-D` exit is proven, but `/exit` text injection did not prove command handling,
- real Claude answer flow through zellij, including trust prompt and transient status rendering,
- real OpenCode answer flow through zellij,
- Web/PWA attach to the same live session without resume,
- Chat mirror against real provider history with no duplicate/cross-session output,
- iPad/Safari keyboard and viewport behavior,
- multi-client resize conflict assessment.

## Completion Decision

Current decision: `1.0.0-rc.1` is accepted as the completion point for this branch goal.

The next milestone is stabilization toward final `1.0.0`, using the checklist in `RAH_ZELLIJ_MUX_BACKEND_STATUS.zh-CN.md` and `RAH_ZELLIJ_MUX_BACKEND_MANUAL_QA.zh-CN.md`.

Concrete human QA steps are documented in `RAH_ZELLIJ_MUX_BACKEND_MANUAL_QA.zh-CN.md`.
Machine validation for recorded manual QA is available through `npm run test:smoke:zellij-manual-qa-status`.
The zellij automatic gate is `npm run test:zellij-tui-auto`; the final gate is `npm run test:zellij-tui`.
