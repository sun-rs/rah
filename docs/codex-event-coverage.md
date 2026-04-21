# Codex Adapter Event Coverage

This document tracks the Codex reference adapter against the local Codex app-server v2 protocol.
The source of truth is:

- `/Users/sun/lab/crates/ai/codex/codex-rs/app-server-protocol/src/protocol/common.rs`
- `/Users/sun/lab/crates/ai/codex/codex-rs/app-server-protocol/src/protocol/v2.rs`

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

## Server Notifications

Covered in `CODEX_APP_SERVER_NOTIFICATION_METHODS` and
`translateCodexAppServerNotification`.

| Codex method | RAH mapping |
| --- | --- |
| `error` | `turn.failed` or `runtime.status: retrying` |
| `thread/started` | `runtime.status: session_active` |
| `thread/status/changed` | `session.state.changed` |
| `thread/archived` | ignored by design |
| `thread/unarchived` | ignored by design |
| `thread/closed` | `session.exited` |
| `skills/changed` | ignored by design |
| `thread/name/updated` | ignored by design |
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
| `item/commandExecution/outputDelta` | `observation.updated` + `tool.call.delta` + `terminal.output` |
| `command/exec/outputDelta` | ignored by design |
| `item/commandExecution/terminalInteraction` | ignored by design |
| `item/fileChange/outputDelta` | `observation.updated: patch.apply` + `tool.call.delta` |
| `serverRequest/resolved` | ignored by design |
| `item/mcpToolCall/progress` | `observation.updated: mcp.call` + `tool.call.delta` |
| `mcpServer/oauthLogin/completed` | ignored by design |
| `mcpServer/startupStatus/updated` | ignored by design |
| `account/updated` | ignored by design |
| `account/rateLimits/updated` | ignored by design |
| `account/login/completed` | ignored by design |
| `app/list/updated` | ignored by design |
| `fs/changed` | ignored by design |
| `thread/compacted` | `timeline.item.added: compaction` |
| `model/rerouted` | ignored by design |
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
| `applyPatchApproval` | `permission.requested: tool` | legacy compatibility |
| `execCommandApproval` | `permission.requested: tool` | legacy compatibility |

## Tests

- `codex-app-server-activity.test.ts` asserts every known notification method either maps or is
  deliberately ignored without `runtime.invalid_stream`.
- `codex-live-client.test.ts` asserts request/response round trips for user input, MCP
  elicitation, and dynamic client tool requests.
- `rah-event-contract.test.ts` asserts translated Codex events pass `validateRahEventSequence`.

Current status: Codex is the reference adapter for RAH event conformance. Future Codex drift should
change this adapter and its fixtures first; protocol changes require evidence that `other`,
`unknown`, `runtime.invalid_stream`, and `raw` cannot safely represent the new behavior.
