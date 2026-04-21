# RAH Workbench Boundary

RAH should stay close to the proven hapi/paseo product boundary. The protocol may carry extra
provider facts, but the primary workbench must not grow a new feature for every Codex app-server
method.

## Core Workbench Surface

Core events are what the main UI and future provider adapters should optimize for:

- session/control lifecycle
- turn lifecycle
- transcript timeline
- stable message parts
- tool call lifecycle
- workbench observations
- permissions and questions
- usage/context
- attention
- terminal infrastructure as a secondary surface

This matches the mature app boundary:

- paseo focuses on thread/turn lifecycle, timeline, tool calls, permissions, usage, attention.
- hapi focuses on session sync, message delivery, permission UX, notifications, and isolated terminal.

The code-level list is `RAH_CORE_WORKBENCH_FAMILIES` in
`packages/runtime-protocol/src/contract.ts`.

Attention is intentionally narrow:

- permission prompts create attention
- failed turns create attention
- successful turns do not create attention by default
- transient retries stay as runtime status unless they require user action

## Infrastructure Surface

Infrastructure events are allowed in the protocol so adapters do not lose provider data, but they
should not become first-class UI features by default:

- `operation.*`
- `governance.updated`
- `runtime.status`
- `notification.emitted`
- `host.updated`
- `transport.changed`
- `heartbeat`

These events should feed Inspector, logs, compact banners, or status chips. They should not expand
the main activity feed unless a user-facing workflow proves the need.

## Adapter Rule

For a new provider behavior:

1. If it describes agent work, map it into core events.
2. If it describes host/runtime/provider bookkeeping, map it into infrastructure events.
3. If it is unknown or malformed, map it into `ObservationKind: runtime.invalid_stream` with `raw`.
4. Do not add a new top-level event unless hapi/paseo-style UI cannot express the behavior.

## Codex Boundary

Codex has more app-server events than hapi/paseo expose as primary product features. RAH handles
those without promoting them:

- account/config/windows/realtime setup events are ignored by design unless they block a user
  workflow.
- hooks and auto-approval review map to `operation.*`, not new transcript types.
- dynamic client tool requests are explicit `operation.requested`; unsupported client tools fail
  visibly instead of becoming hidden behavior.
- agent work items still map to transcript/tool/observation/permission.

This keeps Codex useful as the reference adapter without letting Codex-specific breadth define the
RAH product boundary.

## hapi / paseo Lessons

hapi's Codex app-server converter is deliberately narrow:

- It maps task lifecycle, text/reasoning, command execution, file change, diff, token usage, and
  permissions.
- It ignores or drops account/rate-limit updates, compact notices, startup details, warnings,
  MCP startup noise, plan-update noise, and terminal events without a valid turn context.
- It buffers duplicate text/reasoning/command deltas and only promotes stable completed items.
- Its permission adapter handles command approval, file-change approval, and request_user_input;
  everything else is not promoted into the primary session model.

paseo's Codex integration is also centered on the agent stream:

- Tool items are normalized into a fixed `tool_call` shape with detail variants such as shell,
  read, write, edit, search, fetch, sub-agent, plan, and unknown.
- Codex-specific payloads are parsed into those detail variants, not new top-level event families.
- Unsupported or unclear tool detail remains `unknown` with input/output preserved.
- Plan mode and permissions are surfaced as user-facing flow because they affect interaction, not
  because they are Codex-specific.

RAH should follow the same rule:

- Promote only agent work and user interaction into core workbench events.
- Keep provider bookkeeping as infrastructure events or raw inspector data.
- Do not let Codex-only maintenance APIs define new product-level concepts.
