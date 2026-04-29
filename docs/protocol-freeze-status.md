# RAH Protocol Freeze Status

This document tracks what should be considered frozen for the first stable RAH protocol boundary,
and what remains intentionally adapter-owned or product-owned.

## 1.0 Scope

RAH 1.0 should be read as:

- stable canonical event taxonomy
- stable provider adapter seam
- stable structured workbench behavior across history replay, claim, and live upgrade

RAH 1.0 should **not** be read as:

- guaranteed provider authentication preflight
- guaranteed provider account access detection
- guaranteed PTY host-takeover parity with Codex TUI

Provider authentication remains provider-managed. RAH may expose diagnostics such as binary path,
version probe, and launch status, but those do not prove account availability.

## Freeze Candidate: Stable

These areas are strong enough to treat as v1 freeze candidates unless a concrete provider behavior
proves they are insufficient.

### Event Envelope

- `id`, `seq`, `ts`, `sessionId`, `type`, `source`
- optional `turnId`
- optional `raw`

### Family Boundary

Core workbench families:

- `session`
- `control`
- `turn`
- `timeline`
- `message_part`
- `tool_call`
- `observation`
- `permission`
- `usage`
- `attention`
- `terminal`

Infrastructure families:

- `operation`
- `governance`
- `runtime`
- `notification`
- `host`
- `transport`
- `heartbeat`

### Canonical Fallback Rules

- unknown tool -> `ToolFamily: other`
- unknown workbench activity -> `ObservationKind: unknown`
- malformed/new provider stream item -> `ObservationKind: runtime.invalid_stream`
- heuristic fallback must retain `raw`
- `runtime.invalid_stream` must remain `source.authority: heuristic`

### Lifecycle Invariants

- turn lifecycle must be monotonic in `seq`
- tool terminal events warn when no start was observed
- observation terminal events warn when no start was observed
- permission resolution warns when no request was observed
- if start and terminal events both carry `turnId`, those `turnId`s must agree

### Codex Capability Semantics

Live Codex sessions:

- `steerInput: true`
- `livePermissions: true`
- `resumeByProvider: true`
- `listProviderSessions: true`

Rehydrated Codex sessions:

- `steerInput: false`
- `livePermissions: false`
- `resumeByProvider: true`
- `listProviderSessions: true`

This boundary is intentional: replayed history remains inspectable, but live interaction requires a
live Codex thread.

### Adapter Capability Semantics

The following surfaces are now stable enough to treat as adapter protocol commitments:

- `StartSessionRequest.modeId`
- `ResumeSessionRequest.modeId`
- `ProviderModelCatalog.defaultModeId`
- `ProviderModelCatalog.modes`
- `SessionModeDescriptor.role`
- `SessionModeDescriptor.applyTiming`
- `ProviderAdapter.renameSession`
- `ProviderAdapter.setSessionMode`
- `ProviderAdapter.listModels`
- `ProviderAdapter.setSessionModel`

Frontend code may render `role`, `label`, and `description`, but it must not interpret provider
mode ids. Provider-native translation remains adapter-owned.

## Not Frozen Yet

These areas should remain changeable without calling the protocol unstable:

### Tool Detail Rendering

- how artifacts are grouped in the UI
- compact/full card layouts
- diff styling
- MCP result presentation

### Product Copy

- user-facing error text
- read-only replay wording
- reconnect wording
- inspector labels
- provider diagnostic wording
- exact mode button labels, as long as `SessionModeDescriptor.role` semantics remain stable

### Provider Diagnostics

- how provider status is shown in the UI
- whether a probe is labeled `ready`, `missing_binary`, or `launch_error`
- version string formatting
- any future binary-path or runtime detail formatting

These are product-facing diagnostics, not protocol guarantees of auth or quota.

### PTY Host Takeover

- bidirectional PTY bridging for Codex
- terminal-first takeover semantics
- terminal replay durability beyond the current structured workbench boundary

### Terminal Wrapper Live Sessions

- wrapper <-> daemon control channel
- operator-group level control semantics
- surface identity and focus semantics
- prompt-boundary aware queued input
- any future `rah codex` / `rah claude` wrapper protocol

### Adapter Internals

- provider-native parsing logic
- fixture corpus breadth
- ignored method list, as long as it still respects the documented boundary

## Provider Drift Response

When a provider changes:

- streaming item structure
- tool event structure
- permission payload structure
- persisted history layout

RAH should respond in this order:

1. update the provider translator
2. update provider-specific fixtures or raw corpora
3. update provider smoke if the product behavior changed
4. only change the canonical protocol if the existing fallback buckets are truly insufficient

In other words:

- adapter drift should usually be absorbed by the adapter
- protocol changes require stronger evidence

## Browser Smoke Rule

Browser smoke should validate:

- visible replay/live semantics
- user turn counts
- assistant response presence
- tool call presence
- file side effects
- no internal environment leakage

Browser smoke should avoid overfitting to:

- one historical session title
- one exact assistant wording
- one provider-specific transcript phrasing

Prefer checking:

- `matchingUserEventCount`
- `matchingAssistantEventCount`
- visible turn counts before/after claim
- tool names / tool ids
- resulting file contents

over checking one specific sentence unless that sentence is the real product contract.

## Protocol Change Bar

A protocol change should require all of the following:

1. Evidence from real provider behavior, not preference.
2. Proof that existing fallback buckets (`other`, `unknown`, `runtime.invalid_stream`, `raw`) are
   insufficient.
3. Evidence that hapi/paseo-style UI cannot express the behavior without a new top-level concept.
4. Updates to:
   - `packages/runtime-protocol/src/contract.ts`
   - `docs/canonical-event-taxonomy.md`
   - `docs/workbench-boundary.md`
   - Codex conformance tests and fixtures

If those conditions are not met, adapt the provider translator instead of the protocol.
