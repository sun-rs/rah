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
| Native TUI core separated from legacy adapter live path | `native-tui-provider-runtime.test.ts` forbids core imports from `provider-adapter` and `legacy-structured/runtime-structured-provider-coordinator` | Covered by tests |
| `rah <provider>` uses daemon PTY exclusively | `bin/rah.mjs`; `rah-cli-pty-first.test.ts`; public `RAH_LEGACY_WRAPPER=1` escape hatch removed from the CLI entry | Done |
| `rah <provider> resume <id>` uses daemon PTY by default | `bin/rah.mjs`; `rah-cli-pty-first.test.ts` posts `/api/sessions/resume` with `liveBackend: "native_tui"` and attaches the terminal client to PTY replay | Done |
| Terminal detach does not close live PTY | `bin/rah.mjs` best-effort `/detach`; `rah-cli-pty-first.test.ts` | Done |
| Clientless native TUI survives list/prune | `RuntimeEngine.pruneOrphanSessions()` skips native TUI sessions; `runtime-engine.test.ts` | Done |
| Web detach does not close native TUI | `native TUI backend survives web detach and clientless session listing` test | Done |
| Daemon default live start/resume is PTY-first | `RuntimeEngine.shouldUseNativeTuiBackend()` defaults five providers to `native_tui`; `default live start uses native TUI...` test | Done |
| Read-only history stays read-only | `preferStoredReplay` bypasses native TUI default; `session-store-session-startup.test.ts`; `workbench-state.test.ts` | Done |
| Mirror layer separated from coordinator | `native-tui-mirror-runtime.ts`; `RuntimeTerminalCoordinator` delegates mirror polling/application | Done |
| Mirror provider separated from lifecycle runtime | `NativeTuiProviderRuntime` owns launch/resume/binding/output observation only; `NativeTuiMirrorProvider` owns `updateMirror()` and is injected into `NativeTuiMirrorRuntime` | Done |
| Native TUI handler capability split | `NativeTuiBindingHandler` and `NativeTuiMirrorHandler` separate compile-time lifecycle/binding from mirror parsing; combined handlers remain only as DRY provider implementations | Done |
| Mirror failure does not affect TUI | native TUI diagnostics tests and runtime mirror failure tests | Covered by tests |
| Structured source is provider history/DB | native provider handlers and stored-session parsers remain the mirror source | Partially done |
| Workbench shell only view/attach | Web startup defaults native TUI; history browsing remains replay-only; global session selection exits canvas and selects/attaches; pane session selection targets only the pane; `activateHistorySessionCommand` tests lock replay/attach instead of implicit claim | Audited with tests |
| Canvas pane view/attach semantics | `canvas-state.ts` centralizes pane target rules; `canvas-state.test.ts` locks live-session uniqueness and allows read-only history replay in multiple panes | Covered by tests |
| Mobile terminal input bridge policy | `TerminalPane.tsx` uses `terminal-mobile-bridge.ts` so tapping the terminal surface focuses the real mobile input with browser viewport anchoring, while shortcut buttons avoid viewport movement | Covered by tests |
| Enhanced controls downgraded | native TUI capabilities expose `structuredControl: false`; `runtime-engine.test.ts` rejects mode/model changes for native TUI while preserving idle PTY input; `session-capabilities.test.ts` hides RAH-managed controls when structured control is unavailable | Covered by tests |
| Legacy structured path no longer default | Web, CLI, and default daemon RuntimeEngine prefer native TUI | Done |
| Legacy structured path named as legacy/enhancement | `legacy-structured/RuntimeStructuredProviderCoordinator` owns explicit `liveBackend: "structured"` start/resume, diagnostics, debug, and catalog fallbacks | Done |
| Legacy structured session ownership named explicitly | `RuntimeEngine` tracks legacy structured session owner provider keys as `structuredSessionOwners`; structured lifecycle/input/permission/workspace fallback uses explicit capability maps | Done |
| Legacy structured adapter slices named explicitly | `ProviderStructuredLifecycleAdapter`, `ProviderStructuredInputControlAdapter`, and `ProviderStructuredPermissionAdapter` mark non-core structured live capability slices | Done |
| Enhanced adapter slices named explicitly | `ProviderEnhancedModeAdapter` and `ProviderEnhancedModelAdapter` mark model/mode controls as optional enhancements, not PTY-first core requirements | Done |
| Stored history discovery depends only on history slice | `RuntimeEngine.historyMirrorAdapters` and `runtime-session-list.ts` use `ProviderStoredHistoryAdapter` instead of the full `ProviderAdapter` interface | Done |
| Stored history is not a top-level provider adapter requirement | `ProviderAdapter` no longer extends `ProviderStoredHistoryAdapter`; RuntimeEngine builds `storedHistoryAdaptersByProvider` and `historyMirrorAdapters` through an explicit capability guard | Done |
| Stored history runtime uses narrow bound views | `RuntimeEngine` binds stored-history methods into `ProviderStoredHistoryAdapter` views before registering history maps, instead of storing full provider adapter instances in history/mirror maps | Done |
| Built-in workspace inspection bypasses provider adapters | `ProviderAdapter` no longer extends `ProviderWorkspaceInspectionAdapter`; `RuntimeEngine` routes workspace snapshot/file/git read/apply actions through shared workspace utilities for non-`custom` sessions; duplicate workspace/file/git methods were removed from the five built-in provider adapters; `custom` debug sessions keep the structured adapter fallback | Done |
| Context usage bypasses provider adapters | `RuntimeEngine.getContextUsage()` reads canonical session-store usage directly; duplicated adapter `getContextUsage()` methods and `ProviderStructuredContextAdapter` were removed | Done |
| Structured input/control/permission is optional legacy surface | `ProviderAdapter` no longer extends `ProviderStructuredInputControlAdapter` or `ProviderStructuredPermissionAdapter`; `RuntimeEngine` requires these slices only after wrapper/native PTY paths fail | Done |
| Structured lifecycle is optional legacy surface | `ProviderAdapter` no longer extends `ProviderStructuredLifecycleAdapter`; `RuntimeStructuredProviderCoordinator` receives only explicit structured lifecycle adapters for `liveBackend: "structured"` requests | Done |
| Legacy structured live clients isolated by path | Five `*-live-client.ts` implementations now live under `packages/runtime-daemon/src/legacy-structured/`; shared Codex/Gemini app-server/CLI helpers were extracted to root utility modules so terminal wrapper/native paths do not import legacy clients; package root exports no longer expose those legacy clients | Done |
| Legacy structured coordinator uses explicit capability maps | `RuntimeEngine` now passes `structuredLiveAdaptersByProvider`, `modelAdaptersByProvider`, `diagnosticAdaptersByProvider`, and `debugAdaptersById` into `RuntimeStructuredProviderCoordinator` instead of the full provider adapter registry | Done |
| Enhanced controls are not top-level provider adapter requirements | `ProviderAdapter` no longer extends `ProviderEnhancedModeAdapter`, `ProviderEnhancedModelAdapter`, or `ProviderActionCapabilityAdapter`; RuntimeEngine builds explicit mode/model/action capability maps for optional RAH-managed controls | Done |
| Diagnostics/debug/shutdown are explicit capability maps | `ProviderAdapter` no longer extends `ProviderDiagnosticAdapter`, `ProviderDebugAdapter`, or `ProviderShutdownAdapter`; RuntimeEngine builds explicit diagnostic/debug/shutdown maps | Done |
| Top-level provider adapter is identity-only | `ProviderAdapter` now only extends `ProviderAdapterIdentity`; all behavior is registered through explicit capability slices/maps | Done |
| Full adapter registries removed from RuntimeEngine | RuntimeEngine no longer keeps `adaptersById` / `adaptersByProvider`; structured fallback lookup uses `structuredLiveAdaptersByProvider`, and other behavior uses explicit capability maps | Done |
| Structured session owners no longer store adapters | `structuredSessionOwners` stores provider keys only; RuntimeEngine resolves lifecycle/input/permission/workspace fallback through narrow capability maps | Done |
| Structured capability maps use bound views | structured lifecycle/input/permission/workspace maps store bound capability views, not full provider adapter objects | Done |
| Enhancement and operational maps use bound views | mode/model/action/diagnostic/debug/shutdown maps store bound capability views, not full provider adapter objects | Done |

## Verification Run

Latest verified gates in this branch:

- `npm run typecheck`: pass
- `npm run test:web`: 158 pass
- `npm run test:provider-contracts`: 133 pass
- `npm run test:runtime`: 375 pass after the CLI resume PTY-first smoke addition
- `npm run test:native-tui`: pass on 2026-05-07 after removing the production structured-live env escape hatch
- `npm run test:smoke:wrapper`: pass on 2026-05-07 as an explicit legacy/internal daemon smoke

`test:runtime` now uses `--test-concurrency=1` because runtime tests mutate process-wide provider binary env vars such as `RAH_CODEX_BINARY`; parallel test files can otherwise contaminate each other and create false failures.

`test:native-tui` covered the full PTY-first automatic gate for this checkout: typecheck, web tests, runtime tests, web build, real CLI help/version probe, Codex native smoke, Claude/Gemini/Kimi/OpenCode native provider smoke, Chromium browser native Codex smoke, Chromium browser native provider smoke, and `git diff --check`. The Chromium Codex browser smoke also covered mobile TUI input bridge shortcut/text/composition input and terminal-canvas focus routing. The CLI probe captured the current local versions: Codex `0.128.0`, Claude Code `2.1.132`, Gemini `0.40.0`, Kimi `1.40.0`, and OpenCode `1.14.40`.

`npm run test:smoke:wrapper` remains available as an explicit legacy/internal daemon smoke for the old wrapper-control path, but it is no longer part of the PTY-first native gate. The public `rah <provider>` CLI path now enters the native TUI runtime directly.

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

Legacy structured coordinator path isolation verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts`: 51 pass

This guard verifies that the explicit structured live coordinator has moved under `packages/runtime-daemon/src/legacy-structured/` and that native TUI core still does not import it.

Workspace inspection boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `npm run test:runtime`: 375 pass
- `git diff --check`: pass

This guard verifies that built-in provider sessions no longer require provider adapters for generic workspace snapshot, file read, git diff/status, or git apply actions. `ProviderWorkspaceInspectionAdapter` is no longer part of the built-in `ProviderAdapter` requirement, the duplicate implementations have been deleted from Codex/Claude/Gemini/Kimi/OpenCode adapters, and the slice remains only as the legacy/debug `custom` structured fallback until the adapter interface is fully slimmed.

Context usage boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `npm run test:runtime`: 375 pass
- `git diff --check`: pass

This guard verifies that usage display no longer calls through provider adapters. Provider activities still update canonical usage in `SessionStore`; HTTP/API reads now use `RuntimeEngine.getContextUsage()` directly.

Structured input/control boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/runtime-engine.test.ts packages/runtime-daemon/src/native-tui-provider-runtime.test.ts`: pass

This guard verifies that built-in adapter type requirements no longer include structured input/control/permission. RuntimeEngine still preserves the legacy structured path by checking for `ProviderStructuredInputControlAdapter` only after terminal wrapper and native TUI PTY paths decline the input/interrupt/resize event, and checking `ProviderStructuredPermissionAdapter` only after terminal/native permission handling declines the response.

Structured lifecycle boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts`: 52 pass

This guard verifies that new provider adapters are no longer type-required to implement legacy structured `startSession/resumeSession/closeSession/destroySession`. Explicit structured live requests still fail loudly through `RuntimeStructuredProviderCoordinator` if the provider does not implement that optional slice.

Workbench shell view/attach boundary verified on 2026-05-07:

- `node --import tsx --test --test-force-exit packages/client-web/src/session-store-session-startup.test.ts`: 10 pass

This guard verifies that ordinary history activation stays read-only (`preferStoredReplay: true`), uses observe attach, does not send `liveBackend`, and does not require creating a missing workspace. Claiming history remains the explicit path that checks the workspace and launches native TUI. Code audit also confirms that global sidebar/session activation exits canvas before selecting a session, while pane-local `SessionHistoryDialog` activation writes only the target pane through `setCanvasPaneStoredRef` / `setCanvasPaneSession`.

Legacy structured live client path isolation verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts`: 7 pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/gemini-adapter.test.ts packages/runtime-daemon/src/runtime-engine.test.ts`: 62 pass

This guard verifies that no root-level provider `*-live-client.ts` remains, that all five structured live clients are explicit legacy files, and that shared Codex/Gemini helpers used by terminal wrapper/native-adjacent code have been extracted outside the legacy client modules.

Structured coordinator capability map isolation verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts`: 52 pass

This guard verifies that the legacy structured coordinator no longer receives the full `adaptersByProvider` registry. RuntimeEngine now builds explicit capability maps for structured live lifecycle, model catalogs, diagnostics, and debug scenarios.

Stored history capability boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts`: 52 pass

This guard verifies that stored history/mirror access no longer rides on the top-level `ProviderAdapter` contract. RuntimeEngine now builds stored-history maps explicitly and still preserves frozen history snapshots that outlive read-only replay sessions.

Stored history narrow-view boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts`: 52 pass

This guard verifies that RuntimeEngine stores bound `ProviderStoredHistoryAdapter` views in history/mirror maps rather than full provider adapter instances. Full adapters still own their provider-specific implementation code, but the runtime dependency is now a narrow history capability.

Enhanced control capability boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts`: 52 pass

This guard verifies that RAH-managed mode, model, and rename controls are optional enhancement maps, not required provider adapter protocol surface. Native TUI sessions remain externally controlled by capability metadata and runtime guards.

Diagnostics/debug/shutdown capability boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts`: 52 pass

This guard verifies that provider diagnostics, debug scenarios, and shutdown cleanup are registered through explicit capability maps rather than the top-level provider adapter protocol.

Native TUI mirror provider boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts`: 52 pass

This guard verifies that `NativeTuiProviderRuntime` no longer exposes `updateMirror()`. Native lifecycle launch/resume/binding remains separate from `NativeTuiMirrorProvider`, and `NativeTuiMirrorRuntime` depends only on the dedicated mirror seam for provider history/DB updates.

Native TUI binding/mirror handler type split verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts`: 52 pass

This guard verifies that lifecycle/binding code consumes `NativeTuiBindingHandler` while mirror code consumes `NativeTuiMirrorHandler`. The five provider implementations can still share one object shape for DRY reasons, but the runtime-facing seams are separate.

Full adapter registry removal verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts`: 52 pass

This guard verifies that RuntimeEngine no longer stores catch-all `adaptersById` or `adaptersByProvider` registries. Legacy structured fallback is resolved through `structuredLiveAdaptersByProvider`; diagnostics, debug, shutdown, model, mode, actions, and stored history all use explicit maps.

Structured owner narrow-map boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts packages/runtime-daemon/src/debug-engine.test.ts`: 53 pass

This guard verifies that `structuredSessionOwners` stores provider keys rather than provider adapter instances. RuntimeEngine resolves legacy structured lifecycle, input/control, permission response, workspace inspection, and stored history through explicit capability maps.

Structured capability bound-view boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts packages/runtime-daemon/src/debug-engine.test.ts`: 53 pass

This guard verifies that structured lifecycle, input/control, permission response, and workspace inspection maps store bound narrow views rather than full provider adapter instances.

Enhancement and operational bound-view boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts packages/runtime-daemon/src/debug-engine.test.ts`: 53 pass

This guard verifies that mode, model, action, diagnostic, debug, and shutdown maps also store bound narrow views rather than full provider adapter instances.

Native TUI handler factory boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts packages/runtime-daemon/src/debug-engine.test.ts`: 53 pass
- `npm run test:runtime`: 375 pass

This guard verifies that `DefaultNativeTuiProviderRuntime` receives the binding-only handler factory and `DefaultNativeTuiMirrorProvider` receives the mirror-only handler factory. The previous combined provider handler factory has no remaining runtime-facing callers and has been removed.

Provider capability binding boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts packages/runtime-daemon/src/debug-engine.test.ts`: 53 pass

This guard verifies that provider capability detection and binding live in `provider-capability-bindings.ts` rather than inside `RuntimeEngine`. RuntimeEngine now registers already-bound narrow capability views, while the top-level `ProviderAdapter` remains identity-only.

Default adapter construction boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts packages/runtime-daemon/src/debug-engine.test.ts`: 53 pass

This guard verifies that `RuntimeEngine` no longer imports the five provider adapter classes or `DebugAdapter` directly. Default legacy/enhancement adapter construction is isolated behind `createDefaultProviderAdapters()`, keeping the core engine focused on capability registration and PTY-first session orchestration.

Provider capability view type boundary verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts packages/runtime-daemon/src/debug-engine.test.ts`: 53 pass

This guard verifies that bound capability maps use the explicit `ProviderCapabilityView<T>` alias instead of scattered `Pick<ProviderAdapter, "id"> & T` types. Capability views now have their own narrow type identity while `ProviderAdapter` stays identity-only.

Claude stored-history adapter split verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/claude-adapter.test.ts packages/runtime-daemon/src/runtime-engine.test.ts packages/runtime-daemon/src/native-tui-provider-runtime.test.ts`: 61 pass
- `npm run test:runtime`: 375 pass

This guard verifies the first provider-level split between legacy structured live and provider-native stored history. `ClaudeStoredHistoryAdapter` owns Claude stored-session catalog, history page loading, frozen history paging, watch roots, and removal. `ClaudeAdapter` remains the legacy structured live/enhancement adapter and no longer exposes `listStoredSessions`, `getSessionHistoryPage`, or `removeStoredSession`.

Gemini stored-history adapter split verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/gemini-adapter.test.ts packages/runtime-daemon/src/runtime-engine.test.ts packages/runtime-daemon/src/native-tui-provider-runtime.test.ts`: 69 pass

This guard verifies the same split for Gemini. `GeminiStoredHistoryAdapter` owns Gemini stored-session catalog, history page loading, frozen history paging, watch roots, and removal. `GeminiAdapter` remains the legacy structured live/enhancement adapter and no longer exposes `listStoredSessions`, `getSessionHistoryPage`, or `removeStoredSession`.

Kimi stored-history adapter split verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/kimi-adapter.test.ts packages/runtime-daemon/src/kimi-session-files.test.ts packages/runtime-daemon/src/runtime-engine.test.ts packages/runtime-daemon/src/native-tui-provider-runtime.test.ts`: 66 pass

This guard verifies the same split for Kimi. `KimiStoredHistoryAdapter` owns Kimi stored-session catalog, history page loading, frozen history paging, watch roots, and removal. `KimiAdapter` remains the legacy structured live/enhancement adapter and no longer exposes `listStoredSessions`, `getSessionHistoryPage`, or `removeStoredSession`.

OpenCode stored-history adapter split verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/opencode-live-client.test.ts packages/runtime-daemon/src/opencode-stored-sessions.test.ts packages/runtime-daemon/src/opencode-activity.test.ts packages/runtime-daemon/src/runtime-engine.test.ts packages/runtime-daemon/src/native-tui-provider-runtime.test.ts`: 80 pass

This guard verifies the same split for OpenCode. `OpenCodeStoredHistoryAdapter` owns OpenCode stored-session catalog, DB-backed history page loading, frozen history paging, watch roots, and archive/removal. `OpenCodeAdapter` remains the legacy structured live/enhancement adapter and no longer exposes `listStoredSessions`, `getSessionHistoryPage`, or `removeStoredSession`.

Codex stored-history adapter split verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/codex-adapter.test.ts packages/runtime-daemon/src/codex-stored-sessions.test.ts packages/runtime-daemon/src/codex-live-client.test.ts packages/runtime-daemon/src/runtime-engine.test.ts packages/runtime-daemon/src/native-tui-provider-runtime.test.ts`: 87 pass

This guard verifies the same split for Codex. `CodexStoredHistoryAdapter` owns Codex stored-session catalog, rollout-backed history page loading, frozen history paging, watch roots, and archive/removal. `CodexAdapter` remains the legacy structured live/enhancement adapter and no longer exposes `listStoredSessions`, `getSessionHistoryPage`, or `removeStoredSession`.

Legacy structured default construction quarantine verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-provider-runtime.test.ts packages/runtime-daemon/src/runtime-engine.test.ts`: 52 pass

This guard verifies that `default-provider-adapters.ts` no longer directly constructs the five legacy structured provider adapters. It registers provider-native stored-history adapters directly and pulls the old structured live/enhancement adapters through `legacy-structured/default-structured-provider-adapters.ts`, making that path explicit and easier to disable or remove later.

Legacy structured adapter implementation path isolation verified on 2026-05-07:

- `npm run typecheck`: pass
- `npm run test:runtime`: 375 pass
- `npm run test:web`: 156 pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/codex-adapter.test.ts packages/runtime-daemon/src/claude-adapter.test.ts packages/runtime-daemon/src/gemini-adapter.test.ts packages/runtime-daemon/src/kimi-adapter.test.ts packages/runtime-daemon/src/opencode-live-client.test.ts packages/runtime-daemon/src/native-tui-provider-runtime.test.ts`: pass

This guard verifies that the five root `*-adapter.ts` files are compatibility re-exports only. The actual legacy structured live/enhancement implementations now live under `packages/runtime-daemon/src/legacy-structured/*-structured-adapter.ts`.

Legacy structured live production escape hatch removal verified on 2026-05-07:

- `npm run typecheck`: pass
- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/native-tui-runtime-config.test.ts packages/runtime-daemon/src/runtime-engine.test.ts packages/runtime-daemon/src/workbench-state.test.ts packages/runtime-daemon/src/native-tui-provider-runtime.test.ts`: 73 pass
- `npm run test:runtime`: 375 pass

This guard verifies that production `RuntimeEngine` rejects explicit `liveBackend: "structured"` live start/resume. The path remains available only for injected test adapters; `preferStoredReplay` read-only history replay is not blocked.

CLI resume PTY-first path verified on 2026-05-07:

- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/rah-cli-pty-first.test.ts`: 2 pass
- `npm run typecheck`: pass
- `git diff --check`: pass

This guard verifies both `rah <provider>` new-session attach and `rah <provider> resume <id>` attach. The resume case posts the provider session id to `/api/sessions/resume`, requests `liveBackend: "native_tui"`, attaches an interactive terminal client with control, receives PTY replay, and detaches without closing the PTY session.

Mobile terminal input bridge policy verified on 2026-05-07:

- `node --import tsx --test --test-force-exit packages/client-web/src/terminal-mobile-bridge.test.ts packages/client-web/src/terminal-viewport.test.ts`: 6 pass
- `npm run test:web`: 158 pass
- `npm run typecheck`: pass
- `npm run build:web`: pass
- `git diff --check`: pass

This guard verifies the browser-facing policy for mobile terminal input. Direct taps on the terminal surface now use the same real-input browser viewport anchoring path as the visible mobile input bridge; shortcut taps still focus without browser scrolling so the shortcut bar stays stable.

Headless WebKit native browser smoke verified on 2026-05-07:

- `npm run test:smoke:native-browser-webkit`: pass

This guard verifies the same native Codex and multi-provider browser smoke suite under Playwright WebKit. It covers Chat/TUI rendering, PTY output/input, Stop via Ctrl-C, TUI replay after reload, foreground recovery catch-up, Canvas native TUI replay/resize, and the mobile TUI input bridge focus path. It does not replace real iPad/Safari input-method QA.

Real native TUI launch and automatic QA status verified on 2026-05-07:

- `RAH_NATIVE_REAL_TUI_PROBE_OUTPUT=test-results/native-real-tui-launch.json npm run test:smoke:native-real-tui-launch`: pass
- `RAH_NATIVE_CLI_PROBE_OUTPUT=test-results/native-cli-probe.json npm run test:smoke:native-cli-probe`: pass
- `npm run test:smoke:native-qa-status`: pass

This guard verifies that all five real provider CLIs can be launched inside the RAH PTY host and closed without sending a model prompt, and that saved CLI/help/version evidence matches the current commit. It still does not prove real model responses, long-running turn behavior, permission/login/quota flows, or iPad/Safari human interaction.

Public legacy wrapper CLI escape hatch removal verified on 2026-05-07:

- `node --import tsx --test --test-force-exit packages/runtime-daemon/src/rah-cli-pty-first.test.ts`: 2 pass
- `npm run typecheck`: pass
- `RAH_NATIVE_CLI_PROBE_OUTPUT=test-results/native-cli-probe.json npm run test:smoke:native-cli-probe`: pass
- `npm run test:runtime`: 375 pass
- `npm run test:native-tui`: pass
- `git diff --check`: pass

This guard verifies that `rah <provider>` and `rah <provider> resume <id>` use PTY-first start/resume even when `RAH_LEGACY_WRAPPER=1` is present in the environment. The old wrapper process-spawn branch has been removed from the public CLI entry; remaining terminal-wrapper code is internal legacy/test surface only.

## Remaining Gaps

These are still not completion-grade:

- Chromium and headless WebKit native browser smoke are covered. iPad/Safari real input-method behavior still needs human verification because headless WebKit cannot prove real keyboard/IME viewport behavior.
- Real five-provider CLI/account human QA is still required; fake native TUI tests do not prove real login/quota/provider behavior.
- Legacy structured adapters still exist. The structured live clients, structured adapter implementations, and default structured adapter construction are now path-isolated under `legacy-structured/`; production structured live cannot be enabled through an environment variable and remains available only through injected test adapters. Codex/Claude/Gemini/Kimi/OpenCode now have separate stored-history adapters. The remaining code gap is deciding whether to keep or delete this internal legacy/test surface.
- Legacy wrapper runtime still exists for synthetic tests and internal legacy reference. The public `rah xxx` CLI no longer exposes an env escape hatch into wrapper handoff, but the daemon-side wrapper registry/tests are not deleted.
- Workbench shell/canvas code paths are now audited for view/attach semantics. Remaining risk is interaction-level QA: drag/drop, pane replacement, hide/show, and mobile/iPad layout should still be exercised in a real browser.
- Enhanced controls are rejected safely at the native TUI runtime boundary and hidden by the central frontend capability helpers. Broader UI copy may still need review so native TUI sessions consistently explain external-locked semantics.

## Current Conclusion

The PTY-first core is materially implemented for the main live entry paths, the required provider adapter surface is substantially slimmed, and the automatic gates now cover runtime/web tests, real CLI help/version drift, real native TUI launch, Chromium browser smoke, and headless WebKit browser smoke. The public `rah xxx` wrapper handoff escape hatch has been removed, and production structured live can no longer be re-enabled through an environment variable, so CLI/Web live new/resume is now PTY-first only. The goal is not complete yet because final acceptance still requires iPad/Safari real input-method QA, real five-provider account/long-turn/permission QA, shell/canvas interaction QA on real devices, and an explicit keep/delete decision for the remaining internal legacy structured/wrapper test surface.
