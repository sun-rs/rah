import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import { ManualProviderModelStore, mergeManualProviderModels } from "./manual-provider-models";

async function tempStore(): Promise<ManualProviderModelStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rah-manual-models-"));
  return new ManualProviderModelStore(root);
}

function codexCatalog(): ProviderModelCatalog {
  return {
    provider: "codex",
    models: [{ id: "gpt-5.5", label: "GPT 5.5" }],
    fetchedAt: new Date().toISOString(),
    source: "native",
    sourceDetail: "native_online",
    freshness: "authoritative",
    modelsExact: true,
    optionsExact: true,
    modelProfiles: [
      {
        modelId: "gpt-5.5",
        source: "native_online",
        freshness: "authoritative",
        configOptions: [],
      },
    ],
  };
}

test("manual models supplement provider catalogs with fixed provider option keys", async () => {
  const store = await tempStore();
  await store.add("codex", {
    id: "gpt-5.6",
    label: "GPT 5.6",
    optionIds: ["high", "low", "high"],
  });

  const merged = mergeManualProviderModels(codexCatalog(), store);
  const manualModel = merged.models.find((model) => model.id === "gpt-5.6");
  const manualProfile = merged.modelProfiles?.find((profile) => profile.modelId === "gpt-5.6");

  assert.equal(merged.modelsExact, false);
  assert.equal(merged.optionsExact, false);
  assert.deepEqual(manualModel?.reasoningOptions?.map((option) => option.id), ["low", "high"]);
  assert.equal(manualModel?.defaultReasoningId, "high");
  assert.equal(manualProfile?.source, "cached_runtime");
  assert.equal(manualProfile?.configOptions[0]?.id, "model_reasoning_effort");
  assert.equal(manualProfile?.configOptions[0]?.backendKey, "reasoning_effort");
});

test("native models shadow manual supplements with the same id", async () => {
  const store = await tempStore();
  await store.add("gemini", { id: "gemma-4-31b-it" });
  const nativeCatalog: ProviderModelCatalog = {
    provider: "gemini",
    models: [{ id: "gemma-4-31b-it", label: "Gemma native" }],
    fetchedAt: new Date().toISOString(),
    source: "native",
    sourceDetail: "native_online",
    freshness: "authoritative",
    modelsExact: true,
    optionsExact: true,
    modelProfiles: [
      {
        modelId: "gemma-4-31b-it",
        source: "native_online",
        freshness: "authoritative",
        configOptions: [],
      },
    ],
  };

  const merged = mergeManualProviderModels(nativeCatalog, store);

  assert.equal(merged.models.filter((model) => model.id === "gemma-4-31b-it").length, 1);
  assert.equal(merged.models[0]?.label, "Gemma native");
  assert.equal(merged.modelProfiles?.[0]?.source, "native_online");
  assert.equal(merged.modelsExact, true);
});

test("manual model ids are unique per provider", async () => {
  const store = await tempStore();
  await store.add("opencode", { id: "openai/gpt-5.6", optionIds: ["default"] });

  await assert.rejects(
    () => store.add("opencode", { id: "openai/gpt-5.6" }),
    /already exists/,
  );
});

test("manual model options can be removed without deleting the model", async () => {
  const store = await tempStore();
  await store.add("codex", { id: "gpt-5.6", optionIds: ["low", "high"] });

  const updated = await store.removeOption("codex", "gpt-5.6", "high");
  const merged = mergeManualProviderModels(codexCatalog(), store);
  const manualModel = merged.models.find((model) => model.id === "gpt-5.6");

  assert.deepEqual(updated.optionIds, ["low"]);
  assert.deepEqual(manualModel?.reasoningOptions?.map((option) => option.id), ["low"]);
  assert.equal(manualModel?.defaultReasoningId, "low");
});

test("removing the last manual model option keeps the model selectable", async () => {
  const store = await tempStore();
  await store.add("opencode", { id: "openai/gpt-5.6", optionIds: ["default"] });

  const updated = await store.removeOption("opencode", "openai/gpt-5.6", "default");
  const merged = mergeManualProviderModels(
    {
      provider: "opencode",
      models: [],
      fetchedAt: new Date().toISOString(),
      source: "native",
      modelsExact: true,
      optionsExact: true,
    },
    store,
  );

  assert.equal(updated.id, "openai/gpt-5.6");
  assert.equal(updated.optionIds, undefined);
  assert.equal(merged.models.find((model) => model.id === "openai/gpt-5.6")?.reasoningOptions, undefined);
});
