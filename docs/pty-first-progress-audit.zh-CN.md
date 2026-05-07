# PTY-First Progress Audit

Date: 2026-05-07

Branch: `refactor/pty-first-core`

Purpose: map the active PTY-first goal to concrete artifacts, tests, and remaining gaps. This file is an implementation audit, not a completion claim.

## Objective Restatement

RAH should converge on one live core:

- The daemon owns the real provider PTY/TUI process.
- Web, PWA, desktop terminal, and canvas are attach clients for the same PTY session.
- Structured Chat is a mirror of provider-native history files/DBs, not ANSI screen scraping.
- `rah <provider>`, Web New, Canvas New, `rah <provider> resume <id>`, and Web Claim History use the same PTY runtime and launch/resume specs.
- Detach, reload, and backgrounding do not kill the live TUI; close/archive/kill must be explicit.
- Provider adapters shrink toward launch spec, binding probe, mirror parser, and minimal PTY control.
- Model, permission, effort, plan, and slash-command support are optional enhancements.

## Artifact Checklist

| Requirement | Current artifact / evidence | Status |
| --- | --- | --- |
| Phase 0 boundary audit | `docs/pty-first-phase0-audit.zh-CN.md`; `RAH_PTY_FIRST_SEAMLESS_WORKBENCH_PLAN.zh-CN.md` | Done |
| PTY runtime extraction | `packages/runtime-daemon/src/pty-session-runtime.ts`; `pty-session-runtime.test.ts` | Done |
| `rah <provider>` uses daemon PTY by default | `bin/rah.mjs`; `rah-cli-pty-first.test.ts`; `RAH_LEGACY_WRAPPER=1` is legacy escape hatch | Done |
| Terminal detach does not close live PTY | `bin/rah.mjs` best-effort `/detach`; `rah-cli-pty-first.test.ts` | Done |
| Clientless native TUI survives list/prune | `RuntimeEngine.pruneOrphanSessions()` skips native TUI sessions; `runtime-engine.test.ts` | Done |
| Web detach does not close native TUI | `native TUI backend survives web detach and clientless session listing` test | Done |
| Daemon default live start/resume is PTY-first | `RuntimeEngine.shouldUseNativeTuiBackend()` defaults five providers to `native_tui`; `default live start uses native TUI...` test | Done |
| Read-only history stays read-only | `preferStoredReplay` bypasses native TUI default; `session-store-session-startup.test.ts`; `workbench-state.test.ts` | Done |
| Mirror layer separated from coordinator | `native-tui-mirror-runtime.ts`; `RuntimeTerminalCoordinator` delegates mirror polling/application | Done |
| Mirror failure does not affect TUI | native TUI diagnostics tests and runtime mirror failure tests | Covered by tests |
| Structured source is provider history/DB | native provider handlers and stored-session parsers remain the mirror source | Partially done |
| Workbench shell only view/attach | Web startup defaults native TUI; history browsing remains replay-only | Partially audited |
| Enhanced controls downgraded | native TUI capabilities expose `structuredControl: false`; docs mark controls optional | Partially done |
| Legacy structured path no longer default | Web, CLI, and default daemon RuntimeEngine prefer native TUI | Done |

## Verification Run

Latest verified gates in this branch:

- `npm run typecheck`: pass
- `npm run test:web`: 148 pass
- `npm run test:provider-contracts`: 133 pass
- `npm run test:runtime`: 370 pass

`test:runtime` now uses `--test-concurrency=1` because runtime tests mutate process-wide provider binary env vars such as `RAH_CODEX_BINARY`; parallel test files can otherwise contaminate each other and create false failures.

## Remaining Gaps

These are still not completion-grade:

- `npm run test:native-tui` has not been run for this exact HEAD in this audit cycle.
- Browser smoke and WebKit/mobile smoke are not rerun in this audit.
- Real five-provider CLI/account human QA is still required; fake native TUI tests do not prove real login/quota/provider behavior.
- Legacy structured live clients and adapters still exist. They are no longer default, but the adapter interface is not fully slimmed down to launch/bind/mirror/minimal control.
- Legacy wrapper runtime still exists for `RAH_LEGACY_WRAPPER=1` and synthetic tests. It is isolated as a fallback, not deleted.
- Workbench shell/canvas still needs deeper audit to prove every session selection path is attach/view-only and never accidentally closes or resumes a live session.
- Enhanced controls are documented as optional, but some UI affordances may still need pruning so native TUI sessions consistently present external-locked semantics.

## Current Conclusion

The PTY-first core is materially implemented for the main live entry paths, and default tests are green. The goal is not complete yet because real native TUI browser/mobile smoke, human provider QA, remaining shell/canvas audit, and adapter-interface slimming are still incomplete.
