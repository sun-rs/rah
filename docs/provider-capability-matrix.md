# Provider Capability Matrix

Status: current native runtime scope

Date: 2026-05-19

This document records the capability boundary for the current RAH branch. Gemini CLI has been restored as a `tui_mux` provider with current Gemini JSON history parsing. Kimi CLI first-class provider support remains removed; Kimi-family model usage goes through OpenCode/API provider configuration.

## Core Rule

RAH is a seamless workbench, not a provider session database replacement. The live authority depends on each provider runtime:

- Codex and OpenCode use provider `native_local_server` runtimes. Their structured provider server events are the live source of truth; their official TUI is an attachable client/view for the same provider thread/session.
- Claude and Gemini use the `tui_mux` / `tui_mux_fallback` runtime because they do not expose a stable Codex/OpenCode-style local app-server path for RAH. Their official TUI remains the work surface; provider history parsing is the structured Chat mirror.
- Model, permission, effort, plan, and slash-command controls are optional provider enhancements. They must not block session creation, attach, replay, interrupt, or close.

## Current Provider Matrix

| Provider | Runtime kind | Live authority | Model selection | Variant / effort | Permission / plan |
|---|---|---|---|---|---|
| Codex | `native_local_server` | Codex app-server events/control. RAH pre-creates a thread with `thread/start`, then attaches the official TUI with `codex --remote <endpoint> resume <threadId>`. Do not infer binding from rollout first messages. | Launch-time via Codex app-server `thread/start` when supported. | Launch-time via official app-server fields where supported; runtime changes only when Codex exposes stable server control. | Launch-time via app-server permission profile / sandbox fields; slash commands remain available in the official TUI. |
| Claude | `tui_mux` / `tui_mux_fallback` | Claude Code TUI inside tmux is the work surface. Structured Chat mirrors Claude JSONL/history with best-effort canonical identity. | Launch-time best effort where Claude exposes stable args. Runtime changes should use the TUI. | Optional enhancement only; no fake native local server. | Trust folder and permission prompts are handled in the official TUI. |
| Gemini | `tui_mux` / `tui_mux_fallback` | Gemini CLI TUI inside tmux is the work surface. Structured Chat mirrors `~/.gemini/tmp/**/chats/session-*.json`. Council injects `rah_council` MCP through a temporary system settings file, preserves any existing Gemini system settings, disables Gemini's generic loop detector for the injected Council MCP session, and projects `mcp_rah_council_*` calls back into normal chat history. | Launch-time via `--model`. The catalog first probes `gemini --acp` `session/new` for `models.availableModels`; if ACP is unavailable, not authenticated, or too slow, it falls back to RAH's built-in Gemini list. Runtime changes should use the TUI. | No separate effort/variant control in RAH unless Gemini ACP exposes stable config options. | Launch-time via `--approval-mode`; available modes are read from Gemini ACP `modes.availableModes`, with `gemini --help` / static fallback. |
| OpenCode | `native_local_server` | OpenCode serve/session API events/control. The official TUI attaches with `opencode attach <url> --session <providerSessionId>`. | Launch-time through OpenCode session/create or TUI args. | `variant` / reasoning is provider-specific; pass only when OpenCode exposes stable API/config support. | Launch-time/prelaunch provider config where stable; runtime changes only when OpenCode exposes stable server control. |

### Gemini ACP Probe Caveat

RAH treats Gemini ACP as a capability probe only, not as the live transport. On Gemini CLI `0.42.0`, if the selected Google authentication state is not already usable by `gemini --acp`, the process can enter an interactive OAuth text flow before it replies to JSON-RPC `initialize`. RAH must not block the UI or crash in that state, so normal model-list requests may return the built-in static model list immediately while the authoritative ACP catalog refresh continues in the background. The web client prewarms provider catalogs after startup and polls Gemini's cache so the model picker can upgrade from static to native without blocking user input. Settings manual force-refresh uses the same long Gemini ACP timeout as the background probe and treats only `native` / `authoritative` results as success.

Current built-in Gemini static fallback model ids:

- `gemini-3.1-pro-preview`
- `gemini-3-flash-preview`
- `gemini-3.1-flash-lite-preview`
- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-2.5-flash-lite`
- `gemma-4-31b-it`
- `gemma-4-26b-a4b-it`

This is an accepted temporary limitation. The unresolved work is to make the probe reuse Gemini's authenticated context reliably, without opening an OAuth prompt from the metadata path and without changing the live TUI runtime.

## Removed CLI Providers

Kimi CLI is no longer a first-class RAH provider. RAH does not maintain its live adapter, history-only adapter, diagnostics, smoke tests, or UI provider controls.

Reason:

- Its usage is lower-frequency compared with Codex and Claude.
- Its models can be accessed through OpenCode + API-key / relay providers such as AIHubMix or OpenRouter.
- Keeping every independent CLI in the core matrix expands the maintenance surface for launch args, history parsing, permission semantics, model options, diagnostics, and human QA.

The current provider scope is documented in `docs/provider-scope-codex-claude-opencode.zh-CN.md`.

## Capability Source Ladder

When RAH displays prelaunch controls, sources are ranked:

1. Running official TUI session state, if a stable source exists.
2. Provider native online capability endpoint, if available and cheap.
3. Provider local config/schema.
4. Cached previous runtime data.
5. Static fallback.

Only the provider runtime or provider-native source may be treated as authoritative. Static and cached data are convenience defaults.

## Model Catalog Probe Policy

RAH treats provider model catalogs as prelaunch capability metadata. Catalog probing must never block normal app startup, session creation, Chat input, attach, replay, interrupt, or close.

Runtime behavior:

- Web startup immediately prewarms the four core provider catalogs: Codex, Claude, Gemini, and OpenCode.
- The web client schedules a silent background refresh every 30 minutes. This is a fixed all-provider prewarm loop for Codex, Claude, Gemini, and OpenCode. It is independent from picker TTLs and independent from Settings manual refresh.
- Session Control and Council model pickers use the cached effective catalog. When a picker needs a provider catalog and the last request is older than 5 minutes, the client requests only that provider in the background. This 5 minute TTL is a single-provider, on-demand freshness guard; it does not mean "refresh all providers every 5 minutes".
- Background refresh failures are logged and cooled down; existing cached catalogs remain usable. A failure does not replace a previously successful catalog and does not update the last-success timestamp.
- Gemini is special because the ACP probe can be slow or blocked by authentication. Normal Gemini catalog requests may return static fallback immediately while the authoritative ACP refresh continues in the background. A static/provisional Gemini fallback must not suppress later background probes even while its normal cache TTL window is still active; RAH keeps trying to upgrade it to `native` / `authoritative`.
- Settings manual refresh is a third entry point. It force-refreshes only the selected provider, bypasses the 5 minute picker TTL, continues even if the Settings dialog is closed, and updates the daemon catalog cache plus the web global model store on success. It does not reset or reschedule the independent 30 minute all-provider prewarm loop.

Settings behavior:

- Settings includes a Models tab with one area per core provider.
- The Models tab stacks providers vertically as collapsible rows. The collapsed row shows provider icon/name, effective model count, last successful refresh time, catalog source, and the provider refresh button.
- Expanding a provider shows the current effective model list: provider-probed models plus active manual supplements. The list reuses the same model-row semantics as Session Control / Council pickers, but is read-only inside Settings.
- Manual supplement models are visually marked in every effective model picker/list. If a later native probe returns the same model id, the native entry wins and the manual entry is no longer marked as active in the effective list.
- Each provider has an explicit refresh button. A refresh request continues in the background even if Settings is closed.
- The UI shows the last successful refresh time. Failed probes and static/provisional fallbacks do not count as successful refreshes.
- A successful Settings refresh updates three pieces of state: the Settings last-success timestamp, the daemon-side provider catalog cache and TTL, and the front-end global model catalog store used by Session Control and Council. The 30 minute background refresh timer is not reset by manual refresh.
- Users may manually supplement missing models per provider. Manual supplements are provider-wide, not workspace-scoped. The optional `cwd` on the API is used only to check duplicates against the provider-native catalog for that workspace.
- Users enter model ids and provider-specific option values only. They do not enter backend option key names. RAH maps option values to fixed provider keys:
  - Codex: `model_reasoning_effort` / backend `reasoning_effort`
  - Claude: `effort` / backend `effort`
  - OpenCode: `model_reasoning_variant` / backend `variant`
  - Gemini: no manual option values until Gemini exposes stable effort/variant semantics
- Manual model ids must be unique within a provider. Add is rejected if the id already exists in either the current effective catalog or the manual supplement store.
- Provider-native probe results are the source of truth. If a later native probe returns a model id that was manually supplemented, the native entry wins and the manual entry is shadowed from the effective catalog.
- Users may delete a manual model or delete individual manual option values. Deleting the last option value keeps the manual model selectable without parameters.

## Engineering Boundary

- Provider capability drift must not break native runtime startup.
- Unsupported model/permission/plan controls should disappear or degrade to diagnostics, not fail the session.
- If a provider adds a new slash command, RAH does not need immediate Web UI support; users can access it directly in the official TUI view.
- `thread/loaded/list`-style loaded-session discovery is diagnostic/fallback only. It is not the default Codex binding strategy because shared servers can have concurrent clients.
