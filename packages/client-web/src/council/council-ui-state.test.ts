import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import {
  councilAgentDraftToConfig,
  createDefaultCouncilAgentDrafts,
  normalizeCouncilAgentDraftForCatalog,
  resolveCouncilAgentModelSelection,
} from "./council-ui-state";

test("council defaults create two editable provider-backed agent drafts", () => {
  const drafts = createDefaultCouncilAgentDrafts();
  assert.deepEqual(drafts.map((draft) => draft.provider), ["codex", "claude"]);
  assert.equal(drafts[0]!.id, "draft-1");
  assert.equal(drafts[1]!.id, "draft-2");
  assert.deepEqual(drafts.map((draft) => draft.label), ["", ""]);
  assert.deepEqual(drafts.map((draft) => draft.role), ["", ""]);
});

test("council agent draft maps model reasoning into provider optionValues", () => {
  const catalog: ProviderModelCatalog = {
    provider: "opencode",
    models: [
      {
        id: "openai/gpt-5.5",
        label: "GPT 5.5",
        reasoningOptions: [
          { id: "default", label: "Default", kind: "model_variant" },
          { id: "xhigh", label: "XHigh", kind: "reasoning_effort" },
        ],
      },
    ],
    fetchedAt: new Date().toISOString(),
    source: "native",
    sourceDetail: "native_online",
    freshness: "authoritative",
    modelsExact: true,
    optionsExact: true,
    modelProfiles: [
      {
        modelId: "openai/gpt-5.5",
        source: "native_online",
        freshness: "authoritative",
        traits: { supportsEffort: true },
        configOptions: [
          {
            id: "model_reasoning_variant",
            label: "Variant",
            kind: "select",
            scope: "model",
            source: "native_online",
            mutable: true,
            applyTiming: "startup_only",
            options: [
              { id: "default", label: "Default" },
              { id: "xhigh", label: "XHigh" },
            ],
          },
        ],
      },
    ],
  };

  const config = councilAgentDraftToConfig({
    catalog,
    draft: {
      id: "opencode-specialist",
      provider: "opencode",
      label: "OpenCode Specialist",
      role: "Run API-key models",
      modelId: "openai/gpt-5.5",
      reasoningId: "xhigh",
      modeId: "build",
    },
  });

  assert.deepEqual(config, {
    id: "OpenCode Specialist",
    provider: "opencode",
    label: "OpenCode Specialist",
    role: "Run API-key models",
    modelId: "openai/gpt-5.5",
    reasoningId: "xhigh",
    optionValues: { model_reasoning_variant: "xhigh" },
    modeId: "build",
  });
});

test("council agent config uses visible catalog defaults when draft has not been edited", () => {
  const catalog: ProviderModelCatalog = {
    provider: "opencode",
    models: [
      {
        id: "openai/gpt-5.5",
        label: "GPT 5.5",
        reasoningOptions: [
          { id: "default", label: "Default", kind: "model_variant" },
          { id: "xhigh", label: "XHigh", kind: "reasoning_effort" },
        ],
      },
    ],
    fetchedAt: new Date().toISOString(),
    source: "native",
    sourceDetail: "native_online",
    freshness: "authoritative",
    modelsExact: true,
    optionsExact: true,
    defaultModeId: "build",
    modes: [
      { id: "build", role: "custom", label: "Build", applyTiming: "next_turn", hotSwitch: true },
      { id: "plan", role: "custom", label: "Plan", applyTiming: "next_turn", hotSwitch: true },
    ],
    modelProfiles: [
      {
        modelId: "openai/gpt-5.5",
        source: "native_online",
        freshness: "authoritative",
        traits: { supportsEffort: true },
        configOptions: [
          {
            id: "model_reasoning_variant",
            label: "Variant",
            kind: "select",
            scope: "model",
            source: "native_online",
            mutable: true,
            applyTiming: "startup_only",
            options: [
              { id: "default", label: "Default" },
              { id: "xhigh", label: "XHigh" },
            ],
          },
        ],
      },
    ],
  };

  const config = councilAgentDraftToConfig({
    catalog,
    draft: {
      id: "opencode-specialist",
      provider: "opencode",
      label: "",
      role: "",
      modelId: null,
      reasoningId: null,
      modeId: null,
    },
  });

  assert.equal(config.label, "GPT 5.5-XHigh");
  assert.equal(config.modelId, "openai/gpt-5.5");
  assert.equal(config.reasoningId, "xhigh");
  assert.deepEqual(config.optionValues, { model_reasoning_variant: "xhigh" });
  assert.equal(config.modeId, "build");
});

test("council model selection clears stale reasoning when selected model has no parameters", () => {
  const catalog: ProviderModelCatalog = {
    provider: "opencode",
    models: [
      {
        id: "kimi/kimi-for-coding",
        label: "Kimi for Coding",
      },
      {
        id: "openai/gpt-5.5",
        label: "GPT 5.5",
        reasoningOptions: [
          { id: "medium", label: "Medium", kind: "reasoning_effort" },
          { id: "xhigh", label: "XHigh", kind: "reasoning_effort" },
        ],
      },
    ],
    fetchedAt: new Date().toISOString(),
    source: "native",
    modelsExact: true,
    optionsExact: true,
  };

  const draft = {
    id: "opencode-specialist",
    provider: "opencode" as const,
    label: "OpenCode Specialist",
    role: "",
    modelId: "kimi/kimi-for-coding",
    reasoningId: "xhigh",
    modeId: null,
  };

  const selection = resolveCouncilAgentModelSelection({ draft, catalog });
  assert.equal(selection.modelId, "kimi/kimi-for-coding");
  assert.equal(selection.reasoningId, null);
  assert.deepEqual(selection.reasoningOptions, []);

  const normalized = normalizeCouncilAgentDraftForCatalog({ draft, catalog });
  assert.equal(normalized.modelId, "kimi/kimi-for-coding");
  assert.equal(normalized.reasoningId, null);

  const config = councilAgentDraftToConfig({ draft, catalog });
  assert.equal(config.modelId, "kimi/kimi-for-coding");
  assert.equal(config.reasoningId, undefined);
  assert.equal(config.optionValues, undefined);
});
