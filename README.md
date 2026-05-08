# RAH

Runtime-owned AI workbench for local-first, cross-device session continuity.

## Current status

Version: `1.0.0-rc.1`.

RAH `1.0.0-rc.1` is the zellij-backed PTY-first release candidate. The product
boundary is now intentionally narrow:

- Codex, Claude, and OpenCode are the only first-class live provider CLIs.
- `rah <provider>` defaults to zellij-backed native TUI sessions.
- Web New/Claim/Resume follows the daemon live backend; use `RAH_MUX_BACKEND=zellij`
  when starting the daemon to make Web-created sessions use the zellij path.
- structured Chat is a mirror of provider-native history files/DBs, not ANSI screen scraping.
- zellij screen output is only the native TUI view/control surface.
- Chat input is injected into the provider TUI without stealing the active TUI display surface.
- The Web/PWA `TUI` tab is the explicit handoff point that may detach/cover the current terminal surface.
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
- `restart` interrupts currently managed core live TUIs (`rah codex`, `rah claude`,
  `rah opencode`) because the old daemon is stopped.
- `npm install` is not needed for normal code changes.
- daemon pid/log files live under `~/.rah/runtime-daemon`.
- `rah <provider>` now defaults to zellij-backed PTY-first native TUI sessions. It asks the daemon
  to create/resume a provider TUI inside a zellij mux session and attaches the current terminal to
  that mux session. Use `--mux native` only as a fallback diagnostic.
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
npm run test:native-tui
npm run test:zellij-tui-auto
npm run test:zellij-tui
npm run test:manual-qa-status
npm run test:smoke:native-codex-browser
npm run test:smoke:native-provider-browser
npm run test:smoke:native-browser-webkit
npm run test:smoke:history-claim
npm run test:smoke:tool-flow
npm run test:smoke:claude-flow
npm run test:smoke:claude-browser
npm run test:smoke:codex-browser
npm run test:smoke:opencode-browser
npm run test:smoke:browser-providers
npm run test:smoke:provider-flows
npm run test:smoke:wrapper
```

## Test tiers

RAH now uses five test tiers:

- default gate
  - `npm run typecheck`
  - `npm run test:provider-contracts`
  - `npm run test:web`
  - `npm run test:runtime`
- provider contracts
  - `npm run test:provider-contracts`
  - deterministic contract coverage for Codex, Claude, and OpenCode live paths
  - protects queued input, no duplicate live/history merge, Stop state convergence, model/mode/permission propagation, and Markdown/timeline rendering contracts on the core live path
- daemon smoke
  - `npm run test:smoke:wrapper`
  - exercises the legacy wrapper-control path in a dedicated test daemon
    without invoking external provider CLIs or model APIs
  - starts an isolated temporary daemon automatically; the normal daemon keeps wrapper-control and the wrapper runtime disabled
- native TUI gate
  - `npm run test:native-tui`
  - exercises the PTY-first lifecycle, fake native provider TUIs, browser replay/reconnect,
    WebKit browser smoke, mobile input bridge contracts, mirror diagnostics, and native-TUI-specific regression cases
  - includes `test:manual-qa-status` so the human QA evidence verifier cannot silently weaken
  - core live provider expectations are Codex, Claude, and OpenCode
- provider smoke
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
  - `provider-flows`
- release/CI gate
  - provider smoke should run only in an environment where the matching provider CLI and account
    are already configured
  - provider smoke should be selected per provider, not treated as one universal gate for every
    machine

Detailed provider regression coverage is tracked in `docs/provider-regression-testing.zh-CN.md`.

For the current PTY-first branch, the preferred browser smoke commands are `native-codex-browser`,
`native-provider-browser`, and `native-browser-webkit`. The older provider-specific browser smoke
commands are still useful as local diagnostics, but they do not replace the native PTY browser smoke.

Provider smoke is intentionally **not** treated as a universal local gate. Installed CLI binaries do
not prove authentication, quota, or account access.

`npm run test:smoke:browser-providers` is a legacy convenience command for a known-good local
machine with the matching core provider CLIs authenticated. It is not a default gate. Different machines may
have:

- only some provider CLIs installed
- valid binaries but missing login/auth
- valid auth for one provider but not another

For that reason, provider smoke can still be run explicitly per provider. `npm run test:smoke:wrapper`
is the deterministic legacy/internal smoke for wrapper lifecycle, web input injection, canonical
timeline identity propagation, and cleanup across the core live provider registrations. It starts an isolated
temporary daemon with wrapper-control and the wrapper runtime enabled; the normal daemon keeps both
disabled.

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

RAH stays close to the proven hapi/paseo product boundary:

- transcript, tool calls, permissions, usage, attention, and session state are core workbench data.
- provider-native history files/DBs are the semantic source of structured Chat.
- zellij/PTY output is a TUI control and viewing surface, not the semantic transcript source.
- Chat input/Stop can be injected without claiming the Web TUI display surface.
- only explicit Web/PWA `TUI` view claims the zellij display surface and may detach/cover another attached terminal.
- provider-specific maintenance signals should remain adapter-owned or inspector-only.

## 1.0 RC Scope

`1.0.0-rc.1` is considered feature-complete enough for the current branch goal:

- zellij-backed mux runtime exists and is the default `rah <provider>` CLI path.
- one RAH live session maps to one zellij session/pane.
- terminal, Web, PWA, and reconnect flows attach to the same live provider TUI rather than creating
  a resume session.
- Chat mirror remains provider-history-backed and uses canonical timeline identity/reconciliation to
  avoid live/history duplicates.
- Chat input no longer steals the active TUI display surface; TUI display ownership is explicit.
- Archive closes the provider pane and zellij session instead of leaving an orphan mux.
- zellij diagnostics expose managed/unmanaged `rah-*` sessions.

Known RC boundaries:

- zellij remains the release-candidate backend, not a claim that every provider TUI/version/device is final-stable.
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
- [rah codex handoff 模式设计（中文）](./docs/rah-codex-handoff-mode.zh-CN.md)
- [rah claude handoff 模式设计（中文）](./docs/rah-claude-handoff-mode.zh-CN.md)
- [Session 入口与权限边界（中文）](./docs/session-entry-capability-boundary.zh-CN.md)
- [PTY-first 进度审计（中文）](./docs/pty-first-progress-audit.zh-CN.md)
- [Terminal Wrapper Live Sessions（中文）](./docs/terminal-wrapper-live-sessions.zh-CN.md)
- [Terminal Wrapper Protocol Draft（中文）](./docs/terminal-wrapper-protocol.zh-CN.md)
- [Protocol Freeze Status](./docs/protocol-freeze-status.md)
- [Release Checklist](./docs/release-checklist.md)
- [UI 回归清单（中文）](./docs/ui-regression-checklist.zh-CN.md)
