# Codex Adapter Event Coverage

This document tracks the Codex reference adapter against the local Codex app-server v2 protocol.
The source of truth is:

- `/Users/sun/Library/Mobile Documents/com~apple~CloudDocs/Lab/crates/AI/codex/codex-rs/app-server-protocol/src/protocol/common.rs`
- `/Users/sun/Library/Mobile Documents/com~apple~CloudDocs/Lab/crates/AI/codex/codex-rs/app-server-protocol/src/protocol/v2`

The goal is not to mirror Codex method names into RAH. The goal is to prove each known Codex
method maps into an existing RAH family or an explicit fallback without changing the protocol.

## Policy

- Agent transcript and work events map to `timeline.*`, `message.part.*`, `tool.call.*`,
  `observation.*`, and `permission.*`.
- Runtime/provider state maps to `session.*`, `runtime.status`, `operation.*`,
  `notification.emitted`, or `transport.changed`.
- Known edge methods that hapi/paseo do not promote are deliberately ignored.
- Unknown future methods map to `ObservationKind: runtime.invalid_stream` with `raw`.
- Known Codex methods should not use `runtime.invalid_stream`.
- Tests must keep the official method list and the adapter fixture list in sync.
- Heuristic Codex fallback events must preserve `raw`, and `runtime.invalid_stream` must stay
  `source.authority: heuristic`.
- When a Codex tool or permission lifecycle has both start and terminal events with `turnId`, the
  `turnId` must remain stable across that lifecycle.

## Codex App-Server Compatibility

RAH treats the Codex app-server protocol as provider-owned and version-drifting. Current compatibility
rules:

- `codex app-server --stdio` is the default transport. `RAH_CODEX_APP_SERVER_TRANSPORT=websocket`
  remains an explicit override for older/debug flows.
- `thread/start` only sends current app-server params. RAH no longer sends legacy
  `experimentalRawEvents`, `persistExtendedHistory`, or `name`; requested titles are applied with
  `thread/name/set` after the thread id is returned.
- `thread/resume` no longer sends `excludeTurns`. Live history replay suppression is owned by RAH's
  replay/live-upgrade path, not an old Codex request field.
- Codex `sessions` and `archived_sessions` are both scanned. Entries under `archived_sessions` are
  marked as `StoredSessionRef.providerState.archived`.
- Live resume of an archived Codex entry first attempts `thread/unarchive`, then performs
  `thread/resume`. If unarchive is rejected, the normal resume error/fallback path remains the
  authority.
- `ThreadStartResponse` / `ThreadResumeResponse` fields are normalized across old and new shapes:
  `approval_policy` or `approvalPolicy`, string `sandbox` or object `SandboxPolicy`.
- Codex `--profile` is treated as a config-file selector, not as RAH's session mode primitive.
  RAH structured sessions continue to send app-server `approvalPolicy` / `sandbox`, and native TUI
  launch still uses the Codex CLI compatibility flags while the current CLI accepts them.

## Server Notifications

Covered in `CODEX_APP_SERVER_NOTIFICATION_METHODS` and
`translateCodexAppServerNotification`.

| Codex method | RAH mapping |
| --- | --- |
| `error` | `turn.failed` or `runtime.status: retrying` |
| `thread/started` | `runtime.status: session_active` |
| `thread/status/changed` | `session.state.changed` |
| `thread/archived` | ignored by design |
| `thread/deleted` | `session.exited` |
| `thread/unarchived` | ignored by design |
| `thread/closed` | `session.exited` |
| `skills/changed` | ignored by design |
| `thread/name/updated` | ignored by design |
| `thread/goal/updated` | ignored by design |
| `thread/goal/cleared` | ignored by design |
| `thread/settings/updated` | ignored by design |
| `thread/tokenUsage/updated` | `usage.updated` + `context.updated` |
| `turn/started` | `turn.started` |
| `turn/completed` | `turn.completed`, `turn.failed`, or `turn.canceled` |
| `hook/started` | `operation.started` |
| `hook/completed` | `operation.resolved` |
| `turn/diff/updated` | `observation.updated: patch.apply` |
| `turn/plan/updated` | `timeline.item.added: plan` |
| `item/started` | item-specific `message.part.*`, `tool.call.*`, `observation.*`, or `operation.*` |
| `item/completed` | item-specific terminal `message.part.*`, `tool.call.*`, `observation.*`, or `operation.*` |
| `item/autoApprovalReview/started` | `operation.started: governance` |
| `item/autoApprovalReview/completed` | `operation.resolved: governance` |
| `rawResponseItem/completed` | ignored by design |
| `item/agentMessage/delta` | `message.part.delta` + `timeline.item.added: assistant_message` |
| `item/plan/delta` | `message.part.delta: step` |
| `item/reasoning/summaryTextDelta` | `message.part.delta: reasoning` + `timeline.item.added: reasoning` |
| `item/reasoning/summaryPartAdded` | `message.part.added: reasoning` |
| `item/reasoning/textDelta` | `message.part.delta: reasoning` + `timeline.item.added: reasoning` |
| `process/outputDelta` | ignored by design |
| `process/exited` | ignored by design |
| `item/commandExecution/outputDelta` | `observation.updated` + `tool.call.delta` + `terminal.output` |
| `command/exec/outputDelta` | ignored by design |
| `item/commandExecution/terminalInteraction` | ignored by design |
| `item/fileChange/outputDelta` | `observation.updated: patch.apply` + `tool.call.delta` |
| `item/fileChange/patchUpdated` | ignored by design |
| `serverRequest/resolved` | ignored by design |
| `item/mcpToolCall/progress` | `observation.updated: mcp.call` + `tool.call.delta` |
| `mcpServer/oauthLogin/completed` | ignored by design |
| `mcpServer/startupStatus/updated` | ignored by design |
| `account/updated` | ignored by design |
| `account/rateLimits/updated` | ignored by design |
| `account/login/completed` | ignored by design |
| `app/list/updated` | ignored by design |
| `remoteControl/status/changed` | ignored by design |
| `externalAgentConfig/import/progress` | ignored by design |
| `externalAgentConfig/import/completed` | ignored by design |
| `fs/changed` | ignored by design |
| `thread/compacted` | `timeline.item.added: compaction` |
| `model/rerouted` | ignored by design |
| `model/verification` | ignored by design |
| `turn/moderationMetadata` | ignored by design |
| `model/safetyBuffering/updated` | ignored by design |
| `warning` | `notification.emitted: warning` |
| `guardianWarning` | `notification.emitted: warning` |
| `deprecationNotice` | ignored by design |
| `configWarning` | ignored by design |
| `fuzzyFileSearch/sessionUpdated` | ignored by design |
| `fuzzyFileSearch/sessionCompleted` | ignored by design |
| `thread/realtime/started` | ignored by design |
| `thread/realtime/itemAdded` | ignored by design |
| `thread/realtime/transcript/delta` | ignored by design |
| `thread/realtime/transcript/done` | ignored by design |
| `thread/realtime/outputAudio/delta` | ignored by design |
| `thread/realtime/sdp` | ignored by design |
| `thread/realtime/error` | ignored by design |
| `thread/realtime/closed` | ignored by design |
| `windows/worldWritableWarning` | ignored by design |
| `windowsSandbox/setupCompleted` | ignored by design |

## Server Requests

Covered in `CODEX_APP_SERVER_REQUEST_METHODS` and `handleCodexLiveRequest`.

| Codex method | RAH mapping | Response behavior |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | `permission.requested: tool` | resolves to Codex command approval decision |
| `item/fileChange/requestApproval` | `permission.requested: tool` | resolves to Codex file-change approval decision |
| `item/permissions/requestApproval` | `permission.requested: mode` | returns granted requested permissions on allow, empty grant on deny |
| `item/tool/requestUserInput` | `tool.call.started` + `permission.requested: question` | returns selected answers |
| `mcpServer/elicitation/request` | `permission.requested: question` | returns MCP accept/decline with content |
| `item/tool/call` | `operation.requested` + `tool.call.failed` | returns explicit unsupported failure |
| `account/chatgptAuthTokens/refresh` | `operation.requested` | returns JSON-RPC error; RAH does not manage host auth tokens |
| `attestation/generate` | `operation.requested` | returns JSON-RPC error; RAH does not mint Codex client attestation tokens |
| `applyPatchApproval` | `permission.requested: tool` | legacy compatibility |
| `execCommandApproval` | `permission.requested: tool` | legacy compatibility |

## Tests

- `codex-app-server-activity.test.ts` asserts every known notification method either maps or is
  deliberately ignored without `runtime.invalid_stream`.
- `codex-adapter.test.ts` asserts archived Codex sessions are unarchived before live resume, and
  new threads are started without legacy app-server params.
- `codex-live-client.test.ts` asserts request/response round trips for user input, MCP
  elicitation, dynamic client tool requests, and unsupported client attestation requests.
- `rah-event-contract.test.ts` asserts translated Codex events pass `validateRahEventSequence`.

Current status: Codex is the reference adapter for RAH event conformance. Future Codex drift should
change this adapter and its fixtures first; protocol changes require evidence that `other`,
`unknown`, `runtime.invalid_stream`, and `raw` cannot safely represent the new behavior.
