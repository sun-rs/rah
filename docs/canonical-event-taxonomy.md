# RAH Canonical Event Taxonomy

Status: current event-ledger contract; Conversation read model is defined separately

Date: 2026-07-10

## Purpose

`RahEvent` is RAH's append-only transport and evidence contract. Provider adapters translate native live or persisted evidence into these event families so Web/PWA clients do not parse provider payloads directly.

It is intentionally not the final conversation view model. Turn grouping, process/final separation, duration, and activity summaries belong to the daemon-owned Conversation projection.

## Event Families

- Session lifecycle: create, start, attach, detach, close, exit, failure.
- Control: claim/release and provider-native interrupt/stop outcomes.
- Turn lifecycle: start, complete, fail, cancel, step, appended input.
- Timeline: user, assistant commentary/final, reasoning, plan, compaction, notices.
- Message parts: add, update, delta, remove.
- Tools and observations: command, test, build, file, patch, web, MCP, subagent.
- Permission and governance: request, resolution, policy updates.
- Usage and runtime status.
- PTY stream: output and exit for the TUI surface.
- Diagnostics and transport state.

## Identity Rules

- Provider-native `(session, turn, item)` identity is preferred.
- `origin` (`live` or `history`) never participates in canonical item identity.
- Content hashes are comparison evidence, not primary identity; repeated text is valid.
- The same canonical item is upserted across started/delta/completed and live/history evidence.
- A main turn is terminal only after its own terminal lifecycle event; a subagent item cannot finish it.

## Authority Rules

- `structured_live + authoritative`: provider server lifecycle/result facts.
- `structured_persisted + authoritative`: provider-owned persisted facts.
- `derived`: lossless or strongly grounded canonical translation.
- `heuristic`: explicitly low-confidence evidence derivation when native semantics are absent;
  it never selects an alternate client protocol or renderer.
- `pty`: terminal display only, never a structured Chat parser source.

Unknown provider evidence is retained as diagnostics when it can affect correctness. Internal maintenance noise should be normalized in the adapter rather than surfaced as ordinary chat.

## Separation From Conversation

The event ledger answers: "What evidence arrived, in what order?"

The Conversation projection answers: "What is the current canonical thread/turn/item state, and how should a client page it?"

See:

- [Conversation Architecture](./conversation-architecture.zh-CN.md)
- [Conversation Gap Analysis](./conversation-architecture-audit.zh-CN.md)
- [Codex App Server Protocol Map](./codex-app-server-protocol-map.zh-CN.md)
