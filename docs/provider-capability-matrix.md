# Provider Capability Matrix

Status: current native runtime scope

Date: 2026-05-09

This document records the capability boundary for the current RAH branch. Older revisions compared Codex, Claude, Gemini, Kimi, and OpenCode. Gemini CLI and Kimi CLI first-class provider support has been removed; Gemini/Kimi-family model usage now goes through OpenCode/API provider configuration.

## Core Rule

RAH is a seamless workbench, not a provider session database replacement. The live authority depends on each provider runtime:

- Codex and OpenCode use provider `native_local_server` runtimes. Their structured provider server events are the live source of truth; their official TUI is an attachable client/view for the same provider thread/session.
- Claude uses the `zellij_tui` / `tui_mux_fallback` runtime because Claude Code does not expose a stable Codex/OpenCode-style local app-server. Its official TUI remains the work surface; JSONL/history parsing is the structured Chat mirror.
- Model, permission, effort, plan, and slash-command controls are optional provider enhancements. They must not block session creation, attach, replay, interrupt, or close.

## Current Provider Matrix

| Provider | Runtime kind | Live authority | Model selection | Variant / effort | Permission / plan |
|---|---|---|---|---|---|
| Codex | `native_local_server` | Codex app-server events/control. RAH pre-creates a thread with `thread/start`, then attaches the official TUI with `codex --remote <endpoint> resume <threadId>`. Do not infer binding from rollout first messages. | Launch-time via Codex app-server `thread/start` when supported. | Launch-time via official app-server fields where supported; runtime changes only when Codex exposes stable server control. | Launch-time via app-server permission profile / sandbox fields; slash commands remain available in the official TUI. |
| Claude | `zellij_tui` / `tui_mux_fallback` | Claude Code TUI inside zellij is the work surface. Structured Chat mirrors Claude JSONL/history with best-effort canonical identity. | Launch-time best effort where Claude exposes stable args. Runtime changes should use the TUI. | Optional enhancement only; no fake native local server. | Trust folder and permission prompts are handled in the official TUI. |
| OpenCode | `native_local_server` | OpenCode serve/session API events/control. The official TUI attaches with `opencode attach <url> --session <providerSessionId>`. | Launch-time through OpenCode session/create or TUI args. | `variant` / reasoning is provider-specific; pass only when OpenCode exposes stable API/config support. | Launch-time/prelaunch provider config where stable; runtime changes only when OpenCode exposes stable server control. |

## Removed CLI Providers

Gemini CLI and Kimi CLI are no longer first-class RAH providers. RAH does not maintain their live adapter, history-only adapter, diagnostics, smoke tests, or UI provider controls.

Reason:

- Their usage is lower-frequency compared with Codex and Claude.
- Their models can be accessed through OpenCode + API-key / relay providers such as AIHubMix or OpenRouter.
- Keeping five independent CLIs in the core matrix expands the maintenance surface for launch args, history parsing, permission semantics, model options, diagnostics, and human QA.

The current provider scope is documented in `docs/provider-scope-codex-claude-opencode.zh-CN.md`.

## Capability Source Ladder

When RAH displays prelaunch controls, sources are ranked:

1. Running official TUI session state, if a stable source exists.
2. Provider native online capability endpoint, if available and cheap.
3. Provider local config/schema.
4. Cached previous runtime data.
5. Static fallback.

Only the provider runtime or provider-native source may be treated as authoritative. Static and cached data are convenience defaults.

## Engineering Boundary

- Provider capability drift must not break native runtime startup.
- Unsupported model/permission/plan controls should disappear or degrade to diagnostics, not fail the session.
- If a provider adds a new slash command, RAH does not need immediate Web UI support; users can access it directly in the official TUI view.
- `thread/loaded/list`-style loaded-session discovery is diagnostic/fallback only. It is not the default Codex binding strategy because shared servers can have concurrent clients.
