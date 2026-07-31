import assert from "node:assert/strict";
import test from "node:test";
import type { StoredSessionCatalogRecord } from "./stored-session-catalog-types";
import { NativeTuiHistoryCatalogIndex } from "./native-tui-history-catalog";

function record(
  provider: "codex" | "claude" | "opencode",
  providerSessionId: string,
): StoredSessionCatalogRecord {
  return {
    ref: {
      provider,
      providerSessionId,
      title: providerSessionId,
      source: "provider_history",
    },
    storagePath: `/history/${providerSessionId}`,
  };
}

test("native TUI history lookups stay in memory and replace one provider atomically", () => {
  const index = new NativeTuiHistoryCatalogIndex({ refresh: () => undefined });
  index.replace([
    record("codex", "codex-one"),
    record("claude", "claude-one"),
  ]);

  assert.equal(index.find("codex", "codex-one")?.storagePath, "/history/codex-one");
  assert.deepEqual(
    index.list("claude").map((entry) => entry.ref.providerSessionId),
    ["claude-one"],
  );

  index.replaceProvider("codex", [record("codex", "codex-two")]);
  assert.equal(index.find("codex", "codex-one"), undefined);
  assert.equal(index.find("codex", "codex-two")?.storagePath, "/history/codex-two");
  assert.equal(index.find("claude", "claude-one")?.storagePath, "/history/claude-one");
});

test("missing-record refreshes are single-flight and cooldown bounded", async () => {
  let now = 10_000;
  let refreshes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const index = new NativeTuiHistoryCatalogIndex({
    now: () => now,
    refreshCooldownMs: 2_000,
    refresh: async () => {
      refreshes += 1;
      await gate;
    },
  });

  index.requestRefresh("codex");
  index.requestRefresh("codex");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);

  release();
  await gate;
  await new Promise((resolve) => setImmediate(resolve));
  index.requestRefresh("codex");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);

  now += 2_001;
  index.requestRefresh("codex");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 2);
});

test("targeted native TUI resolution is single-flight and upserts the result", async () => {
  let resolutions = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resolvedRecord = record("codex", "codex-live");
  const index = new NativeTuiHistoryCatalogIndex({
    refresh: () => undefined,
    resolve: async () => {
      resolutions += 1;
      await gate;
      return resolvedRecord;
    },
  });
  const context = {
    cwd: "/workspace",
    startupTimestampMs: 1_000,
  };

  const first = index.resolve("codex", "codex-live", context);
  const second = index.resolve("codex", "codex-live", context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolutions, 1);

  release();
  assert.equal(await first, resolvedRecord);
  assert.equal(await second, resolvedRecord);
  assert.equal(index.find("codex", "codex-live"), resolvedRecord);
  assert.equal(await index.resolve("codex", "codex-live", context), resolvedRecord);
  assert.equal(resolutions, 1);
});

test("missing targeted resolutions are retry bounded and fall back to reconciliation", async () => {
  let now = 10_000;
  let resolutions = 0;
  let refreshes = 0;
  const index = new NativeTuiHistoryCatalogIndex({
    now: () => now,
    resolveCooldownMs: 250,
    refreshCooldownMs: 0,
    refresh: () => {
      refreshes += 1;
    },
    resolve: async () => {
      resolutions += 1;
      return undefined;
    },
  });
  const context = {
    cwd: "/workspace",
    startupTimestampMs: 1_000,
  };

  assert.equal(await index.resolve("codex", "codex-missing", context), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await index.resolve("codex", "codex-missing", context), undefined);
  assert.equal(resolutions, 1);
  assert.equal(refreshes, 1);

  now += 251;
  assert.equal(await index.resolve("codex", "codex-missing", context), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolutions, 2);
  assert.equal(refreshes, 2);
});
