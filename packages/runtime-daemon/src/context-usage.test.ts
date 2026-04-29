import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeContextUsage } from "./context-usage";
import { knownModelContextWindow } from "./model-context-window";

describe("normalizeContextUsage", () => {
  test("standardizes context-window usage", () => {
    assert.deepEqual(
      normalizeContextUsage({
        usedTokens: 40_000,
        contextWindow: 1_000_000,
      }),
      {
        usedTokens: 40_000,
        contextWindow: 1_000_000,
        percentUsed: 4,
        percentRemaining: 96,
        basis: "context_window",
        precision: "exact",
      },
    );
  });

  test("marks token-only usage as turn usage", () => {
    assert.deepEqual(normalizeContextUsage({ inputTokens: 42, outputTokens: 7 }), {
      inputTokens: 42,
      outputTokens: 7,
      basis: "turn",
      precision: "exact",
    });
  });

  test("preserves adapter-declared estimates", () => {
    assert.deepEqual(
      normalizeContextUsage({
        usedTokens: 10,
        contextWindow: 100,
        precision: "estimated",
        source: "test",
      }),
      {
        usedTokens: 10,
        contextWindow: 100,
        percentUsed: 10,
        percentRemaining: 90,
        basis: "context_window",
        precision: "estimated",
        source: "test",
      },
    );
  });
});

describe("knownModelContextWindow", () => {
  test("uses AionUi context windows as the estimation baseline", () => {
    assert.deepEqual(knownModelContextWindow({
      provider: "gemini",
      modelId: "gemini-2.5-flash-image",
    }), {
      contextWindow: 32_768,
      precision: "estimated",
      source: "gemini.aionui_model_context_window",
    });

    assert.deepEqual(knownModelContextWindow({
      provider: "claude",
      modelId: "claude-sonnet-4.5",
    }), {
      contextWindow: 1_000_000,
      precision: "estimated",
      source: "claude.aionui_model_context_window",
    });

    assert.deepEqual(knownModelContextWindow({
      provider: "custom",
      modelId: "gpt-5.1-chat",
    }), {
      contextWindow: 128_000,
      precision: "estimated",
      source: "custom.aionui_model_context_window",
    });
  });
});
