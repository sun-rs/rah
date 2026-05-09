import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import {
  councilAgentDraftToConfig,
  createDefaultCouncilAgentDrafts,
} from "./council-ui-state";

test("council defaults create two editable provider-backed agent drafts", () => {
  const drafts = createDefaultCouncilAgentDrafts();
  assert.deepEqual(drafts.map((draft) => draft.provider), ["codex", "claude"]);
  assert.equal(drafts[0]!.id, "codex-lead");
  assert.equal(drafts[1]!.id, "claude-reviewer");
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
      modeId: "opencode/full-auto",
    },
  });

  assert.deepEqual(config, {
    id: "opencode-specialist",
    provider: "opencode",
    label: "OpenCode Specialist",
    role: "Run API-key models",
    modelId: "openai/gpt-5.5",
    reasoningId: "xhigh",
    optionValues: { model_reasoning_variant: "xhigh" },
    modeId: "opencode/full-auto",
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
    defaultModeId: "opencode/full-auto",
    modes: [
      { id: "build", role: "ask", label: "Ask", applyTiming: "startup_only", hotSwitch: false },
      { id: "opencode/full-auto", role: "full_auto", label: "Full auto", applyTiming: "startup_only", hotSwitch: false },
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
      label: "OpenCode Specialist",
      role: "",
      modelId: null,
      reasoningId: null,
      modeId: null,
    },
  });

  assert.equal(config.modelId, "openai/gpt-5.5");
  assert.equal(config.reasoningId, "xhigh");
  assert.deepEqual(config.optionValues, { model_reasoning_variant: "xhigh" });
  assert.equal(config.modeId, "opencode/full-auto");
});
