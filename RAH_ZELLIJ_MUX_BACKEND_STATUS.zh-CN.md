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
| Stop uses provider-native key | zellij path sends `Esc` for Codex/Claude, double `Esc` for OpenCode | Tested with fake providers |
| `/exit` / pane exit syncs to RAH archive semantics | `pollZellijTuiExit()` removes live session and emits `session.closed` | Tested |
| Web archive closes zellij pane/session | `closeZellijTuiSession()` closes pane then kills session fallback | Tested |
| Recover persisted zellij live session after daemon restart | `restoreZellijTuiSession()` | Tested |
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
npm run test:runtime   # 365 pass
npm run test:web       # 160 pass
npm run build:web
git diff --check
```

Additional targeted evidence:

```bash
node --import tsx --test \
  packages/runtime-daemon/src/zellij-mux-backend.test.ts \
  packages/runtime-daemon/src/zellij-tui-runtime.test.ts \
  packages/runtime-daemon/src/http-server.test.ts
```

This targeted suite covers:

- fake shell zellij pane input/dump/subscribe/exit,
- Codex / Claude / OpenCode fake zellij runtime,
- archive closes zellij pane/session,
- unmanaged RAH zellij session close,
- persisted zellij recovery,
- non-RAH zellij close rejection.

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
