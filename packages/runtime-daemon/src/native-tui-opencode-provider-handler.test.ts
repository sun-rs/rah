import assert from "node:assert/strict";
import test from "node:test";
import type { StoredSessionCatalogRecord } from "./stored-session-catalog-types";
import { NativeTuiHistoryCatalogIndex } from "./native-tui-history-catalog";
import { createOpenCodeNativeTuiProviderHandler } from "./native-tui-opencode-provider-handler";

function openCodeRecord(
  providerSessionId: string,
  options: {
    cwd: string;
    createdAt?: string;
    updatedAt?: string;
  },
): StoredSessionCatalogRecord {
  return {
    ref: {
      provider: "opencode",
      providerSessionId,
      cwd: options.cwd,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      ...(options.updatedAt ? { updatedAt: options.updatedAt } : {}),
      title: providerSessionId,
      source: "provider_history",
    },
    storagePath: `/history/${providerSessionId}.sqlite`,
  };
}

test("OpenCode start binding uses creation time instead of a recently updated old session", () => {
  const cwd = "/workspace/project";
  const startupTimestampMs = Date.parse("2026-08-13T10:00:00.000Z");
  const oldSession = openCodeRecord("old-session", {
    cwd,
    createdAt: "2026-08-12T10:00:00.000Z",
    // The old session may receive output while a new process is starting. Its
    // updatedAt is therefore deliberately newer than the true new session.
    updatedAt: "2026-08-13T10:00:02.000Z",
  });
  const newSession = openCodeRecord("new-session", {
    cwd,
    createdAt: "2026-08-13T10:00:00.100Z",
    updatedAt: "2026-08-13T10:00:00.100Z",
  });
  const catalog = new NativeTuiHistoryCatalogIndex({
    refresh: () => undefined,
  });
  catalog.replaceProvider("opencode", [oldSession, newSession]);

  const handler = createOpenCodeNativeTuiProviderHandler(catalog);
  const candidate = handler.probeBinding?.({
    sessionId: "rah-session",
    provider: "opencode",
    cwd,
    startupTimestampMs,
  });

  assert.equal(candidate?.providerSessionId, "new-session");
  assert.equal(candidate?.authority, "history_probe");
});

test("OpenCode binding excludes a heuristic identity already rejected by ownership", () => {
  const cwd = "/workspace/project";
  const startupTimestampMs = Date.parse("2026-08-13T10:00:00.000Z");
  let refreshes = 0;
  const catalog = new NativeTuiHistoryCatalogIndex({
    refreshCooldownMs: 0,
    refresh: () => {
      refreshes += 1;
    },
  });
  catalog.replaceProvider("opencode", [
    openCodeRecord("already-owned", {
      cwd,
      createdAt: "2026-08-13T10:00:00.100Z",
      updatedAt: "2026-08-13T10:00:00.100Z",
    }),
  ]);

  const handler = createOpenCodeNativeTuiProviderHandler(catalog);
  const candidate = handler.probeBinding?.({
    sessionId: "rah-session",
    provider: "opencode",
    cwd,
    startupTimestampMs,
    excludedProviderSessionIds: ["already-owned"],
  });

  assert.equal(candidate, null);
  // Refresh is asynchronous by design; the important contract here is that
  // the rejected identity cannot be selected again on the next probe.
  assert.equal(refreshes, 0);
});
