# RAH

Runtime-owned AI workbench for local-first, cross-device session continuity.

## Current status

Version: `1.0.0-rc.1`.

RAH `1.0.0-rc.1` is moving to a provider-native runtime boundary. The product
boundary is intentionally narrow:

- Codex, Claude, and OpenCode are the only first-class live provider CLIs.
- Codex and OpenCode default to provider `native_local_server` runtimes. RAH talks to the
  provider server for structured live events/control, and the local terminal uses the
  provider-native TUI attach client.
- Claude defaults to the zellij/TUI mux fallback because Claude Code has no stable Codex/OpenCode-style
  local app-server.
- Web New/Claim/Resume follows provider runtime capabilities: Codex/OpenCode use native local server;
  Claude uses the TUI mux fallback.
- structured Chat uses provider server events where available and provider-native history files/DBs
  for backfill/history. It is not ANSI screen scraping.
- Session sync has a fixed boundary: new live sessions do not show older-history loading; selecting an
  existing live session silently syncs the latest tail; only read-only replay or upward scrolling loads
  older history. See
  [`docs/history-browsing.zh-CN.md`](docs/history-browsing.zh-CN.md).
- zellij screen output is only the native TUI view/control surface for Claude and fallback paths.
- The Web/PWA `TUI` tab is the explicit handoff point for TUI surfaces.
- provider adapters own launch specs, binding probes, mirror parsers, and optional capability catalogs.
- model/permission/plan/effort controls are optional provider enhancements, not the core contract.

The workbench is served through the daemon itself. The stable local entry is:

- `http://127.0.0.1:43111/`

The daemon intentionally listens on `0.0.0.0` so phones/tablets on the LAN can reach the same
workbench when the host firewall/network allows it.

The Vite server remains a development-only entry:

- `http://127.0.0.1:43112/`

## Quick start

Install dependencies once, or whenever `package-lock.json` changes:

```bash
npm install
```

Daily source workflow:

```bash
node bin/rah.mjs restart --no-open
```

This is the normal command after code changes. It builds the web client, stops the current managed
daemon, starts a new daemon from this checkout, and leaves the workbench at:

```text
http://127.0.0.1:43111/
```

If only backend code changed and the web bundle does not need rebuilding:

```bash
node bin/rah.mjs restart --no-build --no-open
```

Run the daemon with zellij as the default Web live backend:

```bash
RAH_MUX_BACKEND=zellij node bin/rah.mjs restart --no-open
```

Important behavior:

- `start` does not replace a daemon that is already running.
- `restart` is the command that shuts down the old daemon and starts the updated code.
- `restart` interrupts currently managed core live provider runtimes (`rah codex`, `rah claude`,
  `rah opencode`) because the old daemon is stopped.
- `npm install` is not needed for normal code changes.
- daemon pid/log files live under `~/.rah/runtime-daemon`.
- `rah codex` and `rah opencode` now default to native local-server sessions and attach the current
  terminal with the provider-native TUI client (`codex --remote ... resume ...` or
  `opencode attach ... --session ...`).
- `rah claude` defaults to the zellij/TUI fallback. Use `--mux zellij` or `--mux native` on
  Codex/OpenCode only when you explicitly want the fallback TUI path for diagnostics.
- Core live providers are `codex`, `claude`, and `opencode`. Gemini/Kimi CLI first-class support
  has been removed; use OpenCode + API providers for Gemini/Kimi/Grok/DeepSeek-style work. See
  [`docs/provider-scope-codex-claude-opencode.zh-CN.md`](docs/provider-scope-codex-claude-opencode.zh-CN.md).

Optional: if you want the global `rah` command to point at this checkout, link it once:

```bash
npm link
rah restart --no-open
```

If the global `rah` may point at an older install, prefer `node bin/rah.mjs ...` from this repo.

For LAN access, use the Mac's LAN IP with port `43111`.

Useful daemon commands:

```bash
node bin/rah.mjs status
node bin/rah.mjs logs --follow
node bin/rah.mjs stop
```

Advanced development only:

```bash
npm run serve:workbench
npm run dev:daemon
npm run dev:web
```

## Workspace scripts

```bash
npm run build:web
npm run serve:workbench
npm run typecheck
npm run test:provider-contracts
npm run test:web
npm run test:runtime
npm run test:regression:e2e-browser
npm run test:native-tui
npm run test:zellij-tui-auto
npm run test:zellij-tui
npm run test:manual-qa-status
npm run test:smoke:native-codex-browser
npm run test:smoke:native-provider-browser
npm run test:smoke:native-browser
npm run test:smoke:native-browser-webkit
npm run test:smoke:history-claim
npm run test:smoke:tool-flow
npm run test:smoke:claude-flow
npm run test:smoke:claude-browser
npm run test:smoke:codex-browser
npm run test:smoke:opencode-browser
npm run test:smoke:browser-providers
npm run test:smoke:real-browser-providers
npm run test:smoke:provider-flows
```

## Test tiers

RAH now uses four test tiers:

- default gate
  - `npm run typecheck`
  - `npm run test:provider-contracts`
  - `npm run test:web`
  - `npm run test:runtime`
- provider contracts
  - `npm run test:provider-contracts`
  - deterministic contract coverage for Codex, Claude, and OpenCode live paths
  - protects queued input, no duplicate live/history merge, Stop state convergence, model/mode/permission propagation, and Markdown/timeline rendering contracts on the core live path
- native TUI gate
  - `npm run test:native-tui`
  - exercises the PTY-first lifecycle, fake native provider TUIs, browser replay/reconnect,
    WebKit browser smoke, mobile input bridge contracts, mirror diagnostics, and native-TUI-specific regression cases
  - includes `test:manual-qa-status` so the human QA evidence verifier cannot silently weaken
  - core live provider expectations are Codex, Claude, and OpenCode
- provider smoke
  - `native-browser`
  - `native-codex-browser`
  - `native-provider-browser`
  - `native-browser-webkit`
  - `history-claim`
  - `tool-flow`
  - `codex-browser`
  - `claude-flow`
  - `claude-browser`
  - `opencode-browser`
  - `browser-providers`
  - `real-browser-providers`
  - `provider-flows`
- release/CI gate
  - `npm run test:regression:e2e-browser`
  - runs real Codex, Claude, and OpenCode browser smoke against the current local machine
  - requires matching provider CLIs, account login, quota, and network to be healthy

Detailed provider regression coverage is tracked in `docs/provider-regression-testing.zh-CN.md`.

For the current native-local-server branch, the preferred smoke coverage is split by runtime:
`test:smoke:native-local-server` verifies Codex/OpenCode provider-server capabilities, while
`test:smoke:native-browser` runs deterministic browser/UI smoke coverage for Codex, Claude, and
OpenCode with fake provider backends. `native-browser-webkit` and `native-browser-firefox` run the
same browser smoke in alternate engines. The smoke records screenshots for Chat mirror, Web TUI,
reload replay, and Web resume history, and asserts message ordering, duplicate prevention, Stop
state convergence, dirty-prompt blocking, and absence of unexpected provider-event/loading-history
noise on new live sessions.

The formal real-browser regression gate is `npm run test:regression:e2e-browser`. It runs the real provider browser
smokes for Codex, Claude, and OpenCode and hard-fails on the regressions that have historically hurt
human testing: duplicate bubbles, wrong message order, Stop not disappearing, repeated Stop exiting a
TUI, interrupt notices duplicating/drifting, history replay noise, claim/resume duplication, and
follow-up Web chat turns not reaching the provider.

Manual QA evidence for this branch is checked by:

```bash
npm run test:smoke:native-manual-qa-status
```

Generate the current-code template with:

```bash
RAH_NATIVE_MANUAL_QA_TEMPLATE_OUTPUT=test-results/native-manual-qa.json npm run test:smoke:native-manual-qa-status -- --print-template
```

The verifier records a `worktreeFingerprint`, so pass results are tied to the exact dirty worktree
snapshot being tested, not just the last commit.

Provider smoke is intentionally tied to this local workstation. Installed CLI binaries do not prove
authentication, quota, or account access.

`npm run test:smoke:browser-providers` is the deterministic fake browser gate and currently aliases
`test:smoke:native-browser`. `npm run test:regression:e2e-browser` and
`npm run test:smoke:real-browser-providers` require a known-good local machine with the matching core
provider CLIs authenticated. Different machines may have:

- only some provider CLIs installed
- valid binaries but missing login/auth
- valid auth for one provider but not another

For that reason, provider smoke can still be run explicitly per provider. The old wrapper-control
smoke path has been removed; current deterministic coverage lives in the native TUI, native local-server,
and browser regression gates.

## Package layout

```text
packages/
  runtime-protocol/   Canonical types, event families, contract validation
  runtime-daemon/     Runtime engine, event bus, PTY hub, provider adapters
  client-web/         Workbench UI consuming the canonical protocol
```

## Runtime layering

- `RuntimeEngine` owns the shared session store, event bus, and PTY hub.
- `MuxRuntime` / `ZellijMuxBackend` owns zellij session/pane create, attach, dump, subscribe,
  raw input, interrupt, close, kill, diagnostics, and recovery.
- `RuntimeTerminalCoordinator` is the single live TUI lifecycle coordinator for native and zellij
  backed sessions.
- `ProviderAdapter` is the seam where concrete providers plug into the runtime.
- `ProviderActivity` is the adapter-facing normalization layer.
- Codex, Claude, and OpenCode are the core live native TUI providers.
- Gemini/Kimi CLI provider code has been removed. New Gemini/Kimi-family live work should go
  through OpenCode/API-provider configuration.
- `DebugAdapter` remains useful for structured scenario replay and non-provider UI exercise.
- `client-web` consumes the canonical API/events boundary and should not depend on provider-native
  event names.
- `client-web` store ownership is documented in
  [`docs/client-web-store-ownership.zh-CN.md`](docs/client-web-store-ownership.zh-CN.md).

## Provider diagnostics

The daemon now exposes lightweight provider diagnostics at:

- `GET /api/providers`

Diagnostics intentionally report only:

- launch command
- version probe
- basic runtime status

Provider diagnostics are scoped to the core live providers: Codex, Claude, and OpenCode. Gemini/Kimi
CLI binaries are no longer probed in Settings.

They intentionally do **not** claim that provider authentication is valid. Auth remains managed by
the provider CLI itself.

Current statuses are:

- `ready`
- `missing_binary`
- `launch_error`

## Design boundary

RAH keeps the live runtime boundary explicit:

- transcript, tool calls, permissions, usage, attention, and session state are core workbench data.
- Codex/OpenCode live Chat/control uses provider-native local server APIs when available.
- provider-native history files/DBs remain the semantic source for history/backfill.
- zellij/PTY output is a TUI control and viewing surface, not the semantic transcript source.
- only explicit Web/PWA `TUI` view claims a TUI display surface.
- provider-specific maintenance signals should remain adapter-owned or inspector-only.

## 1.0 RC Scope

`1.0.0-rc.1` is considered feature-complete enough for the current branch goal:

- Codex native local-server WebSocket runtime is wired, and Codex 0.130.0 remote TUI cross-client
  sync has passed `scripts/native_local_server_probe.ts`.
- OpenCode native local-server attach/cross-client sync has passed `scripts/native_local_server_probe.ts`.
- Claude zellij/TUI mux fallback remains the production continuity path for Claude.
- Chat timeline uses canonical identity/reconciliation to avoid live/history duplicates.
- provider runtime/capability metadata is protocolized so UI controls do not claim unsupported abilities.
- zellij diagnostics remain for Claude/fallback paths.

Known RC boundaries:

- Codex/OpenCode real model turn interrupt/archive behavior still requires provider-version QA after
  CLI upgrades.
- zellij remains a fallback/backend for Claude and future TUI-only providers, not the universal default.
- real provider auth, quota, trust-folder prompts, and slash-command behavior remain owned by the provider TUI.
- iOS/PWA terminal keyboard behavior is still a product QA area, not a protocol guarantee.
- Gemini/Kimi CLI will not return as first-class providers; use OpenCode/API-provider configuration instead.

## Docs

Start here:

- [Docs Index](./docs/README.md)
- [当前系统设计总览（中文）](./docs/current-system-design.zh-CN.md)
- [项目总览（中文）](./docs/project-overview.zh-CN.md)

Core design and freeze documents:

- [历史浏览与分页边界（中文）](./docs/history-browsing.zh-CN.md)
- [RAH Canonical Event Taxonomy](./docs/canonical-event-taxonomy.md)
- [RAH Workbench Boundary](./docs/workbench-boundary.md)
- [Codex Adapter Event Coverage](./docs/codex-event-coverage.md)
- [Provider Adapter Maintenance](./docs/provider-adapter-maintenance.md)
- [Provider Capability Matrix](./docs/provider-capability-matrix.md)
- [Provider Capability Protocol Draft](./docs/provider-capability-protocol-draft.md)
- [Architecture Benchmark (中文)](./docs/architecture-benchmark.zh-CN.md)
- [Session 入口与权限边界（中文）](./docs/session-entry-capability-boundary.zh-CN.md)
- [PTY-first 进度审计（中文）](./docs/pty-first-progress-audit.zh-CN.md)
- [Protocol Freeze Status](./docs/protocol-freeze-status.md)
- [Release Checklist](./docs/release-checklist.md)
- [UI 回归清单（中文）](./docs/ui-regression-checklist.zh-CN.md)
