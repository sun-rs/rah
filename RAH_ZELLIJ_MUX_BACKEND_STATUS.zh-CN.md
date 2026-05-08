# RAH Zellij Mux Backend Status

Date: 2026-05-08
Branch: `experiment/zellij-mux-backend`
Rollback baseline: `e59ca6f Finalize PTY-first native TUI core`

## Current Judgment

Zellij backend is implemented as an experimental mux runtime path, but it is not ready to become the default RAH live TUI backend.

The code-backed MVP is in place:

- `MuxRuntime` / `ZellijMuxBackend` abstraction exists.
- `rah <provider> --mux zellij` and `RAH_MUX_BACKEND=zellij` request `liveBackend: "zellij_tui"`.
- Runtime can create, subscribe, write to, interrupt, recover, close, and diagnose zellij sessions.
- Codex / Claude / OpenCode are covered by fake-provider zellij integration tests.
- Structured Chat remains backed by provider history files, not zellij screen scraping.

The final product decision is still blocked by real provider and device QA:

- Real Codex / Claude / OpenCode zellij TUI smoothness.
- Real Stop semantics.
- Real `/exit` behavior.
- Real browser/PWA attach behavior.
- iPad/iPhone keyboard, viewport, and resize behavior.

## Evidence Checklist

| Requirement | Evidence | Status |
|---|---|---|
| Current branch is `experiment/zellij-mux-backend` | `git status --short --branch` | Done |
| Keep rollback baseline | Goal file records `e59ca6f`; no destructive rewrite | Done |
| Do not remove self-owned PTY path yet | `PtySessionRuntime` still exists; zellij is parallel `zellij_tui` backend | Done |
| Add zellij feature flag | `bin/rah.mjs` supports `--mux zellij` / `RAH_MUX_BACKEND=zellij` | Done |
| Add zellij protocol backend | `SessionLiveBackend` includes `zellij_tui`; contract validates `session.mux` | Done |
| Add mux abstraction | `packages/runtime-daemon/src/mux-runtime.ts` | Done |
| Add zellij backend | `packages/runtime-daemon/src/zellij-mux-backend.ts` | Done |
| Fixed short socket dir | Default `/tmp/rah-zellij-sock`; `RAH_ZELLIJ_SOCKET_DIR` override | Done |
| Short collision-resistant session names | `createZellijSessionNameForRahSession()` uses `rah-<8>-<24hex>` | Done |
| list/dump/write/send/exit fake pane coverage | `zellij-mux-backend.test.ts` | Done |
| Codex zellij launch path | `startZellijTuiSession()` plus Codex `--no-alt-screen` | Implemented |
| `rah codex --mux zellij` CLI request | `rah-cli-pty-first.test.ts` | Tested with fake daemon |
| Local terminal zellij attach | `rah-cli-pty-first.test.ts` verifies zellij attach command/env | Tested with fake zellij |
| Web chat input to zellij pane | `zellij-tui-runtime.test.ts` sends input through engine | Tested with fake providers |
| Web TUI raw input passthrough | zellij path uses `action write` bytes, not partial key parsing | Tested with fake pane |
| Web Chat input waits on dirty prompt | zellij Chat input is queued while the local TUI prompt has an unsubmitted draft | Tested |
| Terminal-to-Web handoff without resume | terminal-created zellij session can be web-attached, claimed, and controlled as the same session | Tested with fake provider |
| Stop uses provider-native key | zellij path sends `Esc` for Codex/Claude, double `Esc` for OpenCode, then waits for prompt-clean/timeout before idle | Tested with fake providers |
| `/exit` / pane exit syncs to RAH archive semantics | `pollZellijTuiExit()` removes live session and emits `session.closed` | Tested |
| Web archive closes zellij pane/session | `closeZellijTuiSession()` closes pane then kills session fallback | Tested |
| Recover persisted zellij live session after daemon restart | `restoreZellijTuiSession()` | Tested |
| zellij subscribe failure is not silent | `subscribePane()` reports unexpected exits; runtime schedules subscription reconnect | Tested at mux layer |
| Browser/WebSocket reconnect replay | daemon keeps capturing zellij pane output with no PTY subscribers and replays from cursor on reconnect | Tested with fake provider |
| Multi-session isolation | one zellij session per RAH session; test covers two simultaneous sessions | Tested |
| Diagnostics | `/api/zellij/diagnostics`; Settings displays managed/unmanaged sessions | Done |
| Unmanaged stale zellij sessions are closable | `/api/zellij/sessions/:name/close`; Settings close actions | Tested |
| Reject non-RAH zellij close requests | only `rah-*` session names are accepted | Tested |
| Structured Chat source remains provider history | zellij code only feeds TUI/PTY view; native mirror still uses provider history readers | Done |
| Do not restore Gemini/Kimi CLI | current live provider set remains Codex / Claude / OpenCode | Done |

## Latest Verification

These commands passed after the latest zellij lifecycle and diagnostics changes:

```bash
npm run typecheck
npm run test:runtime   # 370 pass
npm run test:web       # 160 pass
npm run build:web
git diff --check
```

Additional targeted evidence:

```bash
node --import tsx --test \
  packages/runtime-daemon/src/zellij-mux-backend.test.ts \
  packages/runtime-daemon/src/zellij-tui-runtime.test.ts
```

This targeted suite covers:

- fake shell zellij pane input/dump/subscribe/exit,
- raw terminal byte passthrough, including `ESC [ A` and UTF-8 text,
- Codex / Claude / OpenCode fake zellij runtime,
- dirty-prompt queueing before Web Chat injection,
- terminal-to-web handoff into the same zellij-backed session without resume,
- unexpected zellij subscribe process exit reporting,
- PTY subscriber disconnect/reconnect replay while zellij pane keeps running,
- archive closes zellij pane/session,
- unmanaged RAH zellij session close,
- persisted zellij recovery,
- non-RAH zellij close rejection.

Latest targeted result:

```bash
node --import tsx --test --test-concurrency=1 --test-force-exit \
  packages/runtime-daemon/src/zellij-mux-backend.test.ts \
  packages/runtime-daemon/src/zellij-tui-runtime.test.ts

# 16 pass
```

Optional real-provider launch probe:

```bash
RAH_ZELLIJ_REAL_TUI_PROBE_ALLOW_FAILURES=1 npm run test:smoke:zellij-real-tui-launch
```

This probe launches real Codex / Claude / OpenCode CLIs through the `zellij_tui` backend, observes zellij diagnostics and `dump-screen`, then closes the RAH session. It does not send a model prompt and does not replace human Stop, `/exit`, browser, or iPad/PWA QA.

Latest observed probe result:

- Codex launched through zellij with `--no-alt-screen` and produced visible TUI output.
- Claude launched through zellij and stopped at the official workspace trust prompt in a new test directory. This is expected provider UI, but it means Web Chat input must not be treated as proven until a human confirms the trust prompt flow.
- OpenCode launched through zellij and exposed a managed pane that could be diagnosed and closed. A short 1.5s probe can miss its first paint, but a 6s OpenCode-only probe produced visible `dump-screen` and PTY output.
- All three probe sessions were closed through RAH and were gone from the probe socket after close.

## Edge Case Audit

Code-covered edges:

1. One RAH session maps to one deterministic short `rah-*` zellij session, reducing cross-session collision risk.
2. Multiple simultaneous Codex / Claude / OpenCode fake sessions are isolated in separate zellij sessions.
3. WebSocket PTY input is authorized by daemon-side control lease; the URL session id is authoritative.
4. Web TUI input is byte-level passthrough through `zellij action write`, so arrow keys, control sequences, and UTF-8 text are not manually reinterpreted by RAH.
5. A session created by a terminal client can be attached and controlled by a web client without creating a new session or resume session.
6. Web Chat input does not inject into a dirty TUI prompt; it queues until prompt clean, with a max queue length.
7. Stop does not immediately mark the session idle; it publishes `stopping` and clears only after prompt-clean observation or timeout.
8. `/exit`, provider pane exit, missing zellij session, and archive all clear RAH live state and remove the PTY hub state.
9. Archive attempts close-pane first and then kill-session fallback, preventing common orphan zellij sessions.
10. Daemon restart can recover persisted zellij live sessions only when socket dir and pane still match.
11. zellij subscribe child exit/error is reported instead of silently leaving Web TUI stale; runtime schedules a bounded reconnect.
12. Web PTY clients can disconnect while daemon continues capturing zellij pane output; reconnect can replay missed chunks from a cursor.
13. Workbench state atomic writes use a UUID temp path to avoid concurrent daemon/test write collisions.

Still not code-proven:

1. Real Codex / Claude / OpenCode stop semantics during a live model turn.
2. Real provider trust-folder/login/quota/API-error UI flows.
3. zellij multi-client resize behavior, because zellij 0.44.2 does not expose an absolute cols/rows resize API for a target pane.
4. iPad/Safari keyboard and IME viewport stability.
5. Long-running sessions with high-frequency TUI redraws and large scrollback.
6. Whether real OpenCode produces readable subscribe/dump output fast enough for every startup state; a 6s probe is good, but the short probe can still miss first paint.

## Remaining Human QA

These remain unverified and block marking the goal complete:

1. `rah codex --mux zellij` with real Codex TUI: terminal smoothness, colors, scrollback, `--no-alt-screen`, Stop, `/exit`.
2. `rah claude --mux zellij` with real Claude Code: colors, transient status lines such as thinking/levitating, Stop, `/exit`, API error rendering.
3. `rah opencode --mux zellij` with real OpenCode: verify it stays as smooth as current native TUI.
4. Web/PWA can attach to the same zellij-backed session and operate it without resume.
5. Web Chat input and TUI input both mirror into structured Chat without duplicate or cross-session content.
6. Browser reconnect keeps zellij pane state stable.
7. Desktop terminal detach/reattach does not corrupt input mode.
8. iPad/Safari keyboard, Chinese IME, viewport resize, and terminal scroll behavior.
9. iPhone unsupported canvas/split/TUI interactions remain blocked or degrade safely.
10. Multi-client attach does not create unexpected resize conflicts.

## Operational Notes

- Existing stale sessions under `/tmp/rah-zellij-sock` may still exist from earlier failed experiments.
- They are visible in Settings under `Zellij mux sessions`.
- Only unmanaged `rah-*` sessions can be closed from diagnostics.
- Managed live zellij sessions should still be closed through normal session Archive so RAH can update live state and recent history consistently.

## Completion Rule

Do not mark this goal complete until the human QA items above are executed on real Codex / Claude / OpenCode and iPad/PWA, and the results show zellij is stable enough to compare against the current native PTY path.
