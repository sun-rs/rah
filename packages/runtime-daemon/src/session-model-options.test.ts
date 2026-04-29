import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import {
  optionValueAsString,
  resolveModelOptionValues,
  validateModelOptionValues,
} from "./session-model-options";

function catalog(): ProviderModelCatalog {
  return {
    provider: "codex",
    currentModelId: "gpt-a",
    models: [
      {
        id: "gpt-a",
        label: "GPT A",
        reasoningOptions: [
          { id: "low", label: "Low", kind: "reasoning_effort" },
          { id: "xhigh", label: "XHigh", kind: "reasoning_effort" },
        ],
        defaultReasoningId: "xhigh",
      },
    ],
    fetchedAt: "2026-04-29T00:00:00.000Z",
    source: "native",
    modelProfiles: [
      {
        modelId: "gpt-a",
        source: "native_online",
        freshness: "authoritative",
        configOptions: [
          {
            id: "model_reasoning_effort",
            label: "Reasoning effort",
            kind: "select",
            scope: "model",
            source: "native_online",
            mutable: true,
            applyTiming: "next_turn",
            defaultValue: "xhigh",
            options: [
              { id: "low", label: "Low" },
              { id: "xhigh", label: "XHigh" },
            ],
            availability: { modelIds: ["gpt-a"] },
            backendKey: "reasoning_effort",
          },
        ],
      },
    ],
  };
}

describe("session model option values", () => {
  test("accepts only options declared by the selected model profile", () => {
    assert.deepEqual(
      validateModelOptionValues({
        catalog: catalog(),
        modelId: "gpt-a",
        optionValues: { model_reasoning_effort: "low" },
      }),
      { model_reasoning_effort: "low" },
    );
    assert.throws(
      () =>
        validateModelOptionValues({
          catalog: catalog(),
          modelId: "gpt-a",
          optionValues: { effort: "low" },
        }),
      /Unsupported model option 'effort'/,
    );
  });

  test("maps legacy reasoningId to the matching model config option", () => {
    assert.deepEqual(
      resolveModelOptionValues({
        catalog: catalog(),
        model: catalog().models[0]!,
        reasoningId: "low",
      }),
      { model_reasoning_effort: "low" },
    );
  });

  test("rejects conflicting legacy reasoning and optionValues", () => {
    assert.throws(
      () =>
        resolveModelOptionValues({
          catalog: catalog(),
          model: catalog().models[0]!,
          optionValues: { model_reasoning_effort: "xhigh" },
          reasoningId: "low",
        }),
      /Conflicting values/,
    );
  });

  test("fills declared defaults only when requested", () => {
    assert.deepEqual(
      resolveModelOptionValues({
        catalog: catalog(),
        model: catalog().models[0]!,
        useDefaults: true,
      }),
      { model_reasoning_effort: "xhigh" },
    );
  });

  test("converts selected scalar values to legacy string form", () => {
    assert.equal(
      optionValueAsString({ model_reasoning_effort: "xhigh" }, "model_reasoning_effort"),
      "xhigh",
    );
    assert.equal(
      optionValueAsString({ model_reasoning_effort: null }, "model_reasoning_effort"),
      null,
    );
  });
});
