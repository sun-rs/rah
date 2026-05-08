# Provider Capability Matrix

Status: current PTY-first scope

Date: 2026-05-08

This document records the capability boundary for the current RAH branch. Older revisions compared Codex, Claude, Gemini, Kimi, and OpenCode. Gemini CLI and Kimi CLI first-class provider support has been removed; Gemini/Kimi-family model usage now goes through OpenCode/API provider configuration.

## Core Rule

RAH is a PTY-first seamless workbench. The official provider TUI is the runtime authority. Model, permission, effort, plan, and slash-command controls are optional enhancements and must not block session creation, attach, replay, interrupt, or close.

## Current Provider Matrix

| Provider | Live authority | Model selection | Variant / effort | Permission / plan |
|---|---|---|---|---|
| Codex | Official Codex TUI in daemon-owned PTY | Launch-time best effort where Codex exposes stable args; runtime changes should use TUI | Optional enhancement only; official TUI remains source of truth | Use official TUI controls such as slash commands and permission UI |
| Claude | Official Claude Code TUI in daemon-owned PTY | Launch-time best effort where Claude exposes stable args; runtime changes should use TUI | Optional enhancement only; official TUI remains source of truth | Trust folder and permission prompts are handled in official TUI |
| OpenCode | Official OpenCode TUI in daemon-owned PTY | Stable native TUI arg is `--model provider/model` | `variant` / reasoning is provider-specific enhancement; ACP/structured path can pass `provider/model/variant`, but PTY TUI launch must not invent unsupported flags | Use OpenCode TUI / provider config |

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

Only the official TUI/runtime or provider-native source may be treated as authoritative. Static and cached data are convenience defaults.

## Engineering Boundary

- Provider capability drift must not break PTY session startup.
- Unsupported model/permission/plan controls should disappear or degrade to diagnostics, not fail the session.
- If a provider adds a new slash command, RAH does not need immediate Web UI support; users can access it directly in the official TUI view.
