# RAH Canonical Event Taxonomy

Status: historical research reference, narrowed for PTY-first

Date: 2026-05-08

RAH previously explored a broad canonical event abstraction across many agent CLIs. The current PTY-first product boundary is narrower:

- Live truth is the daemon-owned real PTY/TUI session.
- Structured Chat/mirror data comes from provider-owned jsonl/db/session history files.
- The current core live providers are Codex, Claude, and OpenCode.
- Gemini CLI and Kimi CLI first-class provider support has been removed; their models are expected to run through OpenCode/API provider configuration when needed.

## Current Event Families

The frontend should consume RAH-level event families instead of provider-specific raw events:

- Session lifecycle: created, attached, detached, exited, archived.
- PTY stream: replay, output, input, resize, exit.
- Provider activity mirror: user message, assistant message, reasoning, tool call, tool result, error, usage.
- Diagnostics: mirror source missing, mirror failed, unsupported provider capability, invalid provider stream.
- Control: control lease, interrupt, close/archive/kill.

## Design Rules

- PTY/TUI output is infrastructure for terminal display, not the source for structured Chat.
- Provider-specific names stay in parser/adapter code or diagnostics.
- Unknown provider activity should be preserved as diagnostics/raw evidence instead of creating unstable frontend branches.
- `origin` such as live/history is metadata and must not participate in canonical item identity.
- Content hash can help compare evidence but must not be the primary identity because repeated user text is valid.

## Current Contract

The code-level contract lives in `packages/runtime-protocol/src/contract.ts`.

The PTY-first runtime should preserve these invariants:

- Replaying the same provider history page must not duplicate Chat items.
- Live mirror followed by history backfill must converge to the same feed.
- Mirror failure must not kill or pause the real TUI.
- Frontend upsert should prefer canonical item identity when present.

## Historical Note

Older revisions of this document referenced Gemini CLI and Kimi CLI internals as research evidence. Those references are no longer part of the current RAH provider surface. Use git history if that research is needed again.
