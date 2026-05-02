# RAH

Runtime-owned AI workbench for local-first, cross-device session continuity.

## Current status

Version: `1.0.0`.

RAH is now centered on five main lines:

- canonical protocol and contract validation
- runtime daemon with provider adapter seam
- real provider adapters (`codex`, `claude`, `gemini`, `kimi`, `opencode`)
- same-origin workbench with stored history, replay, claim, and live upgrade

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

Important behavior:

- `start` does not replace a daemon that is already running.
- `restart` is the command that shuts down the old daemon and starts the updated code.
- `restart` interrupts currently managed live wrappers/TUIs (`rah codex`, `rah claude`,
  `rah gemini`, `rah kimi`, `rah opencode`) because the old daemon is stopped.
- `npm install` is not needed for normal code changes.
- daemon pid/log files live under `~/.rah/runtime-daemon`.

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
npm run test:smoke:history-claim
npm run test:smoke:tool-flow
npm run test:smoke:gemini-flow
npm run test:smoke:gemini-browser
npm run test:smoke:kimi-flow
npm run test:smoke:kimi-browser
npm run test:smoke:claude-flow
npm run test:smoke:claude-browser
npm run test:smoke:codex-browser
npm run test:smoke:opencode-browser
npm run test:smoke:browser-providers
npm run test:smoke:provider-flows
npm run test:smoke:wrapper
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
  - deterministic mock-provider coverage for Codex, Claude, Gemini, Kimi, and OpenCode
  - protects queued input, no duplicate live/history merge, Stop state convergence, model/mode/permission propagation, and Markdown/timeline rendering contracts
- daemon smoke
  - `npm run test:smoke:wrapper`
  - exercises the real daemon wrapper-control path for Codex, Claude, Gemini, Kimi, and OpenCode
    without invoking external provider CLIs or model APIs
- provider smoke
  - `history-claim`
  - `tool-flow`
  - `codex-browser`
  - `gemini-flow`
  - `gemini-browser`
  - `kimi-flow`
  - `kimi-browser`
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

Provider smoke is intentionally **not** treated as a universal local gate. Installed CLI binaries do
not prove authentication, quota, or account access.

`npm run test:smoke:browser-providers` is available for a known-good local machine with all five
provider CLIs authenticated. It is a convenience command, not a default gate. Different machines may
have:

- only some provider CLIs installed
- valid binaries but missing login/auth
- valid auth for one provider but not another

For that reason, provider smoke can still be run explicitly per provider. `npm run test:smoke:wrapper`
is the deterministic daemon-level smoke for wrapper lifecycle, web input injection, canonical
timeline identity propagation, and cleanup across all five provider adapters.

## Package layout

```text
packages/
  runtime-protocol/   Canonical types, event families, contract validation
  runtime-daemon/     Runtime engine, event bus, PTY hub, provider adapters
  client-web/         Workbench UI consuming the canonical protocol
```

## Runtime layering

- `RuntimeEngine` owns the shared session store, event bus, and PTY hub.
- `ProviderAdapter` is the seam where concrete providers plug into the runtime.
- `ProviderActivity` is the adapter-facing normalization layer.
- `CodexAdapter` remains the reference-standard adapter.
- `ClaudeAdapter`, `GeminiAdapter`, `KimiAdapter`, and `OpenCodeAdapter` are now real adapters,
  not placeholders.
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

They intentionally do **not** claim that provider authentication is valid. Auth remains managed by
the provider CLI itself.

Current statuses are:

- `ready`
- `missing_binary`
- `launch_error`

## Design boundary

RAH stays close to the proven hapi/paseo product boundary:

- transcript, tool calls, permissions, usage, attention, and session state are core workbench data
- PTY output is secondary infrastructure
- provider-specific maintenance signals should remain adapter-owned or inspector-only

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
- [rah codex 标准交付文档（中文）](./docs/rah-codex-wrapper.zh-CN.md)
- [rah codex handoff 模式设计（中文）](./docs/rah-codex-handoff-mode.zh-CN.md)
- [rah claude handoff 模式设计（中文）](./docs/rah-claude-handoff-mode.zh-CN.md)
- [Session 入口与权限边界（中文）](./docs/session-entry-capability-boundary.zh-CN.md)
- [Terminal Wrapper Live Sessions（中文）](./docs/terminal-wrapper-live-sessions.zh-CN.md)
- [Terminal Wrapper Protocol Draft（中文）](./docs/terminal-wrapper-protocol.zh-CN.md)
- [Protocol Freeze Status](./docs/protocol-freeze-status.md)
- [Release Checklist](./docs/release-checklist.md)
- [UI 回归清单（中文）](./docs/ui-regression-checklist.zh-CN.md)
