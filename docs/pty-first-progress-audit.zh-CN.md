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
| Native TUI core separated from legacy adapter live path | `native-tui-provider-runtime.test.ts` forbids core imports from `provider-adapter` and `runtime-structured-provider-coordinator` | Covered by tests |
| `rah <provider>` uses daemon PTY by default | `bin/rah.mjs`; `rah-cli-pty-first.test.ts`; `RAH_LEGACY_WRAPPER=1` is legacy escape hatch | Done |
| Terminal detach does not close live PTY | `bin/rah.mjs` best-effort `/detach`; `rah-cli-pty-first.test.ts` | Done |
| Clientless native TUI survives list/prune | `RuntimeEngine.pruneOrphanSessions()` skips native TUI sessions; `runtime-engine.test.ts` | Done |
| Web detach does not close native TUI | `native TUI backend survives web detach and clientless session listing` test | Done |
| Daemon default live start/resume is PTY-first | `RuntimeEngine.shouldUseNativeTuiBackend()` defaults five providers to `native_tui`; `default live start uses native TUI...` test | Done |
| Read-only history stays read-only | `preferStoredReplay` bypasses native TUI default; `session-store-session-startup.test.ts`; `workbench-state.test.ts` | Done |
| Mirror layer separated from coordinator | `native-tui-mirror-runtime.ts`; `RuntimeTerminalCoordinator` delegates mirror polling/application | Done |
| Mirror failure does not affect TUI | native TUI diagnostics tests and runtime mirror failure tests | Covered by tests |
| Structured source is provider history/DB | native provider handlers and stored-session parsers remain the mirror source | Partially done |
| Workbench shell only view/attach | Web startup defaults native TUI; history browsing remains replay-only; `activateHistorySessionCommand` tests lock replay/attach instead of implicit claim | Partially audited |
| Canvas pane view/attach semantics | `canvas-state.ts` centralizes pane target rules; `canvas-state.test.ts` locks live-session uniqueness and allows read-only history replay in multiple panes | Covered by tests |
| Enhanced controls downgraded | native TUI capabilities expose `structuredControl: false`; `runtime-engine.test.ts` rejects mode/model changes for native TUI while preserving idle PTY input; `session-capabilities.test.ts` hides RAH-managed controls when structured control is unavailable | Covered by tests |
| Legacy structured path no longer default | Web, CLI, and default daemon RuntimeEngine prefer native TUI | Done |
| Legacy structured path named as legacy/enhancement | `RuntimeStructuredProviderCoordinator` owns explicit `liveBackend: "structured"` start/resume, diagnostics, debug, and catalog fallbacks | Done |
| Legacy structured session ownership named explicitly | `RuntimeEngine` tracks adapter-owned sessions as `structuredSessionOwners`; `RuntimeSessionLifecycle` calls `requireStructuredSessionAdapter` only after terminal/native paths are bypassed | Done |
| Legacy structured adapter slices named explicitly | `ProviderStructuredLifecycleAdapter`, `ProviderStructuredInputControlAdapter`, `ProviderStructuredPermissionAdapter`, and `ProviderStructuredContextAdapter` mark non-core structured live capability slices | Done |
| Enhanced adapter slices named explicitly | `ProviderEnhancedModeAdapter` and `ProviderEnhancedModelAdapter` mark model/mode controls as optional enhancements, not PTY-first core requirements | Done |
| Stored history discovery depends only on history slice | `RuntimeEngine.historyMirrorAdapters` and `runtime-session-list.ts` use `ProviderStoredHistoryAdapter` instead of the full `ProviderAdapter` interface | Done |
| Built-in workspace inspection bypasses provider adapters | `ProviderAdapter` no longer extends `ProviderWorkspaceInspectionAdapter`; `RuntimeEngine` routes workspace snapshot/file/git read/apply actions through shared workspace utilities for non-`custom` sessions; duplicate workspace/file/git methods were removed from the five built-in provider adapters; `custom` debug sessions keep the structured adapter fallback | Done |

## Verification Run

Latest verified gates in this branch:

- `npm run typecheck`: pass
- `npm run test:web`: 156 pass
- `npm run test:provider-contracts`: 133 pass
- `npm run test:runtime`: 371 pass
- `npm run test:native-tui`: pass on 2026-05-07

`test:runtime` now uses `--test-concurrency=1` because runtime tests mutate process-wide provider binary env vars such as `RAH_CODEX_BINARY`; parallel test files can otherwise contaminate each other and create false failures.

`test:native-tui` covered the full PTY-first automatic gate for this checkout: typecheck, web tests, runtime tests, web build, real CLI help/version probe, Codex native smoke, Claude/Gemini/Kimi/OpenCode native provider smoke, Chromium browser native Codex smoke, Chromium browser native provider smoke, wrapper-control smoke, and `git diff --check`. The CLI probe captured the current local versions: Codex `0.128.0`, Claude Code `2.1.123`, Gemini `0.40.0`, Kimi `1.40.0`, and OpenCode `1.14.39`. The report records the worktree as dirty only because the user-owned `desgin.md` is untracked.

Additional Phase 6 guard verified on 2026-05-07:

- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/runtime-engine.test.ts`: 45 pass
- `npm run typecheck`: pass

This guard verifies that native TUI sessions reject RAH-managed mode/model hot switching, remain `idle`, and still accept subsequent PTY input.

Frontend external-locked guard verified on 2026-05-07:

- `node --import tsx --test --test-force-exit packages/client-web/src/session-capabilities.test.ts packages/client-web/src/composer-contract.test.ts`: 13 pass

This guard verifies that native TUI sessions do not expose RAH-managed mode/model controls even if stale mutable mode/model metadata is present.

Structured legacy naming guard verified on 2026-05-07:

- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts`: 51 pass

This guard verifies that native TUI core does not import the structured coordinator, that `RuntimeEngine` names structured provider coordination as a non-core path, and that provider adapter structured live slices keep explicit `Structured` names.

Workspace inspection boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `npm run test:runtime`: 371 pass
- `git diff --check`: pass

This guard verifies that built-in provider sessions no longer require provider adapters for generic workspace snapshot, file read, git diff/status, or git apply actions. `ProviderWorkspaceInspectionAdapter` is no longer part of the built-in `ProviderAdapter` requirement, the duplicate implementations have been deleted from Codex/Claude/Gemini/Kimi/OpenCode adapters, and the slice remains only as the legacy/debug `custom` structured fallback until the adapter interface is fully slimmed.

## Remaining Gaps

These are still not completion-grade:

- WebKit/mobile browser smoke is not rerun in this audit. Chromium native browser smoke is covered by `npm run test:native-tui`, but iPad/Safari real input-method behavior still needs human verification.
- Real five-provider CLI/account human QA is still required; fake native TUI tests do not prove real login/quota/provider behavior.
- Legacy structured live clients and adapters still exist. They are no longer default, and generic workspace inspection has moved out of the built-in provider adapter path and required interface, but the adapter interface is not fully slimmed down to launch/bind/mirror/minimal control.
- Legacy wrapper runtime still exists for `RAH_LEGACY_WRAPPER=1` and synthetic tests. It is isolated as a fallback, not deleted.
- Workbench shell/canvas still needs deeper audit for every UI path, although stored-history activation now has explicit replay/attach tests and the native browser smoke covers canvas PTY rendering/replay/resize.
- Enhanced controls are rejected safely at the native TUI runtime boundary and hidden by the central frontend capability helpers. Broader UI copy may still need review so native TUI sessions consistently explain external-locked semantics.

## Current Conclusion

The PTY-first core is materially implemented for the main live entry paths, and default tests are green. The goal is not complete yet because real native TUI browser/mobile smoke, human provider QA, remaining shell/canvas audit, and adapter-interface slimming are still incomplete.
