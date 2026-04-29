# Provider Capability Protocol Draft

Status: implemented incrementally

Date: 2026-04-29

This document defines the first incremental protocol shape for provider capability handling in
RAH. It is intentionally migration-oriented:

- it preserves the current `ProviderModelCatalog` boundary
- it adds richer optional capability fields
- it allows adapters and UI to adopt the new shape gradually

This draft should be read together with:

- [Provider Capability Matrix](./provider-capability-matrix.md)
- [Protocol Freeze Status](./protocol-freeze-status.md)
- [Workbench Boundary](./workbench-boundary.md)

## 1. Design Goal

The design goal is not to flatten all providers into one fake reasoning model.

The design goal is:

- unified framework
- provider-owned semantics
- runtime reconciliation

## 2. Why Extend Instead of Replace

RAH already exposes:

- `ProviderModelCatalog`
- `ManagedSession.model`

These are in use by:

- runtime daemon
- client-web
- existing Codex reference implementation

So the first protocol step is:

1. keep those shapes valid
2. add richer optional capability metadata
3. let adapters adopt the richer shape when they are ready

This avoids a flag day rewrite across:

- runtime adapters
- session lifecycle
- client-web composer
- session control panels

## 3. New Core Concepts

### 3.1 Capability source

Capability source must distinguish:

- `runtime_session`
- `native_online`
- `native_local`
- `cached_runtime`
- `static_builtin`

This is more expressive than the old `native/static/fallback` source model.

### 3.2 Capability freshness

Capability freshness must distinguish:

- `authoritative`
- `provisional`
- `stale`

This tells the UI whether it should:

- trust the data
- warn the user
- expect reconciliation after session start

### 3.3 Provider-owned config options

Advanced model/session parameters are represented as dynamic provider-defined options, not as a
single global reasoning abstraction.

Examples:

- Claude
  - `effort`
  - `thinking_mode`
  - `thinking_budget`
  - `task_budget`
- Codex
  - `model_reasoning_effort`
- Gemini
  - `thinking_budget`
  - `thinking_level`
  - `include_thoughts`
- Kimi
  - `thinking`
- OpenCode
  - `variant`

## 4. Protocol Surfaces

## 4.1 Session-level additions

`ManagedSession` now allows these optional fields:

- `config`
- `modelProfile`

These should remain optional until providers actually emit them.

### `config`

This is the resolved session config state.

It answers:

- what values are currently applied
- where those values came from
- which revision of capability data produced them

### `modelProfile`

This is the active model's capability profile.

It answers:

- what this model actually supports
- which options belong to this model
- whether the profile is authoritative or provisional

## 4.2 Provider-level catalog additions

`ProviderModelCatalog` now accepts optional capability metadata:

- `sourceDetail`
- `freshness`
- `revision`
- `modelsExact`
- `optionsExact`
- `defaultModeId`
- `modes`
- `configOptions`
- `modelProfiles`

This means the existing `/api/providers/:provider/models` endpoint can evolve
without an immediate rename.

## 5. Field Meanings

## 5.1 `modelsExact`

`modelsExact = true` means:

- the adapter believes this is the real current model set
- missing models may be treated as true deletions

`modelsExact = false` means:

- this is a bootstrap or fallback set
- missing models cannot yet be treated as authoritative absence

## 5.2 `optionsExact`

`optionsExact = true` means:

- the adapter believes the current option set is complete and authoritative

`optionsExact = false` means:

- options may expand or shrink after live session start

## 5.3 `revision`

`revision` is a capability fingerprint.

Typical sources:

- schema hash
- config hash
- provider catalog ETag
- runtime capability snapshot hash

This lets RAH compare:

- what the user saw prelaunch
- what the session resolved at runtime

## 5.4 `defaultModeId` and `modes`

`defaultModeId` is the adapter-owned startup default for the provider.

`modes` is the adapter-owned mode catalog. Each `SessionModeDescriptor` may include:

- `id`: provider/adapter executable mode id
- `role`: RAH-stable UI semantics
- `label`
- `description`
- `applyTiming`: when a live switch can take effect
- `hotSwitch`

Allowed `role` values are:

- `ask`
- `auto_edit`
- `full_auto`
- `plan`
- `custom`

The UI must treat `id` as opaque. It may render stable labels from `role`, but must submit the
original `id` back to the daemon as `modeId`.

Allowed `applyTiming` values are:

- `immediate`
- `next_turn`
- `idle_only`
- `restart_required`
- `startup_only`

`hotSwitch` is the broad compatibility boolean. `applyTiming` is the precise semantic field. New
adapter code should set both; frontend behavior should prefer `applyTiming` when it needs to reason
about disabled states or explanatory copy.

This is the current replacement for frontend-side provider mode guessing. For example, the web app
does not decompose Codex mode ids into `approvalPolicy + sandbox`, and it does not write OpenCode
permission rules directly. It only sends `modeId`; the adapter owns the translation.

## 6. Reconciliation Model

Prelaunch capability data is not final truth.

The expected runtime flow is:

1. user sees prelaunch catalog
2. user selects model/mode/config
3. session starts with `model`, `reasoningId`, and `modeId`
4. provider returns runtime capability truth
5. runtime reconciles the draft against the live truth

Possible outcomes:

- exact match
- option dropped
- option defaulted
- model invalidated
- profile upgraded from provisional to authoritative

## 7. Intended Adapter Behavior

Adapters should gradually move toward this pipeline:

1. `runtime_session` probe
2. `native_online` probe
3. `native_local` probe
4. `cached_runtime` probe
5. `static_builtin` fallback

Each higher-priority probe may override lower-priority capability data.

## 8. Intended UI Behavior

The UI should:

- always show model selector from provider catalog
- always show mode selector from provider catalog or session mode state
- render mode labels from `SessionModeDescriptor.role` when present
- render advanced controls from dynamic `configOptions`
- display source/freshness when data is provisional

The UI should not hardcode provider logic such as:

- "Gemini 2.5 always shows budget"
- "Claude always shows effort"
- "Codex full auto means this exact approval/sandbox tuple"
- "OpenCode full auto means this exact permission ruleset"

Those decisions belong to adapter-produced capability profiles.

## 9. Migration Plan

### Phase 1

- extend protocol types
- add contract validation
- keep existing API names

### Phase 2

- add adapter-level capability probes
- populate richer `ProviderModelCatalog` fields

### Phase 3

- add session-level `config` and `modelProfile`
- emit reconciliation events when runtime truth differs from prelaunch draft

### Phase 4

- optionally introduce a dedicated provider capability endpoint if the old
  `ProviderModelCatalog` shape becomes too constrained

## 10. Non-Goals

This draft does not yet define:

- final event payloads for capability update/reconciliation
- exact UI component layout
- provider-specific reconciliation copy
- a universal cross-provider reasoning semantic

Those should come after adapter adoption proves the fields are sufficient.
