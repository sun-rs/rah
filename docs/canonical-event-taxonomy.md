# RAH Canonical Event Taxonomy

This document defines RAH's own event abstraction. Provider and app source code is evidence, not
the protocol shape. The goal is to capture behavior from Codex, Claude Code, Gemini CLI, Kimi CLI,
and OpenCode without leaking their internal event names into the frontend.

## Evidence Sources

Official CLI/provider sources used as behavioral evidence:

- `codex`: app-server v2 notifications, server requests, rollout JSONL.
- `claude code`: observed through `paseo`, `hapi`, and `claudecodeui` adapters/UI state.
- `gemini-cli`: message bus, tool scheduler, ask-user, policy, and subagent events.
- `kimi-cli`: Wire protocol, approvals, questions, plan display, hooks, subagents, status.
- `opencode`: session/message/part sync events and message part taxonomy.

Mature app libraries used as abstraction references:

- `paseo`: strongest canonical agent stream and tool detail abstraction.
- `hapi`: strongest session sync, permission UX, and terminal isolation patterns.
- `AionUi`: useful ACP/OpenClaw/aionrs normalization examples.
- `remodex`: useful Codex rollout live mirror and mobile attention examples.

The protocol below is not a union of those names. It is the RAH vocabulary that adapters map into.

## Design Rules

- Provider-specific names stay in adapter translators and optional `raw`.
- Frontend components consume RAH event families only.
- Terminal/PTY data is infrastructure, not the primary workbench timeline.
- High-level observations answer "what work did the agent do?" without parsing shell text in the UI.
- Stable provider message parts are preserved when available, but timeline text remains provider-neutral.
- New provider behavior should first map to existing families, `ToolFamily: other`,
  `ObservationKind: unknown`, `ObservationKind: runtime.invalid_stream`, and envelope `raw`.
  Changing the protocol is the last resort, not the adapter default.

## Contract Rules

The code-level contract lives in `packages/runtime-protocol/src/contract.ts`.
The product boundary is documented in `docs/workbench-boundary.md`.

The stable contract has three layers:

- Event envelope: every event has `id`, `seq`, `ts`, `sessionId`, `type`, `source`, `payload`,
  and optional `turnId`/`raw`.
- Canonical payload: provider actions must normalize into RAH families, not provider-specific
  frontend branches.
- Sequence invariants: turn/tool/observation/permission lifecycles are validated so an adapter
  cannot silently emit impossible state.

Sequence invariants are intentionally narrow but strict:

- if a tool, observation, or permission lifecycle has both start and terminal events with `turnId`,
  those `turnId`s must agree.
- when `requireTurnScopedWork` is enabled for live-stream validation, workbench events should not
  point at closed or unknown turns.
- session payloads, session capability flags, control payloads, runtime status payloads, and usage
  payloads are part of the canonical contract, not loose adapter metadata.

Adapters must preserve raw evidence when they infer behavior:

- `source.authority: authoritative` means the provider explicitly emitted that semantic fact.
- `source.authority: derived` means RAH projected a provider fact into a higher-level family.
- `source.authority: heuristic` means RAH guessed or could not fully classify the provider data;
  those events must retain `raw`.
- `ObservationKind: runtime.invalid_stream` is stricter than generic fallback: it must remain
  `heuristic` and must retain `raw`, because it represents provider evidence RAH could not safely
  normalize.

Future CLI drift should be absorbed in adapters:

- Unknown tool names become `ToolFamily: other` with `providerToolName` preserved.
- Unknown workbench activity becomes `ObservationKind: unknown`.
- Unknown, malformed, or newly introduced stream messages become
  `ObservationKind: runtime.invalid_stream`.
- Provider-specific detail stays in `raw` or generic artifacts, not in new top-level event names.

## Canonical Families

### Workspace, Host, And Session

- `session.created`: RAH created a managed session.
- `session.started`: provider runtime is ready.
- `session.attached`: a client attached.
- `session.detached`: a client detached.
- `session.state.changed`: runtime state changed.
- `session.exited`: backing runtime exited.
- `session.failed`: runtime failed.
- `host.updated`: host/machine metadata changed.
- `transport.changed`: control transport state changed.
- `heartbeat`: liveness signal.

Provider evidence:

- Codex `thread/started`, hapi `session-added/session-updated`, OpenCode `session.created/updated`,
  Gemini host message bus state, Kimi session state, Remodex relay/session state.

### Control And Turn Lifecycle

- `control.claimed`: input control granted.
- `control.released`: input control released.
- `turn.started`: user/agent turn started.
- `turn.completed`: turn finished successfully.
- `turn.failed`: turn failed with diagnostic.
- `turn.canceled`: turn interrupted/canceled.
- `turn.step.started`: a provider step began.
- `turn.step.completed`: a provider step finished.
- `turn.step.interrupted`: a provider step was interrupted.
- `turn.input.appended`: user injected steering/follow-up input into a running turn.

Provider evidence:

- Codex `turn/started/completed`, Kimi `TurnBegin/TurnEnd/StepBegin/StepInterrupted/SteerInput`,
  Gemini turn activity monitor, Claude Code stream lifecycle, OpenCode step-start/step-finish.

### Transcript And Message Parts

- `timeline.item.added`: user/assistant/reasoning/plan/todo/system/error/compaction/retry/step/attachment.
- `timeline.item.updated`: mutable timeline item changed.
- `message.part.added`: stable message part appeared.
- `message.part.updated`: stable message part changed.
- `message.part.delta`: stable message part streamed a delta.
- `message.part.removed`: stable message part was removed.

Provider evidence:

- Codex agent/user/reasoning deltas, Claude Code text/thinking/tool_use/tool_result,
  Kimi `ContentPart`, OpenCode `message.part.*`, AionUi `content/thought`, claudecodeui
  `stream_delta/thinking`.

### Tool Calls

- `tool.call.started`: provider requested or started a tool.
- `tool.call.delta`: tool call streamed more detail.
- `tool.call.completed`: tool finished successfully.
- `tool.call.failed`: tool failed.

Canonical `ToolFamily` should be broad but not provider-named:

- shell, test, build, lint
- file_read, file_write, file_edit, patch
- search, fetch, web_search, web_fetch
- mcp, subagent, git, worktree
- plan, todo, memory, browser, notebook, voice
- automation, external, governance, elicitation, media, preview, other

Provider evidence:

- Paseo `ToolCallDetail`, Gemini `CoreToolCallStatus` and confirmation bus, Kimi `ToolCall`,
  `ToolCallPart`, `ToolResult`, Codex command/file/MCP/patch notifications, OpenCode tool parts,
  AionUi ACP `tool_call` and `tool_group`.

### Observations

`observation.*` is RAH's workbench-facing interpretation layer over tools and provider internals:

- `observation.started`
- `observation.updated`
- `observation.completed`
- `observation.failed`

Canonical observation kinds:

- file.read, file.list, file.search, file.write, file.edit
- patch.apply
- command.run, test.run, build.run, lint.run
- git.status, git.diff, git.apply
- web.search, web.fetch
- mcp.call
- subagent.lifecycle
- workspace.scan, worktree.setup
- plan.update, todo.update
- permission.change, governance.update
- automation.run, external action work
- turn.input, question.side
- content.part, media.read
- runtime.retry, runtime.invalid_stream
- session.discovery
- terminal.interaction
- unknown

Provider evidence:

- Codex shell commands and rollouts, Kimi display blocks/hooks/subagents, Gemini scheduler states,
  OpenCode message parts, AionUi ACP/OpenClaw tool updates, Paseo tool detail parser.

### Elicitation And Permissions

- `permission.requested`: tool/plan/question/mode/other approval or elicitation.
- `permission.resolved`: user/system answered or denied.

This family covers:

- tool approval
- plan approval
- structured questions
- mode/policy changes
- provider-specific "allow once/session/deny" decisions via generic actions

Provider evidence:

- Codex app-server approvals and `request_user_input`, Kimi `ApprovalRequest/QuestionRequest`,
  Gemini confirmation and ask-user bus, Claude Code permission prompt, AionUi `acp_permission`,
  hapi permission notification and UI.

### Runtime Operations And Governance

- `operation.started`: host/runtime automation began.
- `operation.resolved`: host/runtime automation completed.
- `operation.requested`: runtime asks the client to perform an operation.
- `governance.updated`: permission/tool/runtime policy changed.
- `runtime.status`: provider/transport state such as connecting, session_active, thinking, retrying.

This absorbs provider concepts such as:

- Kimi hooks
- Gemini policy updates
- AionUi connection/session status
- Claude/Gemini/Kimi external tool requests
- background task lifecycle

These are not primary transcript events unless an adapter also projects them as observations.

### Usage, Attention, And Notifications

- `usage.updated`: token/cost usage changed.
- `context.updated`: context window usage changed.
- `attention.required`: workbench needs user attention.
- `attention.cleared`: attention resolved.
- `notification.emitted`: push/toast-style notification.

Provider evidence:

- Codex token usage, Kimi `StatusUpdate`, hapi toasts/notification hub, Remodex completion/error
  push, claudecodeui task notifications.

### Terminal Infrastructure

- `terminal.output`: PTY/display stream output.
- `terminal.exited`: PTY/display stream exit.

Use this only for true terminal surfaces. The main RAH workbench should prefer `tool.call.*` and
`observation.*`.

## Adapter Mapping Guidance

Every adapter should have fixture-based conformance tests:

- Input: provider-native stream messages, server requests, rollout/history records, or scheduler
  events.
- Output: canonical RAH events that pass `validateRahEventSequence`.
- Required coverage: lifecycle, transcript/message parts, tool calls, observations, permissions,
  usage/context, errors, and unknown fallback.
- Reference implementation: Codex live app-server + persisted rollout translation.
- Codex coverage matrix: `docs/codex-event-coverage.md`.

### Codex

- app-server and rollout commands -> `tool.call.*` + `observation.*`.
- command/file/MCP/patch approvals -> `permission.*`.
- text/reasoning/plan deltas -> `timeline.item.*` or `message.part.*` when stable ids exist.
- token usage -> `usage.updated` + `context.updated`.

### Claude Code

- text and thinking -> transcript/timeline.
- tool use/result -> tool + observation.
- permission prompt -> permission.
- status/task notifications -> runtime/attention/notification.

### Gemini CLI

- scheduler tool states -> tool + observation.
- confirmation/ask-user -> permission.
- policy update -> governance.
- subagent activity -> observation + reasoning timeline when useful.

### Kimi CLI

- Wire turn/step/content/tool/result -> lifecycle/transcript/tool.
- approvals/questions -> permission.
- plan display -> timeline plan + observation.
- hooks -> operation + optional observation.
- steer/btw -> turn input or side question.

### OpenCode

- session events -> session.
- message and part events -> message.part and timeline.
- tool parts -> tool + observation.
- patch/snapshot/retry/subtask parts -> timeline/observation as appropriate.

### AionUi / Remodex / Hapi / Paseo

Use these as implementation references:

- AionUi: ACP/OpenClaw stream normalization and plan/tool/permission conversion.
- Remodex: Codex rollout live mirror and mobile attention.
- Hapi: sync and permission UX.
- Paseo: canonical agent stream/tool detail shape.
