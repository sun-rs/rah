import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import { CodexModelCatalogCache } from "./codex-model-catalog";

function staleCatalog(): ProviderModelCatalog {
  return {
    provider: "codex",
    models: [],
    fetchedAt: "2000-01-01T00:00:00.000Z",
    source: "native",
    sourceDetail: "native_online",
    freshness: "authoritative",
    modelsExact: true,
    optionsExact: true,
  };
}

describe("Codex model catalog cache", () => {
  test("releases a failed client-creation flight so a later refresh can retry", async () => {
    let attempts = 0;
    const cache = new CodexModelCatalogCache(async () => {
      attempts += 1;
      throw new Error(`client unavailable ${attempts}`);
    });
    const cached = cache.remember(staleCatalog());

    assert.equal(await cache.listModels(), cached);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      cache.listModels({ forceRefresh: true }),
      /client unavailable 2/,
    );
    assert.equal(attempts, 2);
  });
});
