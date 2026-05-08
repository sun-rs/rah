# Provider Adapter Maintenance

This document records the current adapter coverage for the non-Codex providers and the practical
rules RAH now follows when provider-native streams drift.

It is intentionally operational rather than aspirational.

## 1. Core Principle

When a provider changes:

- streaming item structure
- tool event shape
- permission payloads
- stored history layout

RAH should respond in this order:

1. adjust the provider translator
2. update provider-specific fixtures or corpus-backed tests
3. update provider smoke only if product-visible behavior changed
4. only then consider a canonical protocol change

This keeps adapter drift adapter-owned.

The canonical protocol should not change just because one provider added one new raw event.

Adapter-owned also means provider modes, model parameters, rename semantics, and stored-history
metadata recovery should not leak into `client-web`. The UI may render `SessionModeDescriptor.role`
and `SessionModeDescriptor.applyTiming`, then submit `modeId`, but only the adapter may interpret
the provider-native mode id or decide whether applying it means immediate, next-turn, idle-only,
restart-required, or startup-only behavior.

## 2. Browser Smoke Principle

Browser smoke should validate:

- history replay opens correctly
- claim upgrades replay in place
- old turns are not replayed again
- new user turn count is correct
- assistant response exists
- tool calls exist when required
- resulting file side effects are correct
- internal bootstrap content does not leak into the main chat UI

Browser smoke should avoid overfitting to:

- one exact assistant sentence
- one historical conversation title
- one specific wording that is not a product contract

Prefer assertions such as:

- `matchingUserEventCount`
- `matchingAssistantEventCount`
- `oldTurnCountBeforeClaim == oldTurnCountAfterClaim`
- tool names / tool ids
- final file contents

over hard-coding one exact reply unless that exact reply is the actual feature contract.

## 3. Removed Gemini/Kimi CLI Coverage

Gemini CLI and Kimi CLI first-class provider code has been removed from runtime, client, scripts,
diagnostics, and default tests. New Gemini/Kimi-family live work should go through OpenCode/API
provider configuration.

The rationale and OpenCode variant boundary are recorded in
[`provider-scope-codex-claude-opencode.zh-CN.md`](./provider-scope-codex-claude-opencode.zh-CN.md).

## 4. Claude Coverage

Primary implementation files:

- `packages/runtime-daemon/src/claude-session-files.ts`
- `packages/runtime-daemon/src/claude-stored-history-adapter.ts`
- `packages/runtime-daemon/src/legacy-structured/claude-live-client.ts`
- `packages/runtime-daemon/src/legacy-structured/claude-structured-adapter.ts`

### Stored history

Claude stored history follows the mature hapi-style path:

- `.claude/projects/<project-id>/<session>.jsonl`
- internal event filtering
- resumed-history dedupe
- transcript noise filtering

Current filtering explicitly ignores:

- `file-history-snapshot`
- `change`
- `queue-operation`
- transcript noise such as `No response requested.`
- local command stdout wrappers

### Live

Claude live follows the paseo-style SDK route instead of raw CLI text parsing:

- `@anthropic-ai/claude-agent-sdk`
- minimal live session
- permission request / response bridge
- replay -> live upgrade
- read/write tool flow
- native rename against Claude stored session files
- mode catalog roles for `default` / `acceptEdits` / `bypassPermissions` / `plan`

### Known operational lessons

- Claude project/session discovery must tolerate project path aliasing such as `/var/...` vs
  `/private/var/...`.
- Claude permission handling should be treated as a first-class bridge concern, not an afterthought.

### Verification

- `claude-session-files.test.ts`
- `claude-adapter.test.ts`
- `test:smoke:claude-flow`
- `test:smoke:claude-browser`

## 6. Codex Lessons That Generalize

Codex remains the reference adapter, but some of the hardest-earned lessons are generic:

- persisted bootstrap/internal prompts must be filtered before they reach the main workbench feed
- live metadata such as session name/preview must be sanitized before being accepted as user-facing
  session titles
- replay -> live upgrade must never replay old turns into the visible timeline again
- browser smoke should validate event counts and visible state, not one historical sentence
- `StartSessionRequest.modeId` and `ResumeSessionRequest.modeId` must be interpreted by the
  adapter before the first user turn is sent; frontend-side conversion to provider-native startup
  args is not allowed.

## 7. When To Add A New Coverage Doc

Add a provider-specific coverage document when all of the following are true:

- the provider is a real adapter, not a placeholder
- it has both stored history and live semantics
- it has at least one provider-specific smoke or a non-trivial translator

Until then, this document is the shared maintenance surface for core provider history and live
behavior.
