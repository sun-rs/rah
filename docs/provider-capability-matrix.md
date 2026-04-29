# Provider Capability Matrix

Status: working reference

Date: 2026-04-27

This document records the capability-discovery and capability-application behavior that is already
implemented in real systems we can inspect locally:

- `AionUi`
- `Paseo`
- `Hapi`
- `RAH`

The goal is not to invent a clean abstraction first and then force providers into it.
The goal is to:

1. identify what each real system actually does
2. identify what is authoritative vs provisional
3. design RAH around that reality

This document should be treated as a prerequisite for any protocol or UI change related to:

- provider model lists
- provider modes
- thinking / effort / reasoning / variant controls
- capability caching
- session-start reconciliation
- adapter-owned mode/model/config semantics

## 1. Core Rule

RAH should not treat prelaunch capability data as final truth.

The authoritative source for a session is always the provider's runtime/session response after the
session is actually started or resumed.

Prelaunch capability data is only a best-effort view used for:

- new-session composer defaults
- model picker bootstrap
- mode picker bootstrap
- advanced config bootstrap

## 2. Authority Ladder

RAH should evaluate capability sources in this order:

1. `runtime_session`
2. `native_online`
3. `native_local`
4. `cached_runtime`
5. `static_builtin`

Definitions:

- `runtime_session`
  Provider session is already running and has returned active model / mode / option state.
- `native_online`
  Provider offers an online query surface, e.g. `model/list`.
- `native_local`
  Capability data is derived from local config or local schema files.
- `cached_runtime`
  Capability data is copied from a previously successful live session.
- `static_builtin`
  Capability data is maintained by the app itself.

Only `runtime_session` and `native_online` may be treated as authoritative model/option sets.

`native_local`, `cached_runtime`, and `static_builtin` are prelaunch inputs and may drift.

## 3. System Matrix

### 3.1 Claude

| System | Model list source | Mode source | Advanced config source | Authority |
|---|---|---|---|---|
| `AionUi` | `cc-switch` DB + `~/.claude/settings.json` slot | ACP session/runtime | ACP config/mode surfaces | prelaunch provisional, runtime authoritative |
| `Paseo` | static canonical catalog | daemon/provider-owned | static thinking IDs on model definitions | static contract |
| `Hapi` | no local model discovery found | wrapper/session state | explicit `--effort` and hub route `/sessions/:id/effort` | session state |
| `RAH` current target | local config for Claude slot + runtime reconciliation | runtime session mode | provider-defined config options | runtime authoritative |

Code references:

- `AionUi/src/process/services/ccSwitchModelSource.ts`
- `AionUi/src/process/agent/acp/utils.ts`
- `AionUi/src/process/agent/acp/index.ts`
- `paseo/packages 2/server/src/server/agent/providers/claude/claude-models.ts`
- `hapi/cli/src/commands/claude.ts`
- `hapi/hub/src/web/routes/sessions.ts`
- `claudecode-source/services/api/claude.ts`

Observed behavior:

- `AionUi` does not guess Claude models from the live session first. It derives the slot set
  from `cc-switch` and the selected local Claude slot from `~/.claude/settings.json`.
- `Paseo` uses a canonical static catalog of Claude models and attaches `thinkingOptions`
  directly to the model definitions.
- `Hapi` exposes Claude `effort` as an explicit session-level control.
- Claude Code itself is model-sensitive:
  some models support `effort`,
  some support adaptive thinking,
  some fall back to thinking budgets.

RAH consequence:

- RAH must not hard-code one universal "Claude advanced panel".
- RAH should treat local Claude config as `native_local`.
- The actual session response must be allowed to invalidate or refine prelaunch Claude options.
- Claude modes are exposed through `SessionModeDescriptor` with stable roles; the UI should not
  special-case `bypassPermissions` beyond submitting its opaque `modeId`.

### 3.2 Codex

| System | Model list source | Mode source | Advanced config source | Authority |
|---|---|---|---|---|
| `AionUi` | cached ACP/runtime model info | ACP runtime | config options / ACP model info | runtime authoritative, cached bootstrap |
| `Paseo` | provider models via daemon | daemon/provider-owned | thinking option IDs from model definitions | daemon contract |
| `Hapi` | explicit CLI/session config | session/wrapper | `--model-reasoning-effort`, persisted in hub | session state |
| `RAH` current | `model/list` native online | runtime mode state | model reasoning options from native catalog | native authoritative |

Code references:

- `AionUi/src/process/task/AcpAgentManager.ts`
- `AionUi/src/process/agent/acp/modelInfo.ts`
- `paseo/packages 2/cli/src/commands/provider/models.ts`
- `hapi/cli/src/commands/codex.ts`
- `hapi/cli/src/codex/utils/appServerConfig.ts`
- `rah/packages/runtime-daemon/src/codex-model-catalog.ts`

Observed behavior:

- Codex is the cleanest case: there is a real model catalog and real reasoning options.
- `reasoning_effort` is model-specific, not provider-global.
- A static fallback is useful, but runtime/native catalog is preferred.

RAH consequence:

- Codex remains the reference implementation for dynamic model capability ingestion.
- The protocol should preserve model-level reasoning options without assuming other providers work
  the same way.
- Codex mode ids encode `approvalPolicy/sandbox`, but only the Codex adapter should parse that
  encoding. The UI sees `role=ask/auto_edit/full_auto/plan`.

### 3.3 Gemini

| System | Model list source | Mode source | Advanced config source | Authority |
|---|---|---|---|---|
| `AionUi` | static Gemini mode/model list + cached ACP capabilities | ACP mode/runtime | cached config options / runtime | static bootstrap, runtime authoritative |
| `Paseo` | provider models via daemon | daemon/provider-owned | `thinking` option IDs | daemon contract |
| `Hapi` | no Gemini-specific reasoning route found | wrapper/session state | none found for Gemini-specific advanced config | session state |
| `RAH` current target | local Gemini schema/config metadata + runtime cache + static fallback | runtime mode state | provider-defined config options | runtime authoritative |

Code references:

- `AionUi/src/common/utils/geminiModes.ts`
- `AionUi/src/process/agent/acp/index.ts`
- `gemini-cli/docs/cli/generation-settings.md`
- `gemini-cli/schemas/settings.schema.json`
- `paseo/packages 2/cli/src/commands/agent/run.ts`

Observed behavior:

- Gemini CLI already encodes model-family-specific capability behavior in local schema/config.
- `gemini-2.5` aliases are associated with `thinkingBudget`.
- `gemini-3` aliases are associated with `thinkingLevel`.
- The CLI also maintains model feature metadata (`features.thinking`, family, tier, preview).

RAH consequence:

- RAH should not write provider UI rules like:
  "if model starts with gemini-2.5 show budget".
- RAH should parse Gemini local capability metadata when possible and downgrade to static fallback
  only if that parse is unavailable.
- Gemini history display must prefer native `displayContent` for user prompts. Expanded `content`
  may include full referenced file bodies and is not the user-visible prompt.

### 3.4 Kimi

| System | Model list source | Mode source | Advanced config source | Authority |
|---|---|---|---|---|
| `AionUi` | runtime first, cache after first connect | ACP/runtime | session/runtime | runtime authoritative |
| `Paseo` | no local evidence here | unknown | unknown | unknown |
| `Hapi` | no Kimi implementation in inspected paths | unknown | unknown | unknown |
| `RAH` current target | runtime + cached runtime | runtime mode state | provider-defined config option `thinking` | runtime authoritative |

Code references:

- `kimi-cli/src/kimi_cli/cli/__init__.py`
- `kimi-cli/src/kimi_cli/llm.py`
- `kimi-cli/src/kimi_cli/acp/server.py`

Observed behavior:

- Kimi exposes `--thinking/--no-thinking` at CLI level.
- ACP expands the model list with `,thinking` variants.
- Internally Kimi maps that to `with_thinking("high")` or `with_thinking("off")`.

RAH consequence:

- RAH must not leak Kimi's ACP-specific `model_id,thinking` encoding to the UI.
- RAH should normalize this into:
  - model = base model
  - config option `thinking = on/off`
- Kimi `default/yolo/plan` modes are adapter-owned; switching `default` and `yolo` may require an
  idle-only wire client restart.

### 3.5 OpenCode

| System | Model list source | Mode source | Advanced config source | Authority |
|---|---|---|---|---|
| `AionUi` | runtime/cached after first connect | runtime | runtime/cached | runtime authoritative |
| `Paseo` | provider models via daemon | daemon/provider-owned | provider-defined thinking IDs if exposed | daemon contract |
| `Hapi` | no OpenCode-specific advanced-config route found | wrapper/session state | none found | session state |
| `RAH` current target | runtime + cached runtime + config parse where possible | runtime mode state | provider-defined config option `variant` | runtime authoritative |

Code references:

- `opencode/github/action.yml`
- `opencode/packages/app/src/context/model-variant.ts`
- `opencode/packages/opencode/src/session/llm.ts`
- `opencode/packages/opencode/test/session/llm.test.ts`

Observed behavior:

- OpenCode uses `variant` as the user-visible abstraction.
- That variant is provider-specific and can map to reasoning-effort style options.
- The underlying wire shape is not guaranteed to match Claude or Codex naming.

RAH consequence:

- RAH should keep OpenCode `variant` as an option id, not re-label it into a fake universal
  `reasoning_effort`.
- OpenCode full auto is a RAH adapter overlay over OpenCode session permission rules. The UI should
  only submit `modeId=opencode/full-auto`.

## 4. Parameter Matrix

This table records what the real systems indicate each provider can express today.

| Provider | User-facing capability we should preserve | Backing shape seen in code | Recommended RAH option ids |
|---|---|---|---|
| Claude | effort, thinking mode, sometimes thinking budget, task budget | `effort`, adaptive/budget thinking, `task_budget` | `effort`, `thinking_mode`, `thinking_budget`, `task_budget` |
| Codex | model reasoning effort | `model_reasoning_effort` / `reasoning_effort` | `model_reasoning_effort` |
| Gemini | thinking budget or thinking level depending on model family | `thinkingConfig.thinkingBudget`, `thinkingConfig.thinkingLevel` | `thinking_budget`, `thinking_level`, `include_thoughts` |
| Kimi | thinking on/off | CLI bool + ACP `,thinking` expansion | `thinking` |
| OpenCode | variant | `variant` -> provider-specific override blob | `variant` |

Important:

- These are provider-owned option ids.
- They are not intended to be flattened into a fake universal reasoning abstraction.

## 5. RAH Design Constraints Derived From The Matrix

### 5.1 What must be dynamic

The following must be dynamic and adapter-owned:

- advanced config options
- model-specific availability of advanced options
- whether an option is mutable now, next turn, or restart-only

### 5.2 What may be static

Static builtins are acceptable only for:

- fallback model lists
- fallback labels
- bootstrap behavior when no live or local source exists

Static builtins are not acceptable as the long-term authoritative source for:

- dynamic option availability
- provider session-resolved model state
- provider session-resolved thinking or effort state

### 5.3 Prelaunch vs runtime truth

RAH must represent the difference explicitly:

- prelaunch catalog
- runtime resolved config

When a session starts and the provider returns different truth than the prelaunch draft:

- the runtime view wins
- the UI should be reconciled
- the event stream should record the change

## 6. Required RAH Capability Model

Any future RAH capability abstraction must support all of the following without adapter leakage:

1. provider-owned option ids
2. model-specific option availability
3. authoritative source labeling
4. prelaunch vs runtime reconciliation
5. fallback/static bootstrap without claiming final truth

If a proposed abstraction cannot represent:

- Claude adaptive thinking vs budget thinking
- Codex model reasoning effort
- Gemini 2.5 budget vs Gemini 3 level
- Kimi boolean thinking
- OpenCode variant

then the abstraction is too rigid.

## 7. Immediate RAH Work Items

1. Promote this matrix to the gating reference for capability-related changes.
2. Add a protocol draft for:
   - `ProviderCapabilityCatalog`
   - `SessionConfigOption`
   - `SessionResolvedConfig`
3. Mark source/freshness explicitly in the protocol.
4. Treat `cached_runtime` only as bootstrap data, never as session truth.
5. Implement adapter-specific capability probes in this order:
   - `runtime_session`
   - `native_online`
   - `native_local`
   - `cached_runtime`
   - `static_builtin`

## 8. Non-Goals

RAH should not try to:

- force all providers into one `reasoning_effort` field
- hide provider differences by inventing fake cross-provider semantics
- trust local config as authoritative session truth
- trust static builtins once runtime data is available

The correct design goal is:

`unified framework, provider-owned semantics, runtime reconciliation`
