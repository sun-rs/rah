# RAH

Runtime-owned AI workbench for local-first, cross-device session continuity.

## Current status

RAH is now centered on four main lines:

- canonical protocol and contract validation
- runtime daemon with provider adapter seam
- real provider adapters (`codex`, `claude`, `gemini`, `kimi`)
- same-origin workbench with stored history, replay, claim, and live upgrade

The workbench is served through the daemon itself. The stable entry is:

- `http://127.0.0.1:43111/`

The Vite server remains a development-only entry:

- `http://127.0.0.1:43112/`

## Quick start

Install dependencies:

```bash
npm install
```

Build the web client and serve the unified same-origin workbench:

```bash
npm run serve:workbench
```

Open:

```text
http://127.0.0.1:43111/
```

For local development with split services:

```bash
npm run dev:daemon
npm run dev:web
```

## Workspace scripts

```bash
npm run build:web
npm run serve:workbench
npm run typecheck
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
```

## Test tiers

RAH now uses three test tiers:

- default gate
  - `npm run typecheck`
  - `npm run test:web`
  - `npm run test:runtime`
- provider smoke
  - `history-claim`
  - `tool-flow`
  - `gemini-flow`
  - `gemini-browser`
  - `kimi-flow`
  - `kimi-browser`
  - `claude-flow`
  - `claude-browser`
- release/CI gate
  - provider smoke should run only in an environment where the matching provider CLI and account
    are already configured
  - provider smoke should be selected per provider, not treated as one universal gate for every
    machine

Provider smoke is intentionally **not** treated as a universal local gate. Installed CLI binaries do
not prove authentication, quota, or account access.

RAH intentionally does **not** define one mandatory "run every provider smoke everywhere" command.
Different machines may have:

- only some provider CLIs installed
- valid binaries but missing login/auth
- valid auth for one provider but not another

For that reason, provider smoke should be run explicitly per provider in a known-good environment.

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
- `ClaudeAdapter`, `GeminiAdapter`, and `KimiAdapter` are now real adapters, not placeholders.
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

Start here for the complete project description in Chinese:

- [项目总览（中文）](./docs/project-overview.zh-CN.md)

Core design and freeze documents:

- [RAH Canonical Event Taxonomy](./docs/canonical-event-taxonomy.md)
- [RAH Workbench Boundary](./docs/workbench-boundary.md)
- [Codex Adapter Event Coverage](./docs/codex-event-coverage.md)
- [Provider Adapter Maintenance](./docs/provider-adapter-maintenance.md)
- [Architecture Benchmark (中文)](./docs/architecture-benchmark.zh-CN.md)
- [Terminal Wrapper Live Sessions（中文）](./docs/terminal-wrapper-live-sessions.zh-CN.md)
- [Terminal Wrapper Protocol Draft（中文）](./docs/terminal-wrapper-protocol.zh-CN.md)
- [Protocol Freeze Status](./docs/protocol-freeze-status.md)
- [Release Checklist](./docs/release-checklist.md)
- [UI 回归清单（中文）](./docs/ui-regression-checklist.zh-CN.md)
